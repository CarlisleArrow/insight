package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// --- Modeling-as-Code IR (§16.4) ---

type DwmModel struct {
	ModelID   string    `json:"model_id"`
	Name      string    `json:"name"`
	Domain    string    `json:"domain"`
	Status    string    `json:"status"`
	Owner     string    `json:"owner"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type DwmTable struct {
	TableID        string          `json:"table_id"`
	ModelID        string          `json:"model_id"`
	Name           string          `json:"name"`
	Layer          string          `json:"layer"`      // bronze|silver|gold
	TableType      string          `json:"table_type"` // dim|fact|agg
	TargetNS       string          `json:"target_ns"`
	ScdType        string          `json:"scd_type"`
	SourceRef      string          `json:"source_ref"`
	PartitionSpec  json.RawMessage `json:"partition_spec,omitempty"`
	WriteMode      string          `json:"write_mode"`
	HasCustomLogic bool            `json:"has_custom_logic"`
	Columns        []DwmColumn     `json:"columns,omitempty"`
}

type DwmColumn struct {
	ColumnID   string `json:"column_id"`
	TableID    string `json:"table_id"`
	Name       string `json:"name"`
	Dtype      string `json:"dtype"`
	SourceExpr string `json:"source_expr"`
	Role       string `json:"role"`
	Scd2Track  bool   `json:"scd2_track"`
	AggFunc    string `json:"agg_func"`
}

type DwmRelationship struct {
	RelID       string `json:"rel_id"`
	ModelID     string `json:"model_id"`
	FactTableID string `json:"fact_table_id"`
	DimTableID  string `json:"dim_table_id"`
	FactFK      string `json:"fact_fk"`
	DimPK       string `json:"dim_pk"`
}

// FullModel is a model with all its tables (incl columns) and relationships —
// the complete IR the code generator consumes.
type FullModel struct {
	Model         DwmModel          `json:"model"`
	Tables        []DwmTable        `json:"tables"`
	Relationships []DwmRelationship `json:"relationships"`
}

// --- Model CRUD ---

func (s *Store) ListModels(ctx context.Context) ([]DwmModel, error) {
	rows, err := s.pool.Query(ctx, `SELECT model_id::text, name, COALESCE(domain,''), status, COALESCE(owner,''), created_at, updated_at
		FROM platform_metadata.dwm_model ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list models: %w", err)
	}
	defer rows.Close()
	out := []DwmModel{}
	for rows.Next() {
		var m DwmModel
		if err := rows.Scan(&m.ModelID, &m.Name, &m.Domain, &m.Status, &m.Owner, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) CreateModel(ctx context.Context, m DwmModel) (DwmModel, error) {
	if m.Status == "" {
		m.Status = "draft"
	}
	err := s.pool.QueryRow(ctx, `INSERT INTO platform_metadata.dwm_model (name, domain, status, owner)
		VALUES ($1,$2,$3,$4) RETURNING model_id::text, created_at, updated_at`,
		m.Name, nullable(m.Domain), m.Status, nullable(m.Owner)).Scan(&m.ModelID, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return DwmModel{}, fmt.Errorf("create model: %w", err)
	}
	return m, nil
}

func (s *Store) SetModelStatus(ctx context.Context, id, status string) error {
	_, err := s.pool.Exec(ctx, `UPDATE platform_metadata.dwm_model SET status=$2, updated_at=now() WHERE model_id=$1`, id, status)
	return err
}

func (s *Store) DeleteModel(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.dwm_model WHERE model_id=$1`, id)
	return err
}

// --- Table / Column / Relationship upsert (replace-set per model) ---

func (s *Store) UpsertTable(ctx context.Context, t DwmTable) (DwmTable, error) {
	err := s.pool.QueryRow(ctx, `INSERT INTO platform_metadata.dwm_table
		(model_id, name, layer, table_type, target_ns, scd_type, source_ref, partition_spec, write_mode, has_custom_logic)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING table_id::text`,
		t.ModelID, t.Name, t.Layer, t.TableType, t.TargetNS, nullable(t.ScdType), nullable(t.SourceRef),
		nullableJSON(t.PartitionSpec), nullable(t.WriteMode), t.HasCustomLogic).Scan(&t.TableID)
	if err != nil {
		return DwmTable{}, fmt.Errorf("upsert table: %w", err)
	}
	for i := range t.Columns {
		t.Columns[i].TableID = t.TableID
		if _, err := s.pool.Exec(ctx, `INSERT INTO platform_metadata.dwm_column
			(table_id, name, dtype, source_expr, role, scd2_track, agg_func)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			t.TableID, t.Columns[i].Name, t.Columns[i].Dtype, nullable(t.Columns[i].SourceExpr),
			nullable(t.Columns[i].Role), t.Columns[i].Scd2Track, nullable(t.Columns[i].AggFunc)); err != nil {
			return DwmTable{}, fmt.Errorf("insert column: %w", err)
		}
	}
	return t, nil
}

func (s *Store) AddRelationship(ctx context.Context, rel DwmRelationship) (DwmRelationship, error) {
	err := s.pool.QueryRow(ctx, `INSERT INTO platform_metadata.dwm_relationship
		(model_id, fact_table_id, dim_table_id, fact_fk, dim_pk) VALUES ($1,$2,$3,$4,$5) RETURNING rel_id::text`,
		rel.ModelID, rel.FactTableID, rel.DimTableID, rel.FactFK, rel.DimPK).Scan(&rel.RelID)
	if err != nil {
		return DwmRelationship{}, fmt.Errorf("add relationship: %w", err)
	}
	return rel, nil
}

// LoadFullModel reads the complete IR (model + tables + columns + rels).
func (s *Store) LoadFullModel(ctx context.Context, modelID string) (FullModel, error) {
	var fm FullModel
	err := s.pool.QueryRow(ctx, `SELECT model_id::text, name, COALESCE(domain,''), status, COALESCE(owner,''), created_at, updated_at
		FROM platform_metadata.dwm_model WHERE model_id=$1`, modelID).Scan(
		&fm.Model.ModelID, &fm.Model.Name, &fm.Model.Domain, &fm.Model.Status, &fm.Model.Owner, &fm.Model.CreatedAt, &fm.Model.UpdatedAt)
	if err != nil {
		return fm, fmt.Errorf("load model: %w", err)
	}

	trows, err := s.pool.Query(ctx, `SELECT table_id::text, name, layer, table_type, target_ns,
		COALESCE(scd_type,''), COALESCE(source_ref,''), COALESCE(partition_spec,'null'::jsonb),
		COALESCE(write_mode,''), has_custom_logic
		FROM platform_metadata.dwm_table WHERE model_id=$1 ORDER BY name`, modelID)
	if err != nil {
		return fm, fmt.Errorf("load tables: %w", err)
	}
	defer trows.Close()
	for trows.Next() {
		var t DwmTable
		t.ModelID = modelID
		if err := trows.Scan(&t.TableID, &t.Name, &t.Layer, &t.TableType, &t.TargetNS,
			&t.ScdType, &t.SourceRef, &t.PartitionSpec, &t.WriteMode, &t.HasCustomLogic); err != nil {
			return fm, err
		}
		fm.Tables = append(fm.Tables, t)
	}
	if err := trows.Err(); err != nil {
		return fm, err
	}

	for i := range fm.Tables {
		crows, err := s.pool.Query(ctx, `SELECT column_id::text, name, dtype, COALESCE(source_expr,''),
			COALESCE(role,''), scd2_track, COALESCE(agg_func,'')
			FROM platform_metadata.dwm_column WHERE table_id=$1`, fm.Tables[i].TableID)
		if err != nil {
			return fm, fmt.Errorf("load columns: %w", err)
		}
		for crows.Next() {
			var c DwmColumn
			c.TableID = fm.Tables[i].TableID
			if err := crows.Scan(&c.ColumnID, &c.Name, &c.Dtype, &c.SourceExpr, &c.Role, &c.Scd2Track, &c.AggFunc); err != nil {
				crows.Close()
				return fm, err
			}
			fm.Tables[i].Columns = append(fm.Tables[i].Columns, c)
		}
		crows.Close()
	}

	rrows, err := s.pool.Query(ctx, `SELECT rel_id::text, fact_table_id::text, dim_table_id::text,
		COALESCE(fact_fk,''), COALESCE(dim_pk,'') FROM platform_metadata.dwm_relationship WHERE model_id=$1`, modelID)
	if err != nil {
		return fm, fmt.Errorf("load relationships: %w", err)
	}
	defer rrows.Close()
	for rrows.Next() {
		var rel DwmRelationship
		rel.ModelID = modelID
		if err := rrows.Scan(&rel.RelID, &rel.FactTableID, &rel.DimTableID, &rel.FactFK, &rel.DimPK); err != nil {
			return fm, err
		}
		fm.Relationships = append(fm.Relationships, rel)
	}
	return fm, rrows.Err()
}

// ClearModelTables removes a model's tables/relationships (re-model = replace).
func (s *Store) ClearModelTables(ctx context.Context, modelID string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.dwm_relationship WHERE model_id=$1`, modelID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.dwm_table WHERE model_id=$1`, modelID)
	return err
}
