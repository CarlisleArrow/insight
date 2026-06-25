package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// DataAPI is a published external data endpoint (§15.2). JSONB contract fields
// are carried as raw json.RawMessage so handlers/contract code own their shape.
type DataAPI struct {
	APIID          string          `json:"api_id"`
	Name           string          `json:"name"`
	Version        string          `json:"version"`
	SourceType     string          `json:"source_type"`
	SourceRef      string          `json:"source_ref"`
	AllowedColumns json.RawMessage `json:"allowed_columns"`
	AllowedFilters json.RawMessage `json:"allowed_filters"`
	Pagination     json.RawMessage `json:"pagination,omitempty"`
	SortWhitelist  json.RawMessage `json:"sort_whitelist,omitempty"`
	AuthMode       string          `json:"auth_mode"`
	RateLimitRPM   *int            `json:"rate_limit_rpm,omitempty"`
	DailyQuota     *int            `json:"daily_quota,omitempty"`
	MaxConcurrency *int            `json:"max_concurrency,omitempty"`
	Status         string          `json:"status"`
	Owner          string          `json:"owner"`
	Description    string          `json:"description"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

// DataAPIKey is an API key for an endpoint; only the hash is stored.
type DataAPIKey struct {
	KeyID     string          `json:"key_id"`
	APIID     string          `json:"api_id"`
	Name      string          `json:"name"`
	KeyHash   string          `json:"-"`
	Prefix    string          `json:"prefix"`
	Scopes    json.RawMessage `json:"scopes,omitempty"`
	ExpiresAt *time.Time      `json:"expires_at,omitempty"`
	LastUsed  *time.Time      `json:"last_used,omitempty"`
	Revoked   bool            `json:"revoked"`
	CreatedAt time.Time       `json:"created_at"`
}

func rawOr(j json.RawMessage, def string) json.RawMessage {
	if len(j) == 0 {
		return json.RawMessage(def)
	}
	return j
}

const dataAPICols = `api_id::text, name, version, source_type, source_ref,
	allowed_columns, allowed_filters, COALESCE(pagination,'null'::jsonb),
	COALESCE(sort_whitelist,'null'::jsonb), auth_mode, rate_limit_rpm, daily_quota,
	max_concurrency, status, COALESCE(owner,''), COALESCE(description,''), created_at, updated_at`

func scanDataAPI(row interface {
	Scan(dest ...any) error
}) (DataAPI, error) {
	var a DataAPI
	err := row.Scan(&a.APIID, &a.Name, &a.Version, &a.SourceType, &a.SourceRef,
		&a.AllowedColumns, &a.AllowedFilters, &a.Pagination, &a.SortWhitelist,
		&a.AuthMode, &a.RateLimitRPM, &a.DailyQuota, &a.MaxConcurrency,
		&a.Status, &a.Owner, &a.Description, &a.CreatedAt, &a.UpdatedAt)
	return a, err
}

// ListDataAPIs returns all published-or-draft Data APIs (management view).
func (s *Store) ListDataAPIs(ctx context.Context) ([]DataAPI, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+dataAPICols+` FROM platform_metadata.data_api ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list data_api: %w", err)
	}
	defer rows.Close()
	out := []DataAPI{}
	for rows.Next() {
		a, err := scanDataAPI(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetDataAPI fetches one by id.
func (s *Store) GetDataAPI(ctx context.Context, id string) (DataAPI, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+dataAPICols+` FROM platform_metadata.data_api WHERE api_id=$1`, id)
	return scanDataAPI(row)
}

// GetPublishedDataAPIByName resolves an external request's <name> to a PUBLISHED
// endpoint (the external router only serves published ones).
func (s *Store) GetPublishedDataAPIByName(ctx context.Context, name string) (DataAPI, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+dataAPICols+`
		FROM platform_metadata.data_api WHERE name=$1 AND status='published'`, name)
	return scanDataAPI(row)
}

// CreateDataAPI inserts a new endpoint (status defaults to draft).
func (s *Store) CreateDataAPI(ctx context.Context, a DataAPI) (DataAPI, error) {
	if a.Version == "" {
		a.Version = "v1"
	}
	if a.AuthMode == "" {
		a.AuthMode = "none"
	}
	if a.Status == "" {
		a.Status = "draft"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.data_api
			(name, version, source_type, source_ref, allowed_columns, allowed_filters,
			 pagination, sort_whitelist, auth_mode, rate_limit_rpm, daily_quota,
			 max_concurrency, status, owner, description)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		RETURNING api_id::text, created_at, updated_at`,
		a.Name, a.Version, a.SourceType, a.SourceRef,
		rawOr(a.AllowedColumns, "[]"), rawOr(a.AllowedFilters, "[]"),
		nullableJSON(a.Pagination), nullableJSON(a.SortWhitelist), a.AuthMode,
		a.RateLimitRPM, a.DailyQuota, a.MaxConcurrency, a.Status,
		nullable(a.Owner), nullable(a.Description),
	).Scan(&a.APIID, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return DataAPI{}, fmt.Errorf("create data_api: %w", err)
	}
	return a, nil
}

// UpdateDataAPI replaces the mutable fields of an endpoint.
func (s *Store) UpdateDataAPI(ctx context.Context, a DataAPI) (DataAPI, error) {
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.data_api SET
			name=$2, version=$3, source_type=$4, source_ref=$5,
			allowed_columns=$6, allowed_filters=$7, pagination=$8, sort_whitelist=$9,
			auth_mode=$10, rate_limit_rpm=$11, daily_quota=$12, max_concurrency=$13,
			status=$14, owner=$15, description=$16, updated_at=now()
		WHERE api_id=$1`,
		a.APIID, a.Name, a.Version, a.SourceType, a.SourceRef,
		rawOr(a.AllowedColumns, "[]"), rawOr(a.AllowedFilters, "[]"),
		nullableJSON(a.Pagination), nullableJSON(a.SortWhitelist), a.AuthMode,
		a.RateLimitRPM, a.DailyQuota, a.MaxConcurrency, a.Status,
		nullable(a.Owner), nullable(a.Description))
	if err != nil {
		return DataAPI{}, fmt.Errorf("update data_api: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return DataAPI{}, fmt.Errorf("data_api %s not found", a.APIID)
	}
	return s.GetDataAPI(ctx, a.APIID)
}

// SetDataAPIStatus flips an endpoint's lifecycle status (publish/deprecate).
func (s *Store) SetDataAPIStatus(ctx context.Context, id, status string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE platform_metadata.data_api SET status=$2, updated_at=now() WHERE api_id=$1`, id, status)
	return err
}

// DeleteDataAPI removes an endpoint (keys cascade).
func (s *Store) DeleteDataAPI(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.data_api WHERE api_id=$1`, id)
	return err
}

// --- API keys ---

// ListDataAPIKeys returns an endpoint's keys (hash never returned).
func (s *Store) ListDataAPIKeys(ctx context.Context, apiID string) ([]DataAPIKey, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT key_id::text, api_id::text, COALESCE(name,''), COALESCE(prefix,''),
		       COALESCE(scopes,'null'::jsonb), expires_at, last_used, revoked, created_at
		FROM platform_metadata.data_api_key WHERE api_id=$1 ORDER BY created_at DESC`, apiID)
	if err != nil {
		return nil, fmt.Errorf("list keys: %w", err)
	}
	defer rows.Close()
	out := []DataAPIKey{}
	for rows.Next() {
		var k DataAPIKey
		if err := rows.Scan(&k.KeyID, &k.APIID, &k.Name, &k.Prefix, &k.Scopes,
			&k.ExpiresAt, &k.LastUsed, &k.Revoked, &k.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// CreateDataAPIKey stores the hash and returns the row (raw key handled by caller).
func (s *Store) CreateDataAPIKey(ctx context.Context, k DataAPIKey) (DataAPIKey, error) {
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.data_api_key (api_id, name, key_hash, prefix, scopes, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING key_id::text, created_at`,
		k.APIID, nullable(k.Name), k.KeyHash, nullable(k.Prefix), nullableJSON(k.Scopes), k.ExpiresAt,
	).Scan(&k.KeyID, &k.CreatedAt)
	if err != nil {
		return DataAPIKey{}, fmt.Errorf("create key: %w", err)
	}
	return k, nil
}

// DeleteDataAPIKey revokes (hard-deletes) a key.
func (s *Store) DeleteDataAPIKey(ctx context.Context, keyID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.data_api_key WHERE key_id=$1`, keyID)
	return err
}

// MatchAPIKey validates a presented key hash against an endpoint's active keys
// and bumps last_used. Returns true when a non-revoked, non-expired key matches.
func (s *Store) MatchAPIKey(ctx context.Context, apiID, keyHash string) (bool, error) {
	var keyID string
	err := s.pool.QueryRow(ctx, `
		SELECT key_id::text FROM platform_metadata.data_api_key
		WHERE api_id=$1 AND key_hash=$2 AND revoked=FALSE
		  AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, apiID, keyHash).Scan(&keyID)
	if err != nil {
		return false, nil // no match (sql.ErrNoRows) or error → treat as no match
	}
	_, _ = s.pool.Exec(ctx, `UPDATE platform_metadata.data_api_key SET last_used=now() WHERE key_id=$1`, keyID)
	return true, nil
}

// WriteAPIAudit records an external Data API call (reuses acl_audit + api/caller).
func (s *Store) WriteAPIAudit(ctx context.Context, apiID, caller, rawSQL, rewritten, engine string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO platform_metadata.acl_audit (subject_ref, raw_sql, rewritten_sql, engine, api_id, caller)
		VALUES ($1,$2,$3,$4,$5,$6)`, "data-api:"+caller, rawSQL, rewritten, engine, nullable(apiID), nullable(caller))
	return err
}

// nullableJSON returns NULL for empty/`null` JSON so optional JSONB cols are clean.
func nullableJSON(j json.RawMessage) any {
	if len(j) == 0 || string(j) == "null" {
		return nil
	}
	return []byte(j)
}
