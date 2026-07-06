package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/agent"
	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Agent workflow endpoints (§21). The engine walks the flow DAG; the executors
// below are where security inheritance happens: the data_query node calls
// runQueryCtx (query gateway + L6 masking + audit) with the RUN CALLER's
// groups — an agent can never see more than its invoker.

// --- Flow CRUD --------------------------------------------------------------

// AgentListFlows — GET /api/agent/flows. Enriched with last-run status.
func (h *Handlers) AgentListFlows(w http.ResponseWriter, r *http.Request) {
	flows, err := h.Store.ListAgentFlows(r.Context())
	if err != nil {
		h.Log.Error("list agent flows", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "list flows failed")
		return
	}
	out := make([]map[string]any, 0, len(flows))
	for _, f := range flows {
		lastRun := "—"
		if runs, err := h.Store.ListAgentRuns(r.Context(), f.ID, 1); err == nil && len(runs) > 0 {
			lastRun = runs[0].Status
		}
		out = append(out, agentFlowJSON(f, lastRun))
	}
	writeJSON(w, http.StatusOK, out)
}

// agentFlowJSON shapes a flow for the front-end flows table + canvas.
func agentFlowJSON(f pg.AgentFlow, lastRun string) map[string]any {
	trigger := map[string]any{}
	_ = json.Unmarshal(f.Trigger, &trigger)
	tt, _ := trigger["type"].(string)
	if tt == "" {
		tt = "manual"
	}
	status := "Draft"
	if f.Status == "published" {
		status = "Published"
	}
	return map[string]any{
		"id": f.ID, "name": f.Name, "desc": f.Description,
		"trigger": tt, "triggerSpec": trigger,
		"status": status, "lastRun": lastRunLabel(lastRun), "owner": f.Owner,
		"nodes": f.Nodes, "edges": f.Edges,
	}
}

func lastRunLabel(status string) string {
	switch status {
	case "success":
		return "success"
	case "failed", "rejected":
		return "failed"
	case "running", "awaiting_approval":
		return "running"
	default:
		return "—"
	}
}

type agentFlowRequest struct {
	Name        string          `json:"name"`
	Description string          `json:"desc"`
	Trigger     json.RawMessage `json:"trigger"`
	Nodes       json.RawMessage `json:"nodes"`
	Edges       json.RawMessage `json:"edges"`
	Status      string          `json:"status"`
}

func (rq agentFlowRequest) toFlow() pg.AgentFlow {
	status := strings.ToLower(rq.Status)
	if status != "published" {
		status = "draft"
	}
	return pg.AgentFlow{
		Name: rq.Name, Description: rq.Description,
		Trigger: rq.Trigger, Nodes: rq.Nodes, Edges: rq.Edges, Status: status,
	}
}

// AgentCreateFlow — POST /api/agent/flows.
func (h *Handlers) AgentCreateFlow(w http.ResponseWriter, r *http.Request) {
	var rq agentFlowRequest
	if err := decodeJSON(r, &rq); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if rq.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	f := rq.toFlow()
	claims, _ := auth.FromContext(r.Context())
	f.Owner = subjectRef(claims)
	created, err := h.Store.CreateAgentFlow(r.Context(), f)
	if err != nil {
		h.Log.Error("create agent flow", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "create flow failed")
		return
	}
	writeJSON(w, http.StatusCreated, agentFlowJSON(created, "—"))
}

// AgentUpdateFlow — PUT /api/agent/flows/{id}. Canvas save (nodes/edges JSON).
func (h *Handlers) AgentUpdateFlow(w http.ResponseWriter, r *http.Request) {
	var rq agentFlowRequest
	if err := decodeJSON(r, &rq); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	f := rq.toFlow()
	f.ID = chi.URLParam(r, "id")
	updated, err := h.Store.UpdateAgentFlow(r.Context(), f)
	if err != nil {
		h.Log.Error("update agent flow", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "update flow failed")
		return
	}
	writeJSON(w, http.StatusOK, agentFlowJSON(updated, "—"))
}

// AgentDeleteFlow — DELETE /api/agent/flows/{id}.
func (h *Handlers) AgentDeleteFlow(w http.ResponseWriter, r *http.Request) {
	if err := h.Store.DeleteAgentFlow(r.Context(), chi.URLParam(r, "id")); err != nil {
		h.Log.Error("delete agent flow", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "delete flow failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Runs --------------------------------------------------------------------

// AgentRunFlow — POST /api/agent/flows/{id}/run. Executes synchronously up to
// completion or the first approval pause and returns the run with its trace.
func (h *Handlers) AgentRunFlow(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())
	run, err := h.startAgentRun(r.Context(), chi.URLParam(r, "id"), claimsGroups(claims), subjectRef(claims))
	if err != nil {
		h.Log.Error("run agent flow", "err", err.Error())
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// RunAgentFlowByID adapts startAgentRun to the cron scheduler contract
// (report.RunFunc): scheduled fires run with no caller groups.
func (h *Handlers) RunAgentFlowByID(ctx context.Context, flowID string) error {
	_, err := h.startAgentRun(ctx, flowID, nil, "agent-scheduler")
	return err
}

// startAgentRun creates a run row and executes the engine with the caller's
// identity threaded into every executor. Also used by the cron scheduler
// (with the flow owner's identity unavailable → platform groups empty, so
// scheduled runs see only unrestricted data).
func (h *Handlers) startAgentRun(ctx context.Context, flowID string, groups []string, subject string) (pg.AgentRun, error) {
	flow, err := h.Store.GetAgentFlow(ctx, flowID)
	if err != nil {
		return pg.AgentRun{}, fmt.Errorf("flow not found")
	}
	var nodes []agent.Node
	var edges []agent.Edge
	if err := json.Unmarshal(flow.Nodes, &nodes); err != nil {
		return pg.AgentRun{}, fmt.Errorf("invalid flow nodes: %w", err)
	}
	if err := json.Unmarshal(flow.Edges, &edges); err != nil {
		return pg.AgentRun{}, fmt.Errorf("invalid flow edges: %w", err)
	}
	run, err := h.Store.CreateAgentRun(ctx, flowID)
	if err != nil {
		return pg.AgentRun{}, err
	}
	trace, status := agent.Run(ctx, nodes, edges, nil, h.agentExecutors(groups, subject))
	return h.persistAgentRun(ctx, run, trace, status)
}

func (h *Handlers) persistAgentRun(ctx context.Context, run pg.AgentRun, trace []agent.Step, status string) (pg.AgentRun, error) {
	raw, err := json.Marshal(trace)
	if err != nil {
		return pg.AgentRun{}, err
	}
	if err := h.Store.SaveAgentRun(ctx, run.ID, status, raw); err != nil {
		return pg.AgentRun{}, err
	}
	run.Status = status
	run.Trace = raw
	return run, nil
}

// AgentListRuns — GET /api/agent/flows/{id}/runs.
func (h *Handlers) AgentListRuns(w http.ResponseWriter, r *http.Request) {
	runs, err := h.Store.ListAgentRuns(r.Context(), chi.URLParam(r, "id"), 50)
	if err != nil {
		h.Log.Error("list agent runs", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "list runs failed")
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

// AgentGetRun — GET /api/agent/runs/{runId}. The full trace.
func (h *Handlers) AgentGetRun(w http.ResponseWriter, r *http.Request) {
	run, err := h.Store.GetAgentRun(r.Context(), chi.URLParam(r, "runId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	writeJSON(w, http.StatusOK, run)
}

type agentApproveRequest struct {
	Approve bool `json:"approve"`
}

// AgentApprove — POST /api/agent/runs/{runId}/approve. HITL resume (§21):
// records the decision on the waiting step, then re-enters the engine which
// continues past the approval (or halts as rejected).
func (h *Handlers) AgentApprove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var rq agentApproveRequest
	if err := decodeJSON(r, &rq); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	run, err := h.Store.GetAgentRun(ctx, chi.URLParam(r, "runId"))
	if err != nil {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if run.Status != "awaiting_approval" {
		writeError(w, http.StatusConflict, "run is not awaiting approval")
		return
	}
	var trace []agent.Step
	if err := json.Unmarshal(run.Trace, &trace); err != nil {
		writeError(w, http.StatusInternalServerError, "corrupt run trace")
		return
	}
	stamped := false
	for i := range trace {
		if trace[i].Status == "wait" && trace[i].Approved == nil {
			v := rq.Approve
			trace[i].Approved = &v
			stamped = true
			break
		}
	}
	if !stamped {
		writeError(w, http.StatusConflict, "no waiting approval step found")
		return
	}

	flow, err := h.Store.GetAgentFlow(ctx, run.FlowID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "flow missing for run")
		return
	}
	var nodes []agent.Node
	var edges []agent.Edge
	_ = json.Unmarshal(flow.Nodes, &nodes)
	_ = json.Unmarshal(flow.Edges, &edges)

	claims, _ := auth.FromContext(ctx)
	newTrace, status := agent.Run(ctx, nodes, edges, trace, h.agentExecutors(claimsGroups(claims), subjectRef(claims)))
	saved, err := h.persistAgentRun(ctx, run, newTrace, status)
	if err != nil {
		h.Log.Error("persist resumed run", "err", err.Error())
		writeError(w, http.StatusInternalServerError, "resume failed")
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

// --- Executors (security inheritance point) ----------------------------------

// agentExecutors binds the engine's node executors to platform capabilities,
// carrying the run caller's identity so masking and audit apply per §21.4.
func (h *Handlers) agentExecutors(groups []string, subject string) agent.Executors {
	return agent.Executors{
		// data_query → query gateway. NO bypass: same path as /api/query.
		Query: func(ctx context.Context, dataset, filter string, limit int) (agent.Result, error) {
			schema, table, ok := strings.Cut(dataset, ".")
			if !ok {
				return agent.Result{}, fmt.Errorf("query node dataset must be schema.table, got %q", dataset)
			}
			if limit <= 0 || limit > 200 {
				limit = 20
			}
			sql := fmt.Sprintf(`SELECT * FROM iceberg.%s.%s`, quoteIdent(schema), quoteIdent(table))
			if strings.TrimSpace(filter) != "" {
				sql += " WHERE " + filter
			}
			sql += fmt.Sprintf(" LIMIT %d", limit)
			resp, err := h.runQueryCtx(ctx, sql, dto.TargetRef{Schema: schema, Table: table}, groups, subject, "trino")
			if err != nil {
				return agent.Result{}, err
			}
			cols := make([]string, 0, len(resp.Result.Columns))
			for _, c := range resp.Result.Columns {
				cols = append(cols, c.Key)
			}
			evidence := [][]string{cols}
			for i, row := range resp.Result.Rows {
				if i >= 10 { // trace keeps a sample; vars keep the first row
					break
				}
				vals := make([]string, 0, len(cols))
				for _, c := range cols {
					vals = append(vals, fmt.Sprintf("%v", row[c]))
				}
				evidence = append(evidence, vals)
			}
			vars := map[string]any{"rows": len(resp.Result.Rows)}
			if len(resp.Result.Rows) > 0 {
				for k, v := range resp.Result.Rows[0] {
					vars[k] = v
				}
			}
			return agent.Result{
				Out:      fmt.Sprintf("%d rows from %s (masked)", len(resp.Result.Rows), dataset),
				Vars:     vars,
				Evidence: evidence,
				Masked:   true,
			}, nil
		},

		Retrieve: func(ctx context.Context, query string, k int) (agent.Result, error) {
			docs, err := h.Store.SearchAiSemantic(ctx, query, k)
			if err != nil {
				return agent.Result{}, err
			}
			names := make([]string, 0, len(docs))
			var ctxText strings.Builder
			for _, d := range docs {
				names = append(names, d.URN)
				ctxText.WriteString(d.URN + ": " + d.NL + " " + d.Caliber + " " + d.Domain + "\n")
			}
			return agent.Result{
				Out:  fmt.Sprintf("%d chunks · %s", len(docs), strings.Join(names, ", ")),
				Vars: map[string]any{"retrieved": ctxText.String(), "count": len(docs)},
			}, nil
		},

		Chat: func(ctx context.Context, modelName, prompt string) (agent.Result, error) {
			m, err := h.aiModelForSensitivity(ctx, modelName, "Internal")
			if err != nil {
				return agent.Result{}, err
			}
			reply, err := h.aiClient().Chat(ctx, aiCallTarget(m), "", prompt)
			if err != nil {
				return agent.Result{}, err
			}
			return agent.Result{
				Out: truncate(reply, 160), Vars: map[string]any{"reply": reply},
				Model: m.Name, Prompt: prompt, Reply: reply,
			}, nil
		},

		Tool: func(ctx context.Context, name string, args map[string]any) (agent.Result, error) {
			switch name {
			case "notify", "":
				msg, _ := args["message"].(string)
				return h.agentNotify(ctx, "Agent tool", msg)
			default:
				return agent.Result{}, fmt.Errorf("unsupported tool %q (supported: notify)", name)
			}
		},

		Output: func(ctx context.Context, kind, target, message string) (agent.Result, error) {
			if message == "" {
				message = "Agent flow completed."
			}
			r, err := h.agentNotify(ctx, "Agent output", message)
			if err != nil {
				return agent.Result{}, err
			}
			if target != "" {
				r.Out = "delivered to " + target
			}
			return r, nil
		},
	}
}

// agentNotify writes a platform notification (the §21 output/tool channel).
func (h *Handlers) agentNotify(ctx context.Context, title, message string) (agent.Result, error) {
	doc := pg.Doc{
		"icon": "watson", "title": title, "desc": truncate(message, 300),
		"time": "just now", "unread": true,
	}
	if _, err := h.Store.CreateDoc(ctx, "notifications", doc); err != nil {
		return agent.Result{}, err
	}
	return agent.Result{Out: "notification created", Vars: map[string]any{"delivered": true}}, nil
}

// truncate shortens display strings in traces.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
