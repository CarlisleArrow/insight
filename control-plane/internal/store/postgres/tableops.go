package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// --- §17 governance store: approval_request + maintenance_job ---

type ApprovalRequest struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Target     string          `json:"target"`
	Payload    json.RawMessage `json:"payload"`
	Diff       json.RawMessage `json:"diff,omitempty"`
	Impact     json.RawMessage `json:"impact,omitempty"`
	Status     string          `json:"status"`
	Requester  string          `json:"requester"`
	Reason     string          `json:"reason"`
	Approver   string          `json:"approver,omitempty"`
	Result     string          `json:"result,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
	DecidedAt  *time.Time      `json:"decided_at,omitempty"`
	ExecutedAt *time.Time      `json:"executed_at,omitempty"`
}

const approvalCols = `id::text, type, target, payload,
	COALESCE(diff,'null'::jsonb), COALESCE(impact,'null'::jsonb), status,
	COALESCE(requester,''), COALESCE(reason,''), COALESCE(approver,''), COALESCE(result,''),
	created_at, decided_at, executed_at`

func scanApproval(row rowScanner) (ApprovalRequest, error) {
	var a ApprovalRequest
	err := row.Scan(&a.ID, &a.Type, &a.Target, &a.Payload, &a.Diff, &a.Impact, &a.Status,
		&a.Requester, &a.Reason, &a.Approver, &a.Result, &a.CreatedAt, &a.DecidedAt, &a.ExecutedAt)
	return a, err
}

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *Store) ListApprovals(ctx context.Context, status string) ([]ApprovalRequest, error) {
	q := `SELECT ` + approvalCols + ` FROM platform_metadata.approval_request`
	args := []any{}
	if status != "" {
		q += ` WHERE status=$1`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list approvals: %w", err)
	}
	defer rows.Close()
	out := []ApprovalRequest{}
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) GetApproval(ctx context.Context, id string) (ApprovalRequest, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+approvalCols+` FROM platform_metadata.approval_request WHERE id=$1`, id)
	return scanApproval(row)
}

func (s *Store) CreateApproval(ctx context.Context, a ApprovalRequest) (ApprovalRequest, error) {
	if a.Status == "" {
		a.Status = "pending"
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO platform_metadata.approval_request
		(type, target, payload, diff, impact, status, requester, reason)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id::text, created_at`,
		a.Type, a.Target, rawOr(a.Payload, "{}"), nullableJSON(a.Diff), nullableJSON(a.Impact),
		a.Status, nullable(a.Requester), nullable(a.Reason)).Scan(&a.ID, &a.CreatedAt)
	if err != nil {
		return ApprovalRequest{}, fmt.Errorf("create approval: %w", err)
	}
	return a, nil
}

// DecideApproval sets approved/rejected with approver + decision time.
func (s *Store) DecideApproval(ctx context.Context, id, status, approver string) error {
	_, err := s.pool.Exec(ctx, `UPDATE platform_metadata.approval_request
		SET status=$2, approver=$3, decided_at=now() WHERE id=$1 AND status='pending'`,
		id, status, nullable(approver))
	return err
}

// MarkApprovalExecuted records the post-execution outcome.
func (s *Store) MarkApprovalExecuted(ctx context.Context, id, status, result string) error {
	_, err := s.pool.Exec(ctx, `UPDATE platform_metadata.approval_request
		SET status=$2, result=$3, executed_at=now() WHERE id=$1`, id, status, nullable(result))
	return err
}

// --- maintenance jobs ---

type MaintenanceJob struct {
	JobID      string     `json:"job_id"`
	NS         string     `json:"ns"`
	Table      string     `json:"table"`
	Op         string     `json:"op"`
	Status     string     `json:"status"`
	Result     string     `json:"result,omitempty"`
	Requester  string     `json:"requester,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

func (s *Store) CreateMaintenanceJob(ctx context.Context, j MaintenanceJob) (MaintenanceJob, error) {
	if j.Status == "" {
		j.Status = "running"
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO platform_metadata.maintenance_job
		(ns, table_name, op, status, requester) VALUES ($1,$2,$3,$4,$5)
		RETURNING job_id::text, started_at`,
		j.NS, j.Table, j.Op, j.Status, nullable(j.Requester)).Scan(&j.JobID, &j.StartedAt)
	if err != nil {
		return MaintenanceJob{}, fmt.Errorf("create maintenance job: %w", err)
	}
	return j, nil
}

func (s *Store) FinishMaintenanceJob(ctx context.Context, jobID, status, result string) error {
	_, err := s.pool.Exec(ctx, `UPDATE platform_metadata.maintenance_job
		SET status=$2, result=$3, finished_at=now() WHERE job_id=$1`, jobID, status, nullable(result))
	return err
}

func (s *Store) ListMaintenanceJobs(ctx context.Context, ns, table string) ([]MaintenanceJob, error) {
	q := `SELECT job_id::text, ns, table_name, op, status, COALESCE(result,''),
		COALESCE(requester,''), started_at, finished_at FROM platform_metadata.maintenance_job`
	args := []any{}
	if ns != "" && table != "" {
		q += ` WHERE ns=$1 AND table_name=$2`
		args = append(args, ns, table)
	}
	q += ` ORDER BY started_at DESC LIMIT 100`
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list maintenance jobs: %w", err)
	}
	defer rows.Close()
	out := []MaintenanceJob{}
	for rows.Next() {
		var j MaintenanceJob
		if err := rows.Scan(&j.JobID, &j.NS, &j.Table, &j.Op, &j.Status, &j.Result,
			&j.Requester, &j.StartedAt, &j.FinishedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
