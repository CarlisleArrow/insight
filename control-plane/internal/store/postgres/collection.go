package postgres

import (
	"context"
	"encoding/json"
	"fmt"
)

// Doc is one loosely-typed front-end row stored in platform_metadata.collection.
// The server owns "id"; every other field comes from the front-end shape.
type Doc = map[string]any

// ListDocs returns all rows of a collection (newest first), each with its
// server id merged into the document as "id".
func (s *Store) ListDocs(ctx context.Context, collection string) ([]Doc, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, doc FROM platform_metadata.collection
		WHERE collection = $1 ORDER BY created_at DESC`, collection)
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", collection, err)
	}
	defer rows.Close()
	out := []Doc{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		doc := Doc{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &doc); err != nil {
				return nil, err
			}
		}
		doc["id"] = id
		out = append(out, doc)
	}
	return out, rows.Err()
}

// ListDocsForTenant returns a collection's rows visible to a tenant (§2 logical
// scoping): rows owned by the tenant plus shared rows (tenant_id IS NULL, e.g.
// pre-tenancy data). An empty tenant disables scoping (returns all rows).
func (s *Store) ListDocsForTenant(ctx context.Context, collection, tenant string) ([]Doc, error) {
	if tenant == "" {
		return s.ListDocs(ctx, collection)
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, doc FROM platform_metadata.collection
		WHERE collection = $1 AND (tenant_id IS NULL OR tenant_id::text = $2)
		ORDER BY created_at DESC`, collection, tenant)
	if err != nil {
		return nil, fmt.Errorf("list %s (tenant): %w", collection, err)
	}
	defer rows.Close()
	out := []Doc{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		doc := Doc{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &doc); err != nil {
				return nil, err
			}
		}
		doc["id"] = id
		out = append(out, doc)
	}
	return out, rows.Err()
}

// CreateDocForTenant inserts a new row owned by the given tenant (§2). An empty
// tenant stores a shared (global) row, equivalent to CreateDoc.
func (s *Store) CreateDocForTenant(ctx context.Context, collection string, doc Doc, tenant string) (Doc, error) {
	if tenant == "" {
		return s.CreateDoc(ctx, collection, doc)
	}
	delete(doc, "id")
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	var id string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.collection (collection, doc, tenant_id)
		VALUES ($1, $2, $3) RETURNING id::text`, collection, raw, tenant).Scan(&id); err != nil {
		return nil, fmt.Errorf("create %s (tenant): %w", collection, err)
	}
	doc["id"] = id
	return doc, nil
}

// GetDoc returns a single row by id (with "id" merged), or an error if absent.
func (s *Store) GetDoc(ctx context.Context, collection, id string) (Doc, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx,
		`SELECT doc FROM platform_metadata.collection WHERE collection=$1 AND id=$2`,
		collection, id).Scan(&raw)
	if err != nil {
		return nil, fmt.Errorf("get %s/%s: %w", collection, id, err)
	}
	doc := Doc{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, err
		}
	}
	doc["id"] = id
	return doc, nil
}

// CreateDoc inserts a new row. Any client-supplied "id" is ignored; the server
// assigns one and returns the stored document including it.
func (s *Store) CreateDoc(ctx context.Context, collection string, doc Doc) (Doc, error) {
	delete(doc, "id")
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	var id string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.collection (collection, doc)
		VALUES ($1, $2) RETURNING id::text`, collection, raw).Scan(&id); err != nil {
		return nil, fmt.Errorf("create %s: %w", collection, err)
	}
	doc["id"] = id
	return doc, nil
}

// UpdateDoc replaces a row's document (merging is the caller's concern). The
// stored "id" is preserved regardless of the body.
func (s *Store) UpdateDoc(ctx context.Context, collection, id string, doc Doc) (Doc, error) {
	delete(doc, "id")
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.collection SET doc=$3, updated_at=now()
		WHERE collection=$1 AND id=$2`, collection, id, raw)
	if err != nil {
		return nil, fmt.Errorf("update %s: %w", collection, err)
	}
	if ct.RowsAffected() == 0 {
		return nil, fmt.Errorf("%s %s not found", collection, id)
	}
	doc["id"] = id
	return doc, nil
}

// PatchDoc merges the given fields into an existing row's document. Used for
// targeted updates like marking a notification read.
func (s *Store) PatchDoc(ctx context.Context, collection, id string, patch Doc) (Doc, error) {
	cur, err := s.GetDoc(ctx, collection, id)
	if err != nil {
		return nil, err
	}
	for k, v := range patch {
		if k == "id" {
			continue
		}
		cur[k] = v
	}
	return s.UpdateDoc(ctx, collection, id, cur)
}

// PatchAll merges the given fields into every row of a collection (e.g. mark all
// notifications read). Returns the number of rows affected.
func (s *Store) PatchAll(ctx context.Context, collection string, patch Doc) (int64, error) {
	raw, err := json.Marshal(patch)
	if err != nil {
		return 0, fmt.Errorf("marshal: %w", err)
	}
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.collection SET doc = doc || $2::jsonb, updated_at=now()
		WHERE collection=$1`, collection, raw)
	if err != nil {
		return 0, fmt.Errorf("patch all %s: %w", collection, err)
	}
	return ct.RowsAffected(), nil
}

// DeleteDoc removes a row. Deleting an absent row is not an error.
func (s *Store) DeleteDoc(ctx context.Context, collection, id string) error {
	if _, err := s.pool.Exec(ctx,
		`DELETE FROM platform_metadata.collection WHERE collection=$1 AND id=$2`,
		collection, id); err != nil {
		return fmt.Errorf("delete %s/%s: %w", collection, id, err)
	}
	return nil
}

// CountDocs returns the row count of a collection (used by the overview KPIs).
func (s *Store) CountDocs(ctx context.Context, collection string) (int, error) {
	var n int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM platform_metadata.collection WHERE collection=$1`,
		collection).Scan(&n); err != nil {
		return 0, fmt.Errorf("count %s: %w", collection, err)
	}
	return n, nil
}

// --- Audit read (acl_audit, §2.3) — exposed to the Admin audit-log page ---

// AuditRow is one access decision mapped to the front-end audit-log columns.
type AuditRow struct {
	ID     string `json:"id"`
	Time   string `json:"time"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Target string `json:"target"`
	Res    string `json:"res"`
}

// UsageByTable returns a daily count of queries that referenced the given table
// name (from the acl_audit trail) — the real "queries over time" for an asset.
func (s *Store) UsageByTable(ctx context.Context, table string) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(decided_at,'MM-DD') AS d, count(*) AS n
		FROM platform_metadata.acl_audit
		WHERE raw_sql ILIKE '%'||$1||'%' OR rewritten_sql ILIKE '%'||$1||'%'
		GROUP BY d ORDER BY d`, table)
	if err != nil {
		return nil, fmt.Errorf("usage by table: %w", err)
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"group": "Queries", "key": d, "value": n})
	}
	return out, rows.Err()
}

// ListAudit returns recent acl_audit rows (newest first) for the Admin page.
func (s *Store) ListAudit(ctx context.Context, limit int) ([]AuditRow, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `
		SELECT audit_id::text, to_char(decided_at,'YYYY-MM-DD HH24:MI:SS'),
		       COALESCE(subject_ref,''), COALESCE(engine,'')
		FROM platform_metadata.acl_audit ORDER BY decided_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list audit: %w", err)
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var a AuditRow
		var engine string
		if err := rows.Scan(&a.ID, &a.Time, &a.Actor, &engine); err != nil {
			return nil, err
		}
		a.Action = "query.execute"
		a.Target = engine
		a.Res = "OK"
		out = append(out, a)
	}
	return out, rows.Err()
}
