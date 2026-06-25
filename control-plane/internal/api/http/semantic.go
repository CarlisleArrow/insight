package http

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// Semantic model types (front-end SemanticModeler shape).
type semColumn struct {
	Name string `json:"name"`
	Key  bool   `json:"key"`
	PK   bool   `json:"pk"`
	Type string `json:"type"` // PK | FK | str | num | date | bool
}

type semTable struct {
	ID    string      `json:"id"`
	Title string      `json:"title"`
	Fact  bool        `json:"fact"`
	Rows  []semColumn `json:"rows"`
}

type semJoin struct {
	From      string `json:"from"`      // fact table id
	To        string `json:"to"`        // dim table id
	FromField string `json:"fromField"` // FK column
	ToField   string `json:"toField"`   // dim PK column
}

// SemanticModel — GET /api/semantic-model. Builds the real star schema for the
// silver layer from live information_schema: fact tables (Iceberg silver_qms)
// joined to dimension tables (PostgreSQL silver) by their *_key / *_sk columns.
// Nothing is hardcoded — tables, columns and joins come from the catalogs.
func (h *Handlers) SemanticModel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tables := map[string]*semTable{}

	// Facts live in Iceberg silver_qms.
	factSQL := `SELECT table_name, column_name, data_type
		FROM iceberg.information_schema.columns
		WHERE table_schema = 'silver_qms' AND table_name LIKE 'fact_%'
		ORDER BY table_name, ordinal_position`
	if rs, err := h.Adapters.Trino.Execute(ctx, factSQL); err != nil {
		h.Log.Error("semantic facts", "err", err.Error())
	} else {
		collectTables(tables, rs, true)
	}

	// Dimensions live in PostgreSQL silver (Trino postgresql catalog).
	dimSQL := `SELECT table_name, column_name, data_type
		FROM postgresql.information_schema.columns
		WHERE table_schema = 'silver' AND table_name LIKE 'dim_%'
		ORDER BY table_name, ordinal_position`
	if rs, err := h.Adapters.Trino.Execute(ctx, dimSQL); err != nil {
		h.Log.Warn("semantic dims", "err", err.Error())
	} else {
		collectTables(tables, rs, false)
	}

	// Stable, sorted table list.
	ids := make([]string, 0, len(tables))
	for id := range tables {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]semTable, 0, len(ids))
	for _, id := range ids {
		out = append(out, *tables[id])
	}

	joins := inferJoins(out)
	writeJSON(w, http.StatusOK, map[string]any{"tables": out, "joins": joins})
}

// collectTables folds an information_schema result set into the table map,
// classifying each column's role (PK/FK/scalar) from naming + data type.
func collectTables(dst map[string]*semTable, rs adapter.ResultSet, fact bool) {
	for _, row := range rs.Rows {
		table := asString(row["table_name"])
		col := asString(row["column_name"])
		dtype := asString(row["data_type"])
		if table == "" || col == "" {
			continue
		}
		t, ok := dst[table]
		if !ok {
			t = &semTable{ID: table, Title: table, Fact: fact}
			dst[table] = t
		}
		t.Rows = append(t.Rows, classifyColumn(col, dtype, fact))
	}
}

// classifyColumn maps a column to the front-end row shape. Surrogate keys
// (*_sk) and the date/time dimension keys are PKs on dims; *_key columns on
// facts are FKs.
func classifyColumn(name, dtype string, fact bool) semColumn {
	lc := strings.ToLower(name)
	switch {
	case !fact && (strings.HasSuffix(lc, "_sk") || lc == "date_key" || lc == "time_key"):
		return semColumn{Name: name, Key: true, PK: true, Type: "PK"}
	case fact && strings.HasSuffix(lc, "_key"):
		return semColumn{Name: name, Key: true, Type: "FK"}
	default:
		return semColumn{Name: name, Type: scalarType(dtype)}
	}
}

func scalarType(dtype string) string {
	d := strings.ToLower(dtype)
	switch {
	case strings.Contains(d, "char") || strings.Contains(d, "text"):
		return "str"
	case strings.Contains(d, "int") || strings.Contains(d, "decimal") ||
		strings.Contains(d, "double") || strings.Contains(d, "real") || strings.Contains(d, "numeric"):
		return "num"
	case strings.Contains(d, "date") || strings.Contains(d, "time"):
		return "date"
	case strings.Contains(d, "bool"):
		return "bool"
	default:
		return "str"
	}
}

// inferJoins links each fact FK (<root>_key) to the dimension table whose PK is
// <root>_sk or <root>_key (e.g. process_key -> dim_processes.process_sk,
// date_key -> dim_date.date_key).
func inferJoins(tables []semTable) []semJoin {
	dims := map[string]semTable{}
	for _, t := range tables {
		if !t.Fact {
			dims[t.ID] = t
		}
	}
	joins := []semJoin{}
	for _, t := range tables {
		if !t.Fact {
			continue
		}
		for _, c := range t.Rows {
			if c.Type != "FK" {
				continue
			}
			root := strings.TrimSuffix(strings.ToLower(c.Name), "_key")
			for did, d := range dims {
				if to := matchDimPK(d, root); to != "" {
					joins = append(joins, semJoin{From: t.ID, To: did, FromField: c.Name, ToField: to})
					break
				}
			}
		}
	}
	return joins
}

// matchDimPK returns the dim's PK column matching <root>_sk or <root>_key.
func matchDimPK(d semTable, root string) string {
	want := map[string]bool{root + "_sk": true, root + "_key": true}
	for _, c := range d.Rows {
		if c.PK && want[strings.ToLower(c.Name)] {
			return c.Name
		}
	}
	return ""
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}
