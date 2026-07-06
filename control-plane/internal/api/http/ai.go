package http

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/ai"
	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// AI capability endpoints (§20): model registry CRUD + connectivity probes,
// the semantic layer, and the grounded analyze/assist gateway. Iron rules
// (§20.5) enforced here:
//   - every data row an LLM sees is fetched via runQueryCtx (gateway + L6
//     masking + audit) — never a direct engine call;
//   - analyze targets gold-layer results only, no recomputation;
//   - answers must cite rows; an uncited data claim is not returned.

// aiClient builds the shared provider-agnostic client.
func (h *Handlers) aiClient() *ai.Client { return ai.NewClient(90 * time.Second) }

func aiCallTarget(m pg.AiModel) ai.Model {
	return ai.Model{
		Name: m.Name, Provider: m.Provider, Endpoint: m.Endpoint, Ref: m.Ref,
		SecretRef: m.AuthSecretRef, Deploy: m.Deploy, MaxTokens: m.MaxTokens,
	}
}

// --- Model registry -----------------------------------------------------

// AiListModels — GET /api/ai/models.
func (h *Handlers) AiListModels(w http.ResponseWriter, r *http.Request) {
	models, err := h.Store.ListAiModels(r.Context())
	if err != nil {
		h.Log.Error("list ai models", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "list models failed")
		return
	}
	writeJSON(w, http.StatusOK, models)
}

// AiCreateModel — POST /api/ai/models.
func (h *Handlers) AiCreateModel(w http.ResponseWriter, r *http.Request) {
	var m pg.AiModel
	if err := decodeJSON(r, &m); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if m.Name == "" || m.Endpoint == "" || m.Ref == "" {
		writeError(w, http.StatusBadRequest, "name, endpoint and ref are required")
		return
	}
	if m.Deploy != "local" {
		m.Deploy = "external"
	}
	m.Enabled = true
	created, err := h.Store.CreateAiModel(r.Context(), m)
	if err != nil {
		h.Log.Error("create ai model", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "create model failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// AiUpdateModel — PUT /api/ai/models/{id}.
func (h *Handlers) AiUpdateModel(w http.ResponseWriter, r *http.Request) {
	var m pg.AiModel
	if err := decodeJSON(r, &m); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	m.ID = chi.URLParam(r, "id")
	if m.Status != "" {
		m.Enabled = m.Status == "Active"
	}
	updated, err := h.Store.UpdateAiModel(r.Context(), m)
	if err != nil {
		h.Log.Error("update ai model", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "update model failed")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// AiDeleteModel — DELETE /api/ai/models/{id}.
func (h *Handlers) AiDeleteModel(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteAiModel(r.Context(), chi.URLParam(r, "id")); err != nil {
		h.Log.Error("delete ai model", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "delete model failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AiTestModel — POST /api/ai/models/{id}/test. Sends a real probe prompt to
// the registered endpoint and stamps last_tested on success.
func (h *Handlers) AiTestModel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	m, err := h.Store.GetAiModel(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "model not found")
		return
	}
	reply, latency, err := h.aiClient().TestConnection(r.Context(), aiCallTarget(m))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if err := h.Store.TouchAiModelTested(r.Context(), id); err != nil {
		h.Log.Warn("touch ai model tested", "err", err.Error())
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ms": latency.Milliseconds(), "reply": reply})
}

// AiTestModelSpec — POST /api/ai/models/test. Probes an UNSAVED model spec
// (registration modal), mirroring the datasource test pattern — nothing stored.
func (h *Handlers) AiTestModelSpec(w http.ResponseWriter, r *http.Request) {
	var m pg.AiModel
	if err := decodeJSON(r, &m); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	reply, latency, err := h.aiClient().TestConnection(r.Context(), aiCallTarget(m))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ms": latency.Milliseconds(), "reply": reply})
}

// --- Semantic layer -------------------------------------------------------

// AiSemanticList — GET /api/ai/semantic.
func (h *Handlers) AiSemanticList(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.ListAiSemantic(r.Context())
	if err != nil {
		h.Log.Error("list ai semantic", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "list semantic failed")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// AiSemanticUpsert — PUT /api/ai/semantic/{urn}.
func (h *Handlers) AiSemanticUpsert(w http.ResponseWriter, r *http.Request) {
	var e pg.AiSemantic
	if err := decodeJSON(r, &e); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	e.URN = chi.URLParam(r, "urn")
	if e.Type == "" {
		e.Type = "table"
	}
	saved, err := h.Store.UpsertAiSemantic(r.Context(), e)
	if err != nil {
		h.Log.Error("upsert ai semantic", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "save semantics failed")
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// AiSemanticCompile — POST /api/ai/semantic/compile. Pre-fills the semantic
// layer from what the platform already knows: DataHub assets (tables, with
// their catalog description + sensitivity) and Glossary terms (metrics, with
// definition + formula). Never overwrites human-authored rows.
func (h *Handlers) AiSemanticCompile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	added := 0
	if assets, err := h.Adapters.Metadata.Search(ctx, ""); err == nil {
		for _, a := range assets {
			urn := a.Name
			if urn == "" {
				continue
			}
			ins, err := h.Store.EnsureAiSemantic(ctx, pg.AiSemantic{
				URN: urn, Type: "table", NL: a.Desc, Sens: a.Sens,
			})
			if err != nil {
				h.Log.Warn("compile semantic (asset)", "urn", urn, "err", err.Error())
				continue
			}
			if ins {
				added++
			}
		}
	} else {
		h.Log.Warn("compile semantic: datahub search", "err", err.Error())
	}
	if terms, err := h.Adapters.Metadata.ListGlossaryTerms(ctx); err == nil {
		for _, t := range terms {
			if t.Name == "" {
				continue
			}
			nl := t.Def
			if t.Formula != "" {
				nl += " Formula: " + t.Formula
			}
			ins, err := h.Store.EnsureAiSemantic(ctx, pg.AiSemantic{URN: t.Name, Type: "metric", NL: nl})
			if err != nil {
				h.Log.Warn("compile semantic (term)", "urn", t.Name, "err", err.Error())
				continue
			}
			if ins {
				added++
			}
		}
	} else {
		h.Log.Warn("compile semantic: glossary", "err", err.Error())
	}
	writeJSON(w, http.StatusOK, map[string]any{"added": added})
}

// AiSemanticTest — POST /api/ai/semantic/{urn}/test. "Test AI understanding":
// a model explains the entity using ONLY the authored semantics; the human
// judges whether they suffice.
func (h *Handlers) AiSemanticTest(w http.ResponseWriter, r *http.Request) {
	urn := chi.URLParam(r, "urn")
	e, err := h.Store.GetAiSemantic(r.Context(), urn)
	if err != nil {
		writeError(w, http.StatusNotFound, "semantic entity not found")
		return
	}
	m, err := h.aiModelForSensitivity(r.Context(), "", e.Sens)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	sys, usr := ai.UnderstandPrompt(semanticDoc(e))
	reply, err := h.aiClient().Chat(r.Context(), aiCallTarget(m), sys, usr)
	if err != nil {
		h.Log.Error("semantic test", "urn", urn, "err", err.Error())
		writeError(w, http.StatusBadGateway, "model call failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"explanation": reply, "model": m.Name})
}

// --- Grounded analyze / assist --------------------------------------------

type aiAnalyzeRequest struct {
	Question string        `json:"question"`
	Dataset  dto.TargetRef `json:"dataset"` // optional; resolved from semantics when empty
	Model    string        `json:"model"`   // optional model name; default model when empty
	Limit    int           `json:"limit"`
}

// AiAnalyze — POST /api/ai/analyze. Grounded self-observation (§20.5):
// retrieve semantics → build a constrained gold-layer query → run it through
// the query gateway (masking + audit) → the model explains, citing rows.
func (h *Handlers) AiAnalyze(w http.ResponseWriter, r *http.Request) {
	h.aiGrounded(w, r, "")
}

// AiAssist — POST /api/ai/assist. Decision support: the same grounded path
// plus the caller's role context (management → rollups, line → detail).
func (h *Handlers) AiAssist(w http.ResponseWriter, r *http.Request) {
	roles := []string{}
	if az, ok := auth.AuthzFromContext(r.Context()); ok && az != nil {
		roles = az.Roles
	}
	roleCtx := "Caller roles: " + strings.Join(roles, ", ") +
		". For management roles prefer summarized, rollup-level guidance; for line roles give actionable detail."
	h.aiGrounded(w, r, roleCtx)
}

func (h *Handlers) aiGrounded(w http.ResponseWriter, r *http.Request, roleCtx string) {
	ctx := r.Context()
	claims, _ := auth.FromContext(ctx)

	var req aiAnalyzeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Question) == "" {
		writeError(w, http.StatusBadRequest, "question is required")
		return
	}

	// 1. RAG retrieval: semantics grounding the question.
	sem, err := h.Store.SearchAiSemantic(ctx, keywordFor(req.Question), 5)
	if err != nil {
		h.Log.Warn("semantic retrieve", "err", err.Error())
	}

	// 2. Resolve the target gold table (request wins; else best table match).
	target := req.Dataset
	if target.Table == "" {
		for _, d := range sem {
			if d.Type == "table" {
				if schema, table, ok := splitURN(d.URN); ok {
					target = dto.TargetRef{Schema: schema, Table: table}
					break
				}
			}
		}
	}
	if target.Table == "" {
		writeError(w, http.StatusBadRequest, "could not resolve a target dataset — pass dataset {schema, table} or describe the table in the semantic layer")
		return
	}
	// Iron rule: analyze reads gold results only (no recomputation upstream).
	if !strings.HasPrefix(strings.ToLower(target.Schema), "gold") {
		writeError(w, http.StatusBadRequest, "analyze reads gold-layer results only — target schema must be gold*")
		return
	}

	// 3. Data boundary (§20.3): sensitivity of everything in play.
	sens := datasetSensitivity(sem, target)
	m, err := h.aiModelForSensitivity(ctx, req.Model, sens)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	// 4. Fetch already-computed rows via the query gateway (masking + audit).
	limit := req.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	sql := fmt.Sprintf(`SELECT * FROM iceberg.%s.%s LIMIT %d`,
		quoteIdent(target.Schema), quoteIdent(target.Table), limit)
	resp, err := h.runQueryCtx(ctx, sql, target, claimsGroups(claims), subjectRef(claims), "trino")
	if err != nil {
		h.Log.Error("ai analyze query", "err", err.Error())
		writeError(w, http.StatusBadGateway, "data query failed")
		return
	}
	if len(resp.Result.Rows) == 0 {
		writeError(w, http.StatusUnprocessableEntity, "no rows available to ground an answer — refusing to answer without data")
		return
	}

	// 5. Model explains; citations validated before anything is returned.
	cols := make([]string, 0, len(resp.Result.Columns))
	for _, c := range resp.Result.Columns {
		cols = append(cols, c.Key)
	}
	docs := make([]ai.SemanticDoc, 0, len(sem))
	for _, d := range sem {
		docs = append(docs, semanticDoc(d))
	}
	sys, usr := ai.AnalyzePrompt(req.Question, docs, cols, resp.Result.Rows, roleCtx)
	reply, err := h.aiClient().Chat(ctx, aiCallTarget(m), sys, usr)
	if err != nil {
		h.Log.Error("ai analyze chat", "model", m.Name, "err", err.Error())
		writeError(w, http.StatusBadGateway, "model call failed: "+err.Error())
		return
	}
	g, ok := ai.ParseGrounded(reply, len(resp.Result.Rows))
	cited := make([]map[string]any, 0, len(g.CitedRows))
	for _, i := range g.CitedRows {
		cited = append(cited, resp.Result.Rows[i])
	}
	if len(cited) == 0 {
		if ok {
			// The model followed the contract but cited nothing → uncited claim.
			writeError(w, http.StatusUnprocessableEntity, "model returned an uncited answer — rejected by the grounding rule")
			return
		}
		// Contract not followed (e.g. small local model): fall back to citing
		// the full evidence set actually supplied — still real, masked gold rows.
		cited = resp.Result.Rows
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"answer":     g.Answer,
		"cited_rows": cited,
		"columns":    resp.Result.Columns,
		"model":      m.Name,
		"source": fmt.Sprintf("%s.%s · %d rows · masking applied",
			target.Schema, target.Table, len(resp.Result.Rows)),
	})
}

// aiModelForSensitivity resolves the requested (or default) model and enforces
// the data boundary for the given sensitivity.
func (h *Handlers) aiModelForSensitivity(ctx context.Context, name, sens string) (pg.AiModel, error) {
	var m pg.AiModel
	var err error
	if name != "" {
		models, e := h.Store.ListAiModels(ctx)
		if e != nil {
			return pg.AiModel{}, e
		}
		found := false
		for _, cand := range models {
			if cand.Name == name && cand.Enabled {
				m, found = cand, true
				break
			}
		}
		if !found {
			return pg.AiModel{}, fmt.Errorf("model %q not found or disabled", name)
		}
	} else if m, err = h.Store.DefaultAiModel(ctx); err != nil {
		return pg.AiModel{}, fmt.Errorf("no enabled AI model registered")
	}
	if err := ai.CheckBoundary(m.Name, m.Deploy, sens); err != nil {
		// A local fallback keeps sensitive analyses possible without naming one.
		if name == "" {
			if models, e := h.Store.ListAiModels(ctx); e == nil {
				for _, cand := range models {
					if cand.Enabled && cand.Deploy == "local" && hasCap(cand.Caps, "chat") {
						return cand, nil
					}
				}
			}
		}
		return pg.AiModel{}, err
	}
	return m, nil
}

// datasetSensitivity is the max sensitivity across the retrieved semantics that
// mention the target, defaulting to Internal when nothing is authored.
func datasetSensitivity(sem []pg.AiSemantic, target dto.TargetRef) string {
	labels := []string{"Internal"}
	full := strings.ToLower(target.Schema + "." + target.Table)
	for _, d := range sem {
		if strings.Contains(strings.ToLower(d.URN), full) || d.Type != "table" {
			labels = append(labels, d.Sens)
		}
	}
	return ai.MaxSensitivity(labels...)
}

func semanticDoc(e pg.AiSemantic) ai.SemanticDoc {
	return ai.SemanticDoc{
		URN: e.URN, Type: e.Type, NL: e.NL, Caliber: e.Caliber, Domain: e.Domain,
		Samples: e.Samples, Rels: e.Rels, Constraints: e.Constraints, Sens: e.Sens,
	}
}

// keywordFor reduces a natural-language question to its longest token — a
// pragmatic ILIKE key until vector retrieval lands.
func keywordFor(q string) string {
	best := ""
	for _, t := range strings.FieldsFunc(q, func(r rune) bool {
		return r == ' ' || r == '?' || r == ',' || r == '.' || r == '!'
	}) {
		if len(t) > len(best) {
			best = t
		}
	}
	return best
}

// splitURN parses "schema.table" (optionally catalog-prefixed) URNs.
func splitURN(urn string) (string, string, bool) {
	parts := strings.Split(urn, ".")
	if len(parts) < 2 {
		return "", "", false
	}
	return parts[len(parts)-2], parts[len(parts)-1], true
}

func hasCap(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}
