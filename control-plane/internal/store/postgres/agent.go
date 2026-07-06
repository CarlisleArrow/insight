package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// AgentFlow is a canvas definition (§21). Nodes/Edges are the raw canvas JSON
// (shape owned by the front-end + agent engine).
type AgentFlow struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"desc"`
	Trigger     json.RawMessage `json:"trigger"`
	Nodes       json.RawMessage `json:"nodes"`
	Edges       json.RawMessage `json:"edges"`
	Status      string          `json:"status"`
	Owner       string          `json:"owner"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

// AgentRun is one execution with its per-node trace.
type AgentRun struct {
	ID        string          `json:"id"`
	FlowID    string          `json:"flow_id"`
	Status    string          `json:"status"`
	Trace     json.RawMessage `json:"trace"`
	StartedAt time.Time       `json:"started_at"`
	EndedAt   *time.Time      `json:"ended_at,omitempty"`
}

const agentFlowCols = `flow_id::text, name, COALESCE(description,''), trigger, nodes, edges,
	COALESCE(status,'draft'), COALESCE(owner,''), updated_at`

func scanAgentFlow(scan func(dest ...any) error) (AgentFlow, error) {
	var f AgentFlow
	err := scan(&f.ID, &f.Name, &f.Description, &f.Trigger, &f.Nodes, &f.Edges,
		&f.Status, &f.Owner, &f.UpdatedAt)
	return f, err
}

func (s *Store) ListAgentFlows(ctx context.Context) ([]AgentFlow, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+agentFlowCols+`
		FROM platform_metadata.agent_flow ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("list agent flows: %w", err)
	}
	defer rows.Close()
	out := []AgentFlow{}
	for rows.Next() {
		f, err := scanAgentFlow(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) GetAgentFlow(ctx context.Context, id string) (AgentFlow, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+agentFlowCols+`
		FROM platform_metadata.agent_flow WHERE flow_id=$1`, id)
	f, err := scanAgentFlow(row.Scan)
	if err != nil {
		return AgentFlow{}, fmt.Errorf("get agent flow %s: %w", id, err)
	}
	return f, nil
}

func (s *Store) CreateAgentFlow(ctx context.Context, f AgentFlow) (AgentFlow, error) {
	if f.Status == "" {
		f.Status = "draft"
	}
	f.Trigger = orJSON(f.Trigger, `{"type":"manual"}`)
	f.Nodes = orJSON(f.Nodes, `[]`)
	f.Edges = orJSON(f.Edges, `[]`)
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.agent_flow (name, description, trigger, nodes, edges, status, owner)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING flow_id::text, updated_at`,
		f.Name, f.Description, f.Trigger, f.Nodes, f.Edges, f.Status, nullable(f.Owner),
	).Scan(&f.ID, &f.UpdatedAt)
	if err != nil {
		return AgentFlow{}, fmt.Errorf("create agent flow: %w", err)
	}
	return f, nil
}

func (s *Store) UpdateAgentFlow(ctx context.Context, f AgentFlow) (AgentFlow, error) {
	f.Trigger = orJSON(f.Trigger, `{"type":"manual"}`)
	f.Nodes = orJSON(f.Nodes, `[]`)
	f.Edges = orJSON(f.Edges, `[]`)
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.agent_flow
		SET name=$2, description=$3, trigger=$4, nodes=$5, edges=$6, status=$7, updated_at=now()
		WHERE flow_id=$1`,
		f.ID, f.Name, f.Description, f.Trigger, f.Nodes, f.Edges, f.Status)
	if err != nil {
		return AgentFlow{}, fmt.Errorf("update agent flow: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return AgentFlow{}, fmt.Errorf("agent flow %s not found", f.ID)
	}
	return f, nil
}

func (s *Store) DeleteAgentFlow(ctx context.Context, id string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.agent_flow WHERE flow_id=$1`, id); err != nil {
		return fmt.Errorf("delete agent flow: %w", err)
	}
	return nil
}

// AgentFlowSchedules returns published schedule-triggered flows: id -> cron.
// Feeds the shared cron scheduler (same contract as report schedules).
func (s *Store) AgentFlowSchedules(ctx context.Context) (map[string]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT flow_id::text, COALESCE(trigger->>'cron','')
		FROM platform_metadata.agent_flow
		WHERE status='published' AND trigger->>'type'='schedule'`)
	if err != nil {
		return nil, fmt.Errorf("agent flow schedules: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, cron string
		if err := rows.Scan(&id, &cron); err != nil {
			return nil, err
		}
		if cron != "" {
			out[id] = cron
		}
	}
	return out, rows.Err()
}

// --- Runs ---

const agentRunCols = `run_id::text, flow_id::text, status, trace, started_at, ended_at`

func scanAgentRun(scan func(dest ...any) error) (AgentRun, error) {
	var r AgentRun
	err := scan(&r.ID, &r.FlowID, &r.Status, &r.Trace, &r.StartedAt, &r.EndedAt)
	return r, err
}

func (s *Store) CreateAgentRun(ctx context.Context, flowID string) (AgentRun, error) {
	var r AgentRun
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.agent_run (flow_id) VALUES ($1)
		RETURNING `+agentRunCols, flowID).Scan(&r.ID, &r.FlowID, &r.Status, &r.Trace, &r.StartedAt, &r.EndedAt)
	if err != nil {
		return AgentRun{}, fmt.Errorf("create agent run: %w", err)
	}
	return r, nil
}

func (s *Store) GetAgentRun(ctx context.Context, id string) (AgentRun, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+agentRunCols+`
		FROM platform_metadata.agent_run WHERE run_id=$1`, id)
	r, err := scanAgentRun(row.Scan)
	if err != nil {
		return AgentRun{}, fmt.Errorf("get agent run %s: %w", id, err)
	}
	return r, nil
}

func (s *Store) ListAgentRuns(ctx context.Context, flowID string, limit int) ([]AgentRun, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT `+agentRunCols+`
		FROM platform_metadata.agent_run WHERE flow_id=$1
		ORDER BY started_at DESC LIMIT $2`, flowID, limit)
	if err != nil {
		return nil, fmt.Errorf("list agent runs: %w", err)
	}
	defer rows.Close()
	out := []AgentRun{}
	for rows.Next() {
		r, err := scanAgentRun(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SaveAgentRun persists the current trace + status; terminal states stamp
// ended_at.
func (s *Store) SaveAgentRun(ctx context.Context, id, status string, trace json.RawMessage) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.agent_run
		SET status=$2, trace=$3,
		    ended_at=CASE WHEN $2 IN ('success','failed','rejected') THEN now() ELSE NULL END
		WHERE run_id=$1`, id, status, orJSON(trace, `[]`))
	if err != nil {
		return fmt.Errorf("save agent run: %w", err)
	}
	return nil
}

func orJSON(raw json.RawMessage, def string) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(def)
	}
	return raw
}
