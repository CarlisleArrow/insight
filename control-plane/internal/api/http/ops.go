package http

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// OpsRuns — GET /api/ops/runs. Recent ETL task runs (Airflow) plus a status
// roll-up for the Monitoring summary cards.
func (h *Handlers) OpsRuns(w http.ResponseWriter, r *http.Request) {
	runs, err := h.Adapters.Orch.ListRuns(r.Context(), limitParam(r, 50))
	if err != nil {
		h.Log.Error("ops runs", "err", err.Error())
		writeError(w, http.StatusBadGateway, "airflow unavailable")
		return
	}
	if runs == nil {
		runs = []adapter.RunStatus{}
	}
	stats := map[string]int{"Running": 0, "Success": 0, "Failed": 0, "Retrying": 0}
	for _, run := range runs {
		stats[run.Status]++
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs, "stats": stats})
}

// OpsLogs — GET /api/ops/logs?q=&limit=. OpenSearch-backed ELK log search.
func (h *Handlers) OpsLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := h.Adapters.Logs.Search(r.Context(), r.URL.Query().Get("q"), limitParam(r, 100))
	if err != nil {
		h.Log.Error("ops logs", "err", err.Error())
		writeError(w, http.StatusBadGateway, "opensearch unavailable")
		return
	}
	if logs == nil {
		logs = []adapter.LogEntry{}
	}
	writeJSON(w, http.StatusOK, logs)
}

// OpsMetrics — GET /api/ops/metrics?q=<promql>. Prometheus instant query.
func (h *Handlers) OpsMetrics(w http.ResponseWriter, r *http.Request) {
	promql := r.URL.Query().Get("q")
	if promql == "" {
		promql = "up" // sane default so the endpoint is callable without args
	}
	samples, err := h.Adapters.Metrics.Query(r.Context(), promql)
	if err != nil {
		h.Log.Error("ops metrics", "err", err.Error())
		writeError(w, http.StatusBadGateway, "prometheus unavailable")
		return
	}
	if samples == nil {
		samples = []adapter.MetricSample{}
	}
	writeJSON(w, http.StatusOK, samples)
}

// OpsMetricsRange — GET /api/ops/metrics/range?q=<promql>&minutes=&step=. A
// PromQL range query for the Monitoring resource time-series panels. Returns one
// series per result; each point is {group, key (HH:MM), value} for the charts.
func (h *Handlers) OpsMetricsRange(w http.ResponseWriter, r *http.Request) {
	promql := r.URL.Query().Get("q")
	if promql == "" {
		writeError(w, http.StatusBadRequest, "q (promql) is required")
		return
	}
	minutes := intParam(r, "minutes", 30)
	step := intParam(r, "step", 120)
	series, err := h.Adapters.Metrics.QueryRange(r.Context(), promql, minutes, step)
	if err != nil {
		h.Log.Error("ops metrics range", "err", err.Error())
		writeError(w, http.StatusBadGateway, "prometheus unavailable")
		return
	}
	// Flatten to the front-end chart shape: [{group, key, value}].
	points := []map[string]any{}
	for _, s := range series {
		for _, p := range s.Points {
			points = append(points, map[string]any{"group": s.Metric, "key": p.Time, "value": p.Value})
		}
	}
	writeJSON(w, http.StatusOK, points)
}

func intParam(r *http.Request, name string, def int) int {
	if v := r.URL.Query().Get(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// OpsErrors — GET /api/ops/errors. Sentry unresolved issues.
func (h *Handlers) OpsErrors(w http.ResponseWriter, r *http.Request) {
	issues, err := h.Adapters.Errors.ListIssues(r.Context(), limitParam(r, 25))
	if err != nil {
		h.Log.Error("ops errors", "err", err.Error())
		writeError(w, http.StatusBadGateway, "sentry unavailable")
		return
	}
	if issues == nil {
		issues = []adapter.ErrorIssue{}
	}
	writeJSON(w, http.StatusOK, issues)
}

// RetryRun — POST /api/ops/runs/{id}/retry. The run id is "dag.task.idx"
// (from ListRuns); we re-trigger the owning DAG.
func (h *Handlers) RetryRun(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	dag := id
	if i := strings.Index(id, "."); i > 0 {
		dag = id[:i]
	}
	run, err := h.Adapters.Orch.TriggerDAG(r.Context(), adapter.DAGID(dag), nil)
	if err != nil {
		h.Log.Error("retry run", "id", id, "err", err.Error())
		writeError(w, http.StatusBadGateway, "retry failed")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"dag_id": dag, "run_id": run})
}

// OpsSla — GET /api/ops/sla. Per-pipeline SLA roll-up derived from the latest
// run of each DAG (freshness/timeliness/latency as RAG states). Shape matches
// the front-end SLA board rows.
func (h *Handlers) OpsSla(w http.ResponseWriter, r *http.Request) {
	runs, err := h.Adapters.Orch.ListRuns(r.Context(), 200)
	if err != nil {
		h.Log.Error("ops sla", "err", err.Error())
		writeError(w, http.StatusBadGateway, "airflow unavailable")
		return
	}
	// First occurrence per DAG is the most recent (ListRuns is newest-first).
	seen := map[string]bool{}
	rows := []map[string]any{}
	for _, run := range runs {
		if seen[run.DAG] {
			continue
		}
		seen[run.DAG] = true
		rag := "g"
		switch run.Status {
		case "Failed":
			rag = "r"
		case "Retrying", "Queued", "Running":
			rag = "a"
		}
		rows = append(rows, map[string]any{
			"pipe":  run.DAG,
			"fresh": rag, "freshT": run.Start,
			"time": rag, "timeT": run.Status,
			"lat": rag, "latT": run.Dur,
		})
	}
	writeJSON(w, http.StatusOK, rows)
}

func limitParam(r *http.Request, def int) int {
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
