package http

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
)

// Datasets — GET /api/datasets. Self-service analytics datasets span all three
// Iceberg lakehouse layers (bronze/silver/gold_qms). Internal ETL bookkeeping
// tables (names starting with '_') are filtered out.
func (h *Handlers) Datasets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := []adapter.TableMeta{}
	var lastErr error
	for _, ns := range []string{"gold_qms", "silver_qms", "bronze_qms"} {
		tables, err := h.Adapters.Catalog.ListTables(ctx, ns)
		if err != nil {
			lastErr = err
			h.Log.Warn("datasets list", "ns", ns, "err", err.Error())
			continue
		}
		for _, t := range tables {
			if strings.HasPrefix(t.Name, "_") {
				continue // _etl_watermarks etc.
			}
			out = append(out, t)
		}
	}
	if len(out) == 0 && lastErr != nil {
		writeError(w, http.StatusBadGateway, "catalog unavailable")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CatalogSearch — GET /api/catalog/search?q=. Proxies DataHub search (§11);
// DataHub is the single catalog source (§13.1).
func (h *Handlers) CatalogSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	assets, err := h.Adapters.Metadata.Search(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusBadGateway, "datahub unavailable")
		return
	}
	if assets == nil {
		assets = []adapter.Asset{}
	}
	// Fill quality from the live-completeness cache; compute misses in the
	// background so the list returns fast and gets real scores on next load.
	if h.Quality != nil {
		for i := range assets {
			urn := assets[i].URN
			if sc, ok := h.Quality.Get(urn); ok {
				assets[i].Score = sc
			} else {
				h.Quality.Ensure(urn, func(ctx context.Context) (int, error) {
					return h.computeCompleteness(ctx, urn)
				})
			}
		}
	}
	writeJSON(w, http.StatusOK, assets)
}

// CatalogLineage — GET /api/catalog/lineage?urn=. Proxies DataHub lineage (§11).
func (h *Handlers) CatalogLineage(w http.ResponseWriter, r *http.Request) {
	urn := r.URL.Query().Get("urn")
	g, err := h.Adapters.Metadata.GetLineage(r.Context(), urn)
	if err != nil {
		writeError(w, http.StatusBadGateway, "datahub unavailable")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// CatalogFacets — GET /api/catalog/facets?q=. Aggregated catalog facets for the
// Governance catalog sidebar (domain/layer/sensitivity/owner).
func (h *Handlers) CatalogFacets(w http.ResponseWriter, r *http.Request) {
	facets, err := h.Adapters.Metadata.Facets(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		h.Log.Error("catalog facets", "err", err.Error())
		writeError(w, http.StatusBadGateway, "datahub unavailable")
		return
	}
	if facets == nil {
		facets = []adapter.Facet{}
	}
	writeJSON(w, http.StatusOK, facets)
}

// parseDatasetURN extracts platform, namespace and table from a DataHub dataset
// urn: urn:li:dataset:(urn:li:dataPlatform:<platform>,<path>,<env>). The path's
// last two dotted segments are the namespace and table.
func parseDatasetURN(urn string) (platform, ns, table string) {
	const pk = "dataPlatform:"
	i := strings.Index(urn, pk)
	if i < 0 {
		return
	}
	rest := urn[i+len(pk):]
	j := strings.Index(rest, ",")
	if j < 0 {
		return
	}
	platform = rest[:j]
	rest = rest[j+1:]
	k := strings.LastIndex(rest, ",")
	if k < 0 {
		return
	}
	parts := strings.Split(rest[:k], ".")
	if len(parts) >= 2 {
		ns = parts[len(parts)-2]
		table = parts[len(parts)-1]
	} else if len(parts) == 1 {
		table = parts[0]
	}
	return
}

// trinoCatalog maps a DataHub platform to the Trino catalog that can query it.
func trinoCatalog(platform string) string {
	switch strings.ToLower(platform) {
	case "iceberg":
		return "iceberg"
	case "clickhouse":
		return "clickhouse"
	case "postgres", "postgresql":
		return "postgresql"
	default:
		return ""
	}
}

// CatalogAsset — GET /api/catalog/asset?urn=. Returns, for the Governance asset
// detail: the column schema (DataHub schemaMetadata, all platforms), a live
// sample (Trino routed by platform), downstream count (DataHub lineage) and
// usage-over-time (acl_audit query trail). Everything is real; nothing seeded.
func (h *Handlers) CatalogAsset(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	urn := r.URL.Query().Get("urn")
	if urn == "" {
		writeError(w, http.StatusBadRequest, "urn is required")
		return
	}
	platform, ns, table := parseDatasetURN(urn)
	resp := map[string]any{"urn": urn, "platform": platform, "ns": ns, "table": table}

	// Schema from Trino information_schema — same engine as the sample, so it is
	// always consistent and doesn't depend on whether DataHub ingested this table.
	// DataHub schemaMetadata is then used only to enrich column descriptions.
	var cols []adapter.ColumnMeta
	if cat := trinoCatalog(platform); cat != "" && ns != "" && table != "" {
		descSQL := fmt.Sprintf(`SELECT column_name, data_type FROM %s.information_schema.columns
			WHERE table_schema = '%s' AND table_name = '%s' ORDER BY ordinal_position`, cat, ns, table)
		if rs, e := h.Adapters.Trino.Execute(ctx, descSQL); e != nil {
			h.Log.Warn("asset schema (trino)", "sql", descSQL, "err", e.Error())
		} else {
			for _, row := range rs.Rows {
				cols = append(cols, adapter.ColumnMeta{Name: asString(row["column_name"]), Type: asString(row["data_type"])})
			}
		}
	}
	// Enrich descriptions (and fall back entirely) from DataHub if available.
	if dh, e := h.Adapters.Metadata.GetDatasetSchema(ctx, urn); e == nil && len(dh) > 0 {
		desc := map[string]string{}
		for _, c := range dh {
			desc[c.Name] = c.Desc
		}
		for i := range cols {
			if d := desc[cols[i].Name]; d != "" {
				cols[i].Desc = d
			}
		}
		if len(cols) == 0 {
			cols = dh
		}
	}
	if cols == nil {
		cols = []adapter.ColumnMeta{}
	}
	resp["schema"] = adapter.Schema{Columns: cols}

	// Live sample via Trino, routed by the dataset's platform.
	resp["sample"] = adapter.ResultSet{Columns: []adapter.Column{}, Rows: []map[string]any{}}
	if cat := trinoCatalog(platform); cat != "" && ns != "" && table != "" {
		sql := fmt.Sprintf(`SELECT * FROM %s."%s"."%s" LIMIT 20`, cat, ns, table)
		if rs, e := h.Adapters.Trino.Execute(ctx, sql); e != nil {
			h.Log.Warn("asset sample", "sql", sql, "err", e.Error())
		} else {
			resp["sample"] = rs
		}
	}

	// Quality = live completeness (average non-null rate, sampled scan). Warms the
	// shared cache so the catalog list shows the same real score.
	if cat := trinoCatalog(platform); cat != "" && ns != "" && table != "" && len(cols) > 0 {
		names := make([]string, len(cols))
		for i, c := range cols {
			names[i] = c.Name
		}
		if sc, e := h.completenessScan(ctx, cat, ns, table, names); e != nil {
			h.Log.Warn("asset completeness", "err", e.Error())
		} else if sc > 0 {
			resp["quality"] = sc
			if h.Quality != nil {
				h.Quality.Set(urn, sc)
			}
		}
	}

	// Usage-over-time from the query-audit trail.
	if u, e := h.Store.UsageByTable(ctx, table); e == nil {
		resp["usage"] = u
	} else {
		resp["usage"] = []map[string]any{}
	}

	// Downstream count from DataHub lineage.
	downstream := 0
	if g, e := h.Adapters.Metadata.GetLineage(ctx, urn); e == nil {
		for _, edge := range g.Edges {
			if edge[0] == urn {
				downstream++
			}
		}
	}
	resp["downstream"] = downstream

	writeJSON(w, http.StatusOK, resp)
}

// DatasetSchema — GET /api/datasets/{ns}/{table}/schema. Column metadata from the
// Iceberg REST catalog (Analytics field list / asset schema).
func (h *Handlers) DatasetSchema(w http.ResponseWriter, r *http.Request) {
	ns := chi.URLParam(r, "ns")
	table := chi.URLParam(r, "table")
	schema, err := h.Adapters.Catalog.GetSchema(r.Context(), ns, table)
	if err != nil {
		h.Log.Error("dataset schema", "ns", ns, "table", table, "err", err.Error())
		writeError(w, http.StatusBadGateway, "catalog unavailable")
		return
	}
	writeJSON(w, http.StatusOK, schema)
}

// claimsGroups returns the caller's groups (nil-safe).
func claimsGroups(c *auth.Claims) []string {
	if c == nil {
		return nil
	}
	return c.Groups
}

// toFloat coerces a query-engine numeric value (int64/float64/string) to float64.
func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case int32:
		return float64(x)
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	default:
		return 0
	}
}
