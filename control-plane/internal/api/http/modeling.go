package http

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/codegen"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// --- Modeling-as-Code (§16) ---
// Visual star-schema modeling persists the meta-model IR (dwm_*); generate renders
// it to ETL scripts + DAG via internal/codegen (custom blocks preserved); deploy
// writes the artifacts to the shared RWX volume so Airflow/Spark pick them up.

// ListModels — GET /api/models.
func (h *Handlers) ListModels(w http.ResponseWriter, r *http.Request) {
	items, err := h.Store.ListModels(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// GetModel — GET /api/models/{id}: full IR (tables, columns, relationships).
func (h *Handlers) GetModel(w http.ResponseWriter, r *http.Request) {
	fm, err := h.Store.LoadFullModel(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, fm)
}

// CreateModel — POST /api/models.
func (h *Handlers) CreateModel(w http.ResponseWriter, r *http.Request) {
	var m pg.DwmModel
	if err := decodeJSON(r, &m); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if m.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	created, err := h.Store.CreateModel(r.Context(), m)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// DeleteModel — DELETE /api/models/{id}.
func (h *Handlers) DeleteModel(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteModel(r.Context(), chi.URLParam(r, "id")); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// replaceModelReq is what the visual modeler PUTs: the complete table-set and
// relationships. Relationships reference tables by NAME (stable across re-model);
// the handler resolves them to the freshly-inserted table IDs.
type replaceModelReq struct {
	Tables        []pg.DwmTable `json:"tables"`
	Relationships []struct {
		FactTable string `json:"fact_table"`
		DimTable  string `json:"dim_table"`
		FactFK    string `json:"fact_fk"`
		DimPK     string `json:"dim_pk"`
	} `json:"relationships"`
}

// ReplaceModelTables — PUT /api/models/{id}/tables. Replaces the model's IR.
func (h *Handlers) ReplaceModelTables(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req replaceModelReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ctx := r.Context()
	if err := h.Store.ClearModelTables(ctx, id); err != nil {
		writeError(w, http.StatusInternalServerError, "clear failed")
		return
	}
	nameToID := map[string]string{}
	for _, t := range req.Tables {
		t.ModelID = id
		saved, err := h.Store.UpsertTable(ctx, t)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "save table failed: "+err.Error())
			return
		}
		nameToID[saved.Name] = saved.TableID
	}
	for _, rel := range req.Relationships {
		factID, ok1 := nameToID[rel.FactTable]
		dimID, ok2 := nameToID[rel.DimTable]
		if !ok1 || !ok2 {
			writeError(w, http.StatusBadRequest, "relationship references unknown table: "+rel.FactTable+"/"+rel.DimTable)
			return
		}
		if _, err := h.Store.AddRelationship(ctx, pg.DwmRelationship{
			ModelID: id, FactTableID: factID, DimTableID: dimID, FactFK: rel.FactFK, DimPK: rel.DimPK,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "save relationship failed")
			return
		}
	}
	// editing the model invalidates any prior generation
	_ = h.Store.SetModelStatus(ctx, id, "draft")
	fm, err := h.Store.LoadFullModel(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reload failed")
		return
	}
	writeJSON(w, http.StatusOK, fm)
}

// GenerateModel — POST /api/models/{id}/generate. Validates the IR, renders ETL
// scripts (preserving custom blocks from any prior generation), writes them to the
// shared volume and returns a preview. Sets status=generated.
func (h *Handlers) GenerateModel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	fm, err := h.Store.LoadFullModel(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if errs := codegen.Validate(fm); len(errs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "validation failed", "details": errs})
		return
	}
	files, err := codegen.Generate(fm, h.readGeneratedDir())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate failed: "+err.Error())
		return
	}
	for _, f := range files {
		if f.Kind != "etl" {
			continue
		}
		if err := writeShared(h.CodegenDir, f.Name, f.Content); err != nil {
			writeError(w, http.StatusInternalServerError, "write script failed: "+err.Error())
			return
		}
	}
	_ = h.Store.SetModelStatus(ctx, id, "generated")
	writeJSON(w, http.StatusOK, map[string]any{"model_id": id, "files": files})
}

// DeployModel — POST /api/models/{id}/deploy. Regenerates, writes ETL scripts to
// the codegen volume AND the DAG to the Airflow DAGs volume, sets status=deployed.
func (h *Handlers) DeployModel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	fm, err := h.Store.LoadFullModel(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if errs := codegen.Validate(fm); len(errs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "validation failed", "details": errs})
		return
	}
	files, err := codegen.Generate(fm, h.readGeneratedDir())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "generate failed: "+err.Error())
		return
	}
	var dagName string
	for _, f := range files {
		switch f.Kind {
		case "etl":
			if err := writeShared(h.CodegenDir, f.Name, f.Content); err != nil {
				writeError(w, http.StatusInternalServerError, "write script failed: "+err.Error())
				return
			}
		case "dag":
			if err := writeShared(h.DAGsDir, f.Name, f.Content); err != nil {
				writeError(w, http.StatusInternalServerError, "write dag failed: "+err.Error())
				return
			}
			dagName = f.Name
		}
	}
	_ = h.Store.SetModelStatus(ctx, id, "deployed")
	writeJSON(w, http.StatusOK, map[string]any{
		"model_id": id, "status": "deployed", "dag": dagName, "scripts": len(files) - 1,
	})
}

// readGeneratedDir loads existing generated scripts (name->content) so custom
// blocks survive regeneration. Best-effort: a missing dir yields an empty map.
func (h *Handlers) readGeneratedDir() map[string]string {
	out := map[string]string{}
	if h.CodegenDir == "" {
		return out
	}
	entries, err := os.ReadDir(h.CodegenDir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".py") {
			continue
		}
		if b, err := os.ReadFile(filepath.Join(h.CodegenDir, e.Name())); err == nil {
			out[e.Name()] = string(b)
		}
	}
	return out
}

// writeShared atomically writes a generated artifact into a shared RWX volume dir.
func writeShared(dir, name, content string) error {
	if dir == "" {
		return os.ErrInvalid
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	final := filepath.Join(dir, name)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}
