package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Tower store (§19.7) — HQ side of federation. Factories never touch these
// tables directly; they talk to the hybrid's ingest endpoints.

// Lakehouse is one registered factory site with its last-reported health.
type Lakehouse struct {
	FactoryID     string          `json:"id"`
	Name          string          `json:"name"`
	Region        string          `json:"region"`
	Endpoint      string          `json:"endpoint"`
	TrinoEndpoint string          `json:"trino_endpoint"`
	Version       string          `json:"version"`
	Blueprint     string          `json:"blueprint"`
	Health        json.RawMessage `json:"health"`
	LastReportAt  *time.Time      `json:"last_report_at,omitempty"`
	RegisteredAt  time.Time       `json:"registered_at"`
}

// TowerCommand is one queued instruction a factory pulls and executes.
type TowerCommand struct {
	ID          string          `json:"id"`
	FactoryID   string          `json:"factory_id"`
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	Status      string          `json:"status"`
	Result      string          `json:"result,omitempty"`
	CreatedBy   string          `json:"created_by,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	PulledAt    *time.Time      `json:"pulled_at,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
}

// MetricRollup is one cross-site comparison point ingested from reports.
type MetricRollup struct {
	FactoryID string    `json:"factory_id"`
	Metric    string    `json:"metric"`
	Ts        time.Time `json:"ts"`
	Value     float64   `json:"value"`
}

// UpsertLakehouseReport records a factory's report; first report auto-registers
// the site (§19.5 blueprint self-registration).
func (s *Store) UpsertLakehouseReport(ctx context.Context, factoryID, name, endpoint, trinoEndpoint, version string, health json.RawMessage) error {
	if len(health) == 0 {
		health = json.RawMessage(`{}`)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO tower.lakehouse (factory_id, name, endpoint, trino_endpoint, version, health, last_report_at)
		VALUES ($1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''), NULLIF($5,''), $6, now())
		ON CONFLICT (factory_id) DO UPDATE SET
			name           = COALESCE(NULLIF(EXCLUDED.name,''), tower.lakehouse.name),
			endpoint       = COALESCE(NULLIF(EXCLUDED.endpoint,''), tower.lakehouse.endpoint),
			trino_endpoint = COALESCE(NULLIF(EXCLUDED.trino_endpoint,''), tower.lakehouse.trino_endpoint),
			version        = COALESCE(NULLIF(EXCLUDED.version,''), tower.lakehouse.version),
			health         = EXCLUDED.health,
			last_report_at = now()`,
		factoryID, name, endpoint, trinoEndpoint, version, health)
	if err != nil {
		return fmt.Errorf("upsert lakehouse report: %w", err)
	}
	return nil
}

const lakehouseCols = `factory_id, COALESCE(name,factory_id), COALESCE(region,''),
	COALESCE(endpoint,''), COALESCE(trino_endpoint,''), COALESCE(version,''),
	COALESCE(blueprint,''), COALESCE(health,'{}'), last_report_at, registered_at`

func scanLakehouse(scan func(dest ...any) error) (Lakehouse, error) {
	var l Lakehouse
	err := scan(&l.FactoryID, &l.Name, &l.Region, &l.Endpoint, &l.TrinoEndpoint,
		&l.Version, &l.Blueprint, &l.Health, &l.LastReportAt, &l.RegisteredAt)
	return l, err
}

func (s *Store) ListLakehouses(ctx context.Context) ([]Lakehouse, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+lakehouseCols+` FROM tower.lakehouse ORDER BY factory_id`)
	if err != nil {
		return nil, fmt.Errorf("list lakehouses: %w", err)
	}
	defer rows.Close()
	out := []Lakehouse{}
	for rows.Next() {
		l, err := scanLakehouse(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) GetLakehouse(ctx context.Context, factoryID string) (Lakehouse, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+lakehouseCols+` FROM tower.lakehouse WHERE factory_id=$1`, factoryID)
	l, err := scanLakehouse(row.Scan)
	if err != nil {
		return Lakehouse{}, fmt.Errorf("get lakehouse %s: %w", factoryID, err)
	}
	return l, nil
}

// --- Command queue ---

const commandCols = `command_id::text, factory_id, type, COALESCE(payload,'{}'),
	status, COALESCE(result,''), COALESCE(created_by,''), created_at, pulled_at, completed_at`

func scanCommand(scan func(dest ...any) error) (TowerCommand, error) {
	var c TowerCommand
	err := scan(&c.ID, &c.FactoryID, &c.Type, &c.Payload, &c.Status, &c.Result,
		&c.CreatedBy, &c.CreatedAt, &c.PulledAt, &c.CompletedAt)
	return c, err
}

func (s *Store) CreateTowerCommand(ctx context.Context, c TowerCommand) (TowerCommand, error) {
	if len(c.Payload) == 0 {
		c.Payload = json.RawMessage(`{}`)
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO tower.command (factory_id, type, payload, created_by)
		VALUES ($1,$2,$3,NULLIF($4,'')) RETURNING command_id::text, status, created_at`,
		c.FactoryID, c.Type, c.Payload, c.CreatedBy,
	).Scan(&c.ID, &c.Status, &c.CreatedAt)
	if err != nil {
		return TowerCommand{}, fmt.Errorf("create tower command: %w", err)
	}
	return c, nil
}

// PullTowerCommands returns queued commands for a factory, marking them pulled
// so a crashing receiver does not re-execute (result reporting closes them).
func (s *Store) PullTowerCommands(ctx context.Context, factoryID string) ([]TowerCommand, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE tower.command SET status='pulled', pulled_at=now()
		WHERE command_id IN (
			SELECT command_id FROM tower.command
			WHERE factory_id=$1 AND status='queued' ORDER BY created_at LIMIT 20
		)
		RETURNING `+commandCols, factoryID)
	if err != nil {
		return nil, fmt.Errorf("pull tower commands: %w", err)
	}
	defer rows.Close()
	out := []TowerCommand{}
	for rows.Next() {
		c, err := scanCommand(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) ListTowerCommands(ctx context.Context, factoryID string, limit int) ([]TowerCommand, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `SELECT `+commandCols+` FROM tower.command
		WHERE factory_id=$1 ORDER BY created_at DESC LIMIT $2`, factoryID, limit)
	if err != nil {
		return nil, fmt.Errorf("list tower commands: %w", err)
	}
	defer rows.Close()
	out := []TowerCommand{}
	for rows.Next() {
		c, err := scanCommand(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CompleteTowerCommand records the factory-reported outcome.
func (s *Store) CompleteTowerCommand(ctx context.Context, id, status, result string) error {
	if status != "done" && status != "failed" && status != "rejected" {
		return fmt.Errorf("invalid command status %q", status)
	}
	ct, err := s.pool.Exec(ctx, `
		UPDATE tower.command SET status=$2, result=$3, completed_at=now() WHERE command_id=$1`,
		id, status, result)
	if err != nil {
		return fmt.Errorf("complete tower command: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("command %s not found", id)
	}
	return nil
}

// --- Metric rollups ---

// IngestRollups stores the metrics carried on a report for cross-site compare.
func (s *Store) IngestRollups(ctx context.Context, factoryID string, metrics map[string]float64) error {
	for metric, value := range metrics {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO tower.metric_rollup (factory_id, metric, value)
			VALUES ($1,$2,$3)
			ON CONFLICT (factory_id, metric, ts) DO UPDATE SET value=EXCLUDED.value`,
			factoryID, metric, value); err != nil {
			return fmt.Errorf("ingest rollup %s/%s: %w", factoryID, metric, err)
		}
	}
	return nil
}

// LatestRollups returns each site's most recent value per metric.
func (s *Store) LatestRollups(ctx context.Context) ([]MetricRollup, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (factory_id, metric) factory_id, metric, ts, COALESCE(value,0)
		FROM tower.metric_rollup ORDER BY factory_id, metric, ts DESC`)
	if err != nil {
		return nil, fmt.Errorf("latest rollups: %w", err)
	}
	defer rows.Close()
	out := []MetricRollup{}
	for rows.Next() {
		var m MetricRollup
		if err := rows.Scan(&m.FactoryID, &m.Metric, &m.Ts, &m.Value); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
