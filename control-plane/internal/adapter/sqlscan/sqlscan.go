// Package sqlscan converts database/sql rows into the front-end ResultSet shape
// (columns + row maps). Shared by the Trino and ClickHouse query adapters.
package sqlscan

import (
	"database/sql"
	"fmt"
	"strconv"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// Scan reads all rows into an adapter.ResultSet. Each row gets a synthetic "id"
// (the front-end CarbonTable keys on it).
func Scan(rows *sql.Rows) (adapter.ResultSet, error) {
	cols, err := rows.Columns()
	if err != nil {
		return adapter.ResultSet{}, fmt.Errorf("columns: %w", err)
	}
	rs := adapter.ResultSet{Columns: make([]adapter.Column, 0, len(cols)), Rows: []map[string]any{}}
	for _, c := range cols {
		rs.Columns = append(rs.Columns, adapter.Column{Key: c, Header: c})
	}
	idx := 0
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return adapter.ResultSet{}, fmt.Errorf("scan row: %w", err)
		}
		m := map[string]any{"id": strconv.Itoa(idx)}
		for i, c := range cols {
			m[c] = normalize(vals[i])
		}
		rs.Rows = append(rs.Rows, m)
		idx++
	}
	return rs, rows.Err()
}

// normalize makes values JSON-friendly: []byte -> string, time -> RFC3339.
func normalize(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.Format(time.RFC3339)
	default:
		return v
	}
}
