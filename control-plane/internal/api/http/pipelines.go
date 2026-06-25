package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/orchestrator"
)

// PipelineDag — GET /api/pipelines/dag?dag=. Returns the ETL DAG task graph +
// recent run states (DevConfig ETL view). Empty dag resolves to the IPAS DAG.
func (h *Handlers) PipelineDag(w http.ResponseWriter, r *http.Request) {
	g, err := h.Adapters.Orch.GetDAG(r.Context(), r.URL.Query().Get("dag"))
	if err != nil {
		h.Log.Error("pipeline dag", "err", err.Error())
		writeError(w, http.StatusBadGateway, "airflow unavailable")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// RunPipeline — POST /api/pipelines/{id}/run. Triggers a DAG run ({id} = dag id).
func (h *Handlers) RunPipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	run, err := h.Adapters.Orch.TriggerDAG(r.Context(), adapter.DAGID(id), nil)
	if err != nil {
		h.Log.Error("run pipeline", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "trigger failed")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"dag_id": id, "run_id": run})
}

// PausePipeline — POST /api/pipelines/{id}/pause. Pauses the DAG.
func (h *Handlers) PausePipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.Adapters.Orch.PauseDAG(r.Context(), adapter.DAGID(id), true); err != nil {
		h.Log.Error("pause pipeline", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "pause failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// BackfillPipeline — POST /api/pipelines/{id}/backfill {from,to}.
func (h *Handlers) BackfillPipeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	run, err := h.Adapters.Orch.Backfill(r.Context(), adapter.DAGID(id), body.From, body.To)
	if err != nil {
		h.Log.Error("backfill pipeline", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "backfill failed")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"dag_id": id, "run_id": run})
}

// Pipelines — GET /api/pipelines. Aggregates ingest (Debezium) connector status
// (§11).
func (h *Handlers) Pipelines(w http.ResponseWriter, r *http.Request) {
	conns, err := h.Adapters.Ingest.ListConnectors(r.Context())
	if err != nil {
		h.Log.Error("list connectors", "err", err.Error())
		writeError(w, http.StatusBadGateway, "ingest unavailable")
		return
	}
	if conns == nil {
		conns = []adapter.ConnectorStatus{}
	}
	writeJSON(w, http.StatusOK, conns)
}

// CreatePipeline — POST /api/pipelines. Runs the "build pipeline" saga (§11):
// Debezium connector + Iceberg table in parallel, then Airflow DAG + DataHub
// status, with rollback on failure.
func (h *Handlers) CreatePipeline(w http.ResponseWriter, r *http.Request) {
	var spec orchestrator.Spec
	if err := decodeJSON(r, &spec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	res, err := h.Orchestrator.BuildPipeline(r.Context(), spec)
	if err != nil {
		h.Log.Error("build pipeline", "err", err.Error())
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

// PipelineDetail — GET /api/pipelines/{id}. Combines a connector's status with
// its recent runs (§11).
func (h *Handlers) PipelineDetail(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx := r.Context()
	conn, err := h.Adapters.Ingest.GetConnectorStatus(ctx, adapter.ConnectorID(id))
	if err != nil {
		h.Log.Error("connector status", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "ingest unavailable")
		return
	}
	runs, err := h.Adapters.Orch.ListRuns(ctx, 20)
	if err != nil {
		h.Log.Warn("list runs for pipeline", "err", err.Error())
		runs = []adapter.RunStatus{}
	}
	writeJSON(w, http.StatusOK, adapter.PipelineDetail{Connector: conn, Runs: runs})
}
