package http

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"golang.org/x/time/rate"

	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// --- contract shapes (decoded from data_api JSONB) ---

type allowedColumn struct {
	Src       string `json:"src"`
	ExposedAs string `json:"exposed_as"`
}
type allowedFilter struct {
	Column   string   `json:"column"` // src column
	Ops      []string `json:"ops"`
	Required bool     `json:"required"`
	Default  any      `json:"default"`
}
type pagination struct {
	DefaultSize int `json:"default_size"`
	MaxSize     int `json:"max_size"`
}

// APIRateLimiter is a per-(api,caller) token-bucket limiter for Data APIs.
type APIRateLimiter struct {
	mu  sync.Mutex
	lim map[string]*rate.Limiter
}

// NewAPIRateLimiter builds an empty limiter registry.
func NewAPIRateLimiter() *APIRateLimiter { return &APIRateLimiter{lim: map[string]*rate.Limiter{}} }

// allow reports whether a request for key is within rpm (0 = unlimited).
func (l *APIRateLimiter) allow(key string, rpm int) bool {
	if rpm <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	lm, ok := l.lim[key]
	if !ok {
		lm = rate.NewLimiter(rate.Limit(float64(rpm)/60.0), rpm) // burst = rpm
		l.lim[key] = lm
	}
	return lm.Allow()
}

// DataAPIServe — GET/POST /data-api/v1/{name}. External, contract-bound endpoint.
// Flow (§15.3): resolve → auth gate → rate limit → contract→spec → gateway+mask
// → audit → JSON. The published contract + L6 masking is the data boundary.
func (h *Handlers) DataAPIServe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")

	api, err := h.Store.GetPublishedDataAPIByName(ctx, name)
	if err != nil {
		writeError(w, http.StatusNotFound, "data api not found")
		return
	}

	// 1. Auth gate by mode.
	caller, ok := h.dataAPIAuth(ctx, r, api)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// 2. Rate limit (per api + caller).
	if api.RateLimitRPM != nil && h.APILimiter != nil {
		if !h.APILimiter.allow(api.APIID+"|"+caller, *api.RateLimitRPM) {
			writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}
	}

	// 3. Build a contract-constrained spec.
	spec, exposeMap, err := buildContractSpec(api, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// 4. Compile + execute through the gateway (whitelist re-validated; masking applies).
	sql, err := h.compileBuildSpec(ctx, spec)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	resp, err := h.runQueryCtx(ctx, sql, spec.Dataset, nil, "data-api:"+caller, "trino")
	if err != nil {
		h.Log.Error("data api query", "name", name, "err", err.Error())
		writeError(w, http.StatusBadGateway, "query failed")
		return
	}

	// 5. Audit (reuses acl_audit with api/caller).
	_ = h.Store.WriteAPIAudit(ctx, api.APIID, caller, sql, resp.RewrittenSQL, resp.Engine)

	// 6. Remap src column keys → exposed_as and return.
	rows := make([]map[string]any, 0, len(resp.Result.Rows))
	for _, row := range resp.Result.Rows {
		out := map[string]any{}
		for src, exp := range exposeMap {
			out[exp] = row[src]
		}
		rows = append(rows, out)
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows, "count": len(rows)})
}

// dataAPIAuth applies the endpoint's auth_mode and returns the caller identity.
func (h *Handlers) dataAPIAuth(ctx context.Context, r *http.Request, api pg.DataAPI) (string, bool) {
	switch strings.ToLower(api.AuthMode) {
	case "none", "":
		return "anonymous", true
	case "apikey":
		key := r.Header.Get("X-API-Key")
		if key == "" {
			return "", false
		}
		sum := sha256.Sum256([]byte(key))
		ok, _ := h.Store.MatchAPIKey(ctx, api.APIID, hex.EncodeToString(sum[:]))
		if !ok {
			return "", false
		}
		return "key:" + safePrefix(key), true
	case "oauth", "jwt":
		if h.Verifier == nil {
			return "", false
		}
		tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		claims, err := h.Verifier.Verify(ctx, tok)
		if err != nil {
			return "", false
		}
		return subjectRef(claims), true
	default:
		return "", false
	}
}

// buildContractSpec turns external query params into a whitelist-bound BuildSpec
// and a src→exposed_as projection map. Only allowed columns are projected and
// only allowed filters/ops are accepted; required filters must be present.
func buildContractSpec(api pg.DataAPI, r *http.Request) (dto.BuildSpec, map[string]string, error) {
	var cols []allowedColumn
	_ = json.Unmarshal(rawOrBytes(api.AllowedColumns, "[]"), &cols)
	var filters []allowedFilter
	_ = json.Unmarshal(rawOrBytes(api.AllowedFilters, "[]"), &filters)

	cat, schema, table := parseSourceRef(api.SourceRef)
	spec := dto.BuildSpec{Dataset: dto.TargetRef{Catalog: cat, Schema: schema, Table: table}}

	exposeMap := map[string]string{}
	for _, c := range cols {
		exp := c.ExposedAs
		if exp == "" {
			exp = c.Src
		}
		spec.Dimensions = append(spec.Dimensions, c.Src)
		exposeMap[c.Src] = exp
	}
	if len(spec.Dimensions) == 0 {
		return spec, nil, fmt.Errorf("api has no exposed columns")
	}

	q := r.URL.Query()
	for _, f := range filters {
		// External param name is the exposed alias if defined, else the src column.
		paramName := f.Column
		for src, exp := range exposeMap {
			if src == f.Column {
				paramName = exp
				break
			}
		}
		raw := q.Get(paramName)
		if raw == "" {
			if f.Required {
				return spec, nil, fmt.Errorf("missing required filter %q", paramName)
			}
			continue
		}
		op := "="
		if len(f.Ops) > 0 {
			op = f.Ops[0]
		}
		var val any = raw
		if strings.EqualFold(op, "in") {
			val = splitCSV(raw)
		}
		spec.Filters = append(spec.Filters, dto.Filter{Col: f.Column, Op: op, Value: val})
	}

	// Pagination / limit.
	var pg pagination
	_ = json.Unmarshal(rawOrBytes(api.Pagination, "null"), &pg)
	limit := pg.DefaultSize
	if limit <= 0 {
		limit = 100
	}
	if l := q.Get("_limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if pg.MaxSize > 0 && limit > pg.MaxSize {
		limit = pg.MaxSize
	}
	spec.Limit = limit
	return spec, exposeMap, nil
}

func parseSourceRef(ref string) (catalog, schema, table string) {
	parts := strings.Split(ref, ".")
	switch len(parts) {
	case 3:
		return parts[0], parts[1], parts[2]
	case 2:
		return "iceberg", parts[0], parts[1]
	default:
		return "iceberg", "", ref
	}
}

func splitCSV(s string) []any {
	out := []any{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func rawOrBytes(j json.RawMessage, def string) []byte {
	if len(j) == 0 {
		return []byte(def)
	}
	return []byte(j)
}

func safePrefix(key string) string {
	if len(key) > 12 {
		return key[:12]
	}
	return key
}
