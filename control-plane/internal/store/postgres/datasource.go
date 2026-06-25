package postgres

import (
	"context"
	"fmt"
)

// DataSource is a registered connection (DevConfig "Data sources" page). Shape
// matches the front-end `sources` collection.
type DataSource struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Type   string `json:"type"`
	Host   string `json:"host"`
	Status string `json:"status"`
	Tested string `json:"tested"`
}

func (s *Store) ListDataSources(ctx context.Context) ([]DataSource, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, type, host, status, COALESCE(tested,'')
		FROM platform_metadata.datasource ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list datasources: %w", err)
	}
	defer rows.Close()
	out := []DataSource{}
	for rows.Next() {
		var d DataSource
		if err := rows.Scan(&d.ID, &d.Name, &d.Type, &d.Host, &d.Status, &d.Tested); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) CreateDataSource(ctx context.Context, d DataSource) (DataSource, error) {
	if d.Status == "" {
		d.Status = "Connected"
	}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO platform_metadata.datasource (name, type, host, status, tested)
		VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
		d.Name, d.Type, d.Host, d.Status, nullable(d.Tested),
	).Scan(&d.ID)
	if err != nil {
		return DataSource{}, fmt.Errorf("create datasource: %w", err)
	}
	return d, nil
}

func (s *Store) UpdateDataSource(ctx context.Context, d DataSource) (DataSource, error) {
	ct, err := s.pool.Exec(ctx, `
		UPDATE platform_metadata.datasource
		SET name=$2, type=$3, host=$4, status=$5, tested=$6 WHERE id=$1`,
		d.ID, d.Name, d.Type, d.Host, d.Status, nullable(d.Tested))
	if err != nil {
		return DataSource{}, fmt.Errorf("update datasource: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return DataSource{}, fmt.Errorf("datasource %s not found", d.ID)
	}
	return d, nil
}

func (s *Store) DeleteDataSource(ctx context.Context, id string) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM platform_metadata.datasource WHERE id=$1`, id); err != nil {
		return fmt.Errorf("delete datasource: %w", err)
	}
	return nil
}
