// Package postgres is the platform_metadata data-access layer (pgx). It owns the
// acl_* tables defined in ARCHITECTURE.md §2.3 and is the control plane's only
// stateful store.
package postgres

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store wraps a pgx pool scoped to platform_metadata.
type Store struct {
	pool *pgxpool.Pool
}

// --- Domain types (mirror §2.3 columns) ---

type Subject struct {
	SubjectID   string `json:"subject_id"`
	KeycloakRef string `json:"keycloak_ref"`
	SubjectType string `json:"subject_type"`
	Description string `json:"description"`
}

type RowPolicy struct {
	PolicyID   string    `json:"policy_id"`
	SubjectID  string    `json:"subject_id"`
	Catalog    string    `json:"catalog"`
	SchemaName string    `json:"schema_name"`
	TableName  string    `json:"table_name"`
	FilterExpr string    `json:"filter_expr"`
	Enabled    bool      `json:"enabled"`
	CreatedAt  time.Time `json:"created_at"`
}

type ColumnPolicy struct {
	PolicyID   string    `json:"policy_id"`
	SubjectID  string    `json:"subject_id"`
	Catalog    string    `json:"catalog"`
	SchemaName string    `json:"schema_name"`
	TableName  string    `json:"table_name"`
	ColumnName string    `json:"column_name"`
	MaskType   string    `json:"mask_type"` // deny|full|partial|hash|none
	MaskExpr   string    `json:"mask_expr"`
	Enabled    bool      `json:"enabled"`
	CreatedAt  time.Time `json:"created_at"`
}

type AuditEntry struct {
	SubjectRef   string
	RawSQL       string
	RewrittenSQL string
	Engine       string
}

// New opens a pool against the given DSN and verifies connectivity.
func New(ctx context.Context, dsn string, maxConns int32) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Ping verifies connectivity to the platform_metadata store (health probe).
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Migrate applies every embedded migration in filename order (idempotent DDL).
func (s *Store) Migrate(ctx context.Context) error {
	entries, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("glob migrations: %w", err)
	}
	sort.Strings(entries)
	for _, name := range entries {
		sqlBytes, err := migrationsFS.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		if _, err := s.pool.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
	}
	return nil
}

// --- Subject helpers ---

// EnsureSubject upserts a subject by keycloak_ref and returns its id. Used when
// a policy is created for a group that has no acl_subject row yet.
func (s *Store) EnsureSubject(ctx context.Context, keycloakRef, subjectType string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		WITH existing AS (
			SELECT subject_id FROM platform_metadata.acl_subject WHERE keycloak_ref = $1
		), ins AS (
			INSERT INTO platform_metadata.acl_subject (keycloak_ref, subject_type)
			SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM existing)
			RETURNING subject_id
		)
		SELECT subject_id FROM ins
		UNION ALL
		SELECT subject_id FROM existing
		LIMIT 1`, keycloakRef, subjectType).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("ensure subject: %w", err)
	}
	return id, nil
}

// SubjectIDsForGroups returns acl_subject ids whose keycloak_ref is in groups.
func (s *Store) SubjectIDsForGroups(ctx context.Context, groups []string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT subject_id FROM platform_metadata.acl_subject WHERE keycloak_ref = ANY($1)`, groups)
	if err != nil {
		return nil, fmt.Errorf("subject ids: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// --- Row policy CRUD ---

func (s *Store) ListRowPolicies(ctx context.Context) ([]RowPolicy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT policy_id, COALESCE(subject_id::text,''), catalog, schema_name, table_name,
		       filter_expr, enabled, created_at
		FROM platform_metadata.acl_row_policy ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list row policies: %w", err)
	}
	defer rows.Close()
	var out []RowPolicy
	for rows.Next() {
		var p RowPolicy
		if err := rows.Scan(&p.PolicyID, &p.SubjectID, &p.Catalog, &p.SchemaName,
			&p.TableName, &p.FilterExpr, &p.Enabled, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) CreateRowPolicy(ctx context.Context, p RowPolicy) (RowPolicy, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.acl_row_policy
			(subject_id, catalog, schema_name, table_name, filter_expr, enabled)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING policy_id, created_at`,
		nullable(p.SubjectID), p.Catalog, p.SchemaName, p.TableName, p.FilterExpr, p.Enabled,
	).Scan(&p.PolicyID, &p.CreatedAt)
	if err != nil {
		return RowPolicy{}, fmt.Errorf("create row policy: %w", err)
	}
	return p, nil
}

// RowPoliciesFor returns enabled row filters for the given subjects on a target.
func (s *Store) RowPoliciesFor(ctx context.Context, subjectIDs []string, catalog, schema, table string) ([]RowPolicy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT policy_id, subject_id::text, catalog, schema_name, table_name, filter_expr, enabled, created_at
		FROM platform_metadata.acl_row_policy
		WHERE enabled AND subject_id = ANY($1)
		  AND catalog=$2 AND schema_name=$3 AND table_name=$4`,
		subjectIDs, catalog, schema, table)
	if err != nil {
		return nil, fmt.Errorf("row policies for: %w", err)
	}
	defer rows.Close()
	var out []RowPolicy
	for rows.Next() {
		var p RowPolicy
		if err := rows.Scan(&p.PolicyID, &p.SubjectID, &p.Catalog, &p.SchemaName,
			&p.TableName, &p.FilterExpr, &p.Enabled, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- Column policy CRUD ---

func (s *Store) ListColumnPolicies(ctx context.Context) ([]ColumnPolicy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT policy_id, COALESCE(subject_id::text,''), catalog, schema_name, table_name,
		       column_name, mask_type, COALESCE(mask_expr,''), enabled, created_at
		FROM platform_metadata.acl_column_policy ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list column policies: %w", err)
	}
	defer rows.Close()
	var out []ColumnPolicy
	for rows.Next() {
		var p ColumnPolicy
		if err := rows.Scan(&p.PolicyID, &p.SubjectID, &p.Catalog, &p.SchemaName, &p.TableName,
			&p.ColumnName, &p.MaskType, &p.MaskExpr, &p.Enabled, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) CreateColumnPolicy(ctx context.Context, p ColumnPolicy) (ColumnPolicy, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.acl_column_policy
			(subject_id, catalog, schema_name, table_name, column_name, mask_type, mask_expr, enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING policy_id, created_at`,
		nullable(p.SubjectID), p.Catalog, p.SchemaName, p.TableName, p.ColumnName,
		p.MaskType, nullable(p.MaskExpr), p.Enabled,
	).Scan(&p.PolicyID, &p.CreatedAt)
	if err != nil {
		return ColumnPolicy{}, fmt.Errorf("create column policy: %w", err)
	}
	return p, nil
}

// ColumnPoliciesFor returns enabled column policies for subjects on a target.
func (s *Store) ColumnPoliciesFor(ctx context.Context, subjectIDs []string, catalog, schema, table string) ([]ColumnPolicy, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT policy_id, subject_id::text, catalog, schema_name, table_name, column_name,
		       mask_type, COALESCE(mask_expr,''), enabled, created_at
		FROM platform_metadata.acl_column_policy
		WHERE enabled AND subject_id = ANY($1)
		  AND catalog=$2 AND schema_name=$3 AND table_name=$4`,
		subjectIDs, catalog, schema, table)
	if err != nil {
		return nil, fmt.Errorf("column policies for: %w", err)
	}
	defer rows.Close()
	var out []ColumnPolicy
	for rows.Next() {
		var p ColumnPolicy
		if err := rows.Scan(&p.PolicyID, &p.SubjectID, &p.Catalog, &p.SchemaName, &p.TableName,
			&p.ColumnName, &p.MaskType, &p.MaskExpr, &p.Enabled, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- Audit ---

// WriteAudit records a data-access decision (§10.2 step 6).
func (s *Store) WriteAudit(ctx context.Context, a AuditEntry) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO platform_metadata.acl_audit (subject_ref, raw_sql, rewritten_sql, engine)
		VALUES ($1,$2,$3,$4)`, a.SubjectRef, a.RawSQL, a.RewrittenSQL, a.Engine)
	if err != nil {
		return fmt.Errorf("write audit: %w", err)
	}
	return nil
}

// nullable converts an empty string to a SQL NULL so optional FKs/text columns
// don't store empty strings.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
