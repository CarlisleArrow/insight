package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// AiModel is a registered LLM/embedding endpoint (§20.2). JSON tags match the
// front-end AI Models table shape. The raw API key never lands here —
// AuthSecretRef names the K8s Secret / env var read at call time.
type AiModel struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Provider      string   `json:"provider"`
	Endpoint      string   `json:"endpoint"`
	Ref           string   `json:"ref"`
	AuthSecretRef string   `json:"auth_secret_ref,omitempty"`
	Caps          []string `json:"caps"`
	MaxTokens     int      `json:"max_tokens"`
	Tok           string   `json:"tok"`    // display form of MaxTokens
	Deploy        string   `json:"deploy"` // 'external'|'local'
	Enabled       bool     `json:"enabled"`
	Status        string   `json:"status"` // Active|Inactive (from Enabled)
	Default       bool     `json:"default"`
	Tested        string   `json:"tested"` // ISO last_tested or ""
}

const aiModelCols = `model_id::text, name, provider, endpoint, model_ref,
	COALESCE(auth_secret_ref,''), capabilities, COALESCE(max_tokens,0), deployment,
	enabled, is_default, last_tested`

func scanAiModel(scan func(dest ...any) error) (AiModel, error) {
	var m AiModel
	var caps []byte
	var tested *time.Time
	if err := scan(&m.ID, &m.Name, &m.Provider, &m.Endpoint, &m.Ref,
		&m.AuthSecretRef, &caps, &m.MaxTokens, &m.Deploy,
		&m.Enabled, &m.Default, &tested); err != nil {
		return AiModel{}, err
	}
	_ = json.Unmarshal(caps, &m.Caps)
	if m.Caps == nil {
		m.Caps = []string{}
	}
	m.Status = "Inactive"
	if m.Enabled {
		m.Status = "Active"
	}
	if m.MaxTokens > 0 {
		m.Tok = fmt.Sprintf("%d", m.MaxTokens)
	}
	if tested != nil {
		m.Tested = tested.UTC().Format(time.RFC3339)
	}
	return m, nil
}

func (s *Store) ListAiModels(ctx context.Context) ([]AiModel, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+aiModelCols+`
		FROM platform_metadata.ai_model ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("list ai models: %w", err)
	}
	defer rows.Close()
	out := []AiModel{}
	for rows.Next() {
		m, err := scanAiModel(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) GetAiModel(ctx context.Context, id string) (AiModel, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+aiModelCols+`
		FROM platform_metadata.ai_model WHERE model_id=$1`, id)
	m, err := scanAiModel(row.Scan)
	if err != nil {
		return AiModel{}, fmt.Errorf("get ai model %s: %w", id, err)
	}
	return m, nil
}

// DefaultAiModel returns the default enabled model, or the first enabled one.
func (s *Store) DefaultAiModel(ctx context.Context) (AiModel, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+aiModelCols+`
		FROM platform_metadata.ai_model WHERE enabled
		ORDER BY is_default DESC, created_at LIMIT 1`)
	m, err := scanAiModel(row.Scan)
	if err != nil {
		return AiModel{}, fmt.Errorf("default ai model: %w", err)
	}
	return m, nil
}

func (s *Store) CreateAiModel(ctx context.Context, m AiModel) (AiModel, error) {
	caps, _ := json.Marshal(m.Caps)
	if m.Default {
		if err := s.clearDefaultAiModel(ctx); err != nil {
			return AiModel{}, err
		}
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.ai_model
			(name, provider, endpoint, model_ref, auth_secret_ref, capabilities,
			 max_tokens, deployment, enabled, is_default)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		RETURNING model_id::text`,
		m.Name, m.Provider, m.Endpoint, m.Ref, nullable(m.AuthSecretRef), caps,
		m.MaxTokens, m.Deploy, m.Enabled, m.Default,
	).Scan(&m.ID)
	if err != nil {
		return AiModel{}, fmt.Errorf("create ai model: %w", err)
	}
	return m, nil
}

func (s *Store) UpdateAiModel(ctx context.Context, m AiModel) (AiModel, error) {
	caps, _ := json.Marshal(m.Caps)
	if m.Default {
		if err := s.clearDefaultAiModel(ctx); err != nil {
			return AiModel{}, err
		}
	}
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.ai_model
		SET name=$2, provider=$3, endpoint=$4, model_ref=$5, auth_secret_ref=$6,
		    capabilities=$7, max_tokens=$8, deployment=$9, enabled=$10, is_default=$11
		WHERE model_id=$1`,
		m.ID, m.Name, m.Provider, m.Endpoint, m.Ref, nullable(m.AuthSecretRef),
		caps, m.MaxTokens, m.Deploy, m.Enabled, m.Default)
	if err != nil {
		return AiModel{}, fmt.Errorf("update ai model: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return AiModel{}, fmt.Errorf("ai model %s not found", m.ID)
	}
	return m, nil
}

func (s *Store) DeleteAiModel(ctx context.Context, id string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.ai_model WHERE model_id=$1`, id); err != nil {
		return fmt.Errorf("delete ai model: %w", err)
	}
	return nil
}

// TouchAiModelTested stamps last_tested after a successful connectivity probe.
func (s *Store) TouchAiModelTested(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE platform_metadata.ai_model SET last_tested=now() WHERE model_id=$1`, id)
	return err
}

func (s *Store) clearDefaultAiModel(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE platform_metadata.ai_model SET is_default=FALSE WHERE is_default`); err != nil {
		return fmt.Errorf("clear default ai model: %w", err)
	}
	return nil
}

// AiSemantic is one entity's semantic description (§20.4). JSON tags match the
// front-end semantic editor fields.
type AiSemantic struct {
	URN         string `json:"urn"`
	Type        string `json:"type"` // table|metric|field
	NL          string `json:"nl"`
	Caliber     string `json:"caliber"`
	Domain      string `json:"domain"`
	Samples     string `json:"samples"`
	Rels        string `json:"rels"`
	Constraints string `json:"constraints"`
	Sens        string `json:"sens"`
	CB          string `json:"cb"` // embedding status: pend|desc|vec
}

const aiSemCols = `entity_urn, entity_type, COALESCE(nl_description,''),
	COALESCE(business_caliber,''), COALESCE(domain_knowledge,''),
	COALESCE(sample_values,''), COALESCE(relationships,''), COALESCE(constraints,''),
	COALESCE(sensitivity,'Internal'), COALESCE(embedding_status,'pend')`

func scanAiSemantic(scan func(dest ...any) error) (AiSemantic, error) {
	var e AiSemantic
	err := scan(&e.URN, &e.Type, &e.NL, &e.Caliber, &e.Domain,
		&e.Samples, &e.Rels, &e.Constraints, &e.Sens, &e.CB)
	return e, err
}

func (s *Store) ListAiSemantic(ctx context.Context) ([]AiSemantic, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+aiSemCols+`
		FROM platform_metadata.ai_semantic ORDER BY entity_urn`)
	if err != nil {
		return nil, fmt.Errorf("list ai semantic: %w", err)
	}
	defer rows.Close()
	out := []AiSemantic{}
	for rows.Next() {
		e, err := scanAiSemantic(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) GetAiSemantic(ctx context.Context, urn string) (AiSemantic, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+aiSemCols+`
		FROM platform_metadata.ai_semantic WHERE entity_urn=$1`, urn)
	e, err := scanAiSemantic(row.Scan)
	if err != nil {
		return AiSemantic{}, fmt.Errorf("get ai semantic %s: %w", urn, err)
	}
	return e, nil
}

// UpsertAiSemantic writes an entity's semantics. Status moves pend→desc once
// any description exists (vectorization would move it to 'vec').
func (s *Store) UpsertAiSemantic(ctx context.Context, e AiSemantic) (AiSemantic, error) {
	if e.CB == "" {
		e.CB = "pend"
		if e.NL != "" || e.Caliber != "" || e.Domain != "" {
			e.CB = "desc"
		}
	}
	if e.Sens == "" {
		e.Sens = "Internal"
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO platform_metadata.ai_semantic
			(entity_urn, entity_type, nl_description, business_caliber, domain_knowledge,
			 sample_values, relationships, constraints, sensitivity, embedding_status, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
		ON CONFLICT (entity_urn) DO UPDATE SET
			entity_type=EXCLUDED.entity_type, nl_description=EXCLUDED.nl_description,
			business_caliber=EXCLUDED.business_caliber, domain_knowledge=EXCLUDED.domain_knowledge,
			sample_values=EXCLUDED.sample_values, relationships=EXCLUDED.relationships,
			constraints=EXCLUDED.constraints, sensitivity=EXCLUDED.sensitivity,
			embedding_status=EXCLUDED.embedding_status, updated_at=now()`,
		e.URN, e.Type, e.NL, e.Caliber, e.Domain,
		e.Samples, e.Rels, e.Constraints, e.Sens, e.CB)
	if err != nil {
		return AiSemantic{}, fmt.Errorf("upsert ai semantic: %w", err)
	}
	return e, nil
}

// EnsureAiSemantic inserts a pending row only when the urn is unknown — used by
// compile-from-DataHub so it never clobbers human-authored semantics.
func (s *Store) EnsureAiSemantic(ctx context.Context, e AiSemantic) (bool, error) {
	if e.CB == "" {
		e.CB = "pend"
		if e.NL != "" {
			e.CB = "desc"
		}
	}
	if e.Sens == "" {
		e.Sens = "Internal"
	}
	ct, err := s.pool.Exec(ctx, `
		INSERT INTO platform_metadata.ai_semantic
			(entity_urn, entity_type, nl_description, sensitivity, embedding_status)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (entity_urn) DO NOTHING`,
		e.URN, e.Type, e.NL, e.Sens, e.CB)
	if err != nil {
		return false, fmt.Errorf("ensure ai semantic: %w", err)
	}
	return ct.RowsAffected() > 0, nil
}

// SearchAiSemantic is the RAG-lite retrieval (§20.4): rank by naive text match
// over urn + descriptions. Swap for pgvector similarity when available.
func (s *Store) SearchAiSemantic(ctx context.Context, q string, k int) ([]AiSemantic, error) {
	if k <= 0 {
		k = 5
	}
	rows, err := s.pool.Query(ctx, `SELECT `+aiSemCols+`
		FROM platform_metadata.ai_semantic
		WHERE entity_urn ILIKE '%'||$1||'%'
		   OR nl_description ILIKE '%'||$1||'%'
		   OR business_caliber ILIKE '%'||$1||'%'
		   OR domain_knowledge ILIKE '%'||$1||'%'
		ORDER BY (entity_urn ILIKE '%'||$1||'%') DESC, entity_urn
		LIMIT $2`, q, k)
	if err != nil {
		return nil, fmt.Errorf("search ai semantic: %w", err)
	}
	defer rows.Close()
	out := []AiSemantic{}
	for rows.Next() {
		e, err := scanAiSemantic(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
