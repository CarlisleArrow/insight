package http

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/api/dto"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
)

// allowed aggregation functions / filter operators / sort directions. Anything
// outside these sets is rejected — the client never supplies raw SQL fragments.
var (
	allowedAgg = map[string]bool{"sum": true, "avg": true, "min": true, "max": true, "count": true}
	allowedOp  = map[string]string{
		"=": "=", "!=": "!=", ">": ">", ">=": ">=", "<": "<", "<=": "<=",
		"in": "IN", "like": "LIKE",
	}
)

// QueryBuild — POST /api/query/build. Compiles a structured BuildSpec to SQL
// (validated against the dataset's real schema), then runs it through the same
// gateway as /api/query (routing + masking + audit). Returns rows + chart data.
func (h *Handlers) QueryBuild(w http.ResponseWriter, r *http.Request) {
	claims, _ := auth.FromContext(r.Context())

	var spec dto.BuildSpec
	if err := decodeJSON(r, &spec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	sql, err := h.compileBuildSpec(r.Context(), spec)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	resp, err := h.runQueryOn(r, sql, spec.Dataset, claimsGroups(claims), subjectRef(claims), "trino")
	if err != nil {
		h.Log.Error("query build", "err", err.Error())
		writeError(w, http.StatusBadGateway, "query failed")
		return
	}
	h.Metrics.QueriesTotal.WithLabelValues(resp.Engine).Inc()

	out := dto.BuildResponse{
		Engine:       resp.Engine,
		SQL:          sql,
		RewrittenSQL: resp.RewrittenSQL,
		Result:       resp.Result,
		ChartData:    toChartData(resp.Result, spec),
	}
	writeJSON(w, http.StatusOK, out)
}

// compileBuildSpec validates every identifier against the table's actual schema
// and assembles a parameter-safe SQL string. Returns an error if any column is
// unknown or an agg/op is not whitelisted.
func (h *Handlers) compileBuildSpec(ctx context.Context, s dto.BuildSpec) (string, error) {
	t := s.Dataset
	if t.Schema == "" || t.Table == "" {
		return "", fmt.Errorf("dataset schema and table are required")
	}

	// Resolve the real column set for whitelist validation. Prefer Trino
	// information_schema (covers iceberg/clickhouse/postgres); fall back to the
	// Iceberg REST catalog for iceberg datasets.
	valid := map[string]bool{}
	if cat := trinoCatalog(t.Catalog); cat != "" {
		sql := fmt.Sprintf(`SELECT column_name FROM %s.information_schema.columns
			WHERE table_schema = '%s' AND table_name = '%s'`, cat, t.Schema, t.Table)
		if rs, e := h.Adapters.Trino.Execute(ctx, sql); e == nil {
			for _, row := range rs.Rows {
				if c := asString(row["column_name"]); c != "" {
					valid[strings.ToLower(c)] = true
				}
			}
		}
	}
	if len(valid) == 0 {
		schema, err := h.Adapters.Catalog.GetSchema(ctx, t.Schema, t.Table)
		if err != nil {
			return "", fmt.Errorf("schema unavailable for %s.%s", t.Schema, t.Table)
		}
		for _, c := range schema.Columns {
			valid[strings.ToLower(c.Name)] = true
		}
	}
	checkCol := func(c string) error {
		if !valid[strings.ToLower(c)] {
			return fmt.Errorf("unknown column %q", c)
		}
		return nil
	}

	var selects, groups []string
	for _, d := range s.Dimensions {
		if err := checkCol(d); err != nil {
			return "", err
		}
		selects = append(selects, quoteIdent(d))
		groups = append(groups, quoteIdent(d))
	}
	for _, m := range s.Measures {
		if !allowedAgg[strings.ToLower(m.Agg)] {
			return "", fmt.Errorf("unknown aggregation %q", m.Agg)
		}
		if strings.ToLower(m.Agg) == "count" && (m.Col == "" || m.Col == "*") {
			selects = append(selects, `count(*) AS "count"`)
			continue
		}
		if err := checkCol(m.Col); err != nil {
			return "", err
		}
		alias := strings.ToLower(m.Agg) + "_" + m.Col
		selects = append(selects, fmt.Sprintf(`%s(%s) AS %s`, strings.ToLower(m.Agg), quoteIdent(m.Col), quoteIdent(alias)))
	}
	if len(selects) == 0 {
		selects = append(selects, "*")
	}

	var wheres []string
	for _, f := range s.Filters {
		if err := checkCol(f.Col); err != nil {
			return "", err
		}
		op, ok := allowedOp[strings.ToLower(f.Op)]
		if !ok {
			return "", fmt.Errorf("unknown operator %q", f.Op)
		}
		wheres = append(wheres, fmt.Sprintf("%s %s %s", quoteIdent(f.Col), op, literal(f.Value, op)))
	}

	var orders []string
	for _, o := range s.OrderBy {
		if err := checkCol(o.Col); err != nil {
			return "", err
		}
		dir := "ASC"
		if strings.ToLower(o.Dir) == "desc" {
			dir = "DESC"
		}
		orders = append(orders, quoteIdent(o.Col)+" "+dir)
	}

	// Fully-qualify with the Trino catalog so federation is unambiguous
	// (iceberg.gold_qms.x / clickhouse.qms_gold.x). The builder always executes
	// on Trino — see QueryBuild's runQueryOn(..., EngineTrino).
	cat := trinoCatalog(t.Catalog)
	if cat == "" {
		cat = "iceberg"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "SELECT %s FROM %s.%s.%s", strings.Join(selects, ", "), cat, quoteIdent(t.Schema), quoteIdent(t.Table))
	if len(wheres) > 0 {
		b.WriteString(" WHERE " + strings.Join(wheres, " AND "))
	}
	if len(groups) > 0 && len(s.Measures) > 0 {
		b.WriteString(" GROUP BY " + strings.Join(groups, ", "))
	}
	if len(orders) > 0 {
		b.WriteString(" ORDER BY " + strings.Join(orders, ", "))
	}
	limit := s.Limit
	if limit <= 0 || limit > 10000 {
		limit = 1000
	}
	fmt.Fprintf(&b, " LIMIT %d", limit)
	return b.String(), nil
}

// toChartData maps the result set to multi-series {group,key,value} points.
// Columns are in SELECT order: dimensions first, then measures.
//   - dim[0]          -> key (x axis / slice label)
//   - dim[1] (if any) -> group (series, e.g. grouped bars / multi-line)
//   - measures        -> value; with >1 measure and no 2nd dim, each measure
//     becomes its own series.
func toChartData(rs adapter.ResultSet, s dto.BuildSpec) []dto.ChartPoint {
	cols := rs.Columns
	if len(cols) == 0 {
		return []dto.ChartPoint{}
	}
	nDim := len(s.Dimensions)
	if nDim > len(cols) {
		nDim = len(cols)
	}
	measureCols := cols[nDim:]
	if len(measureCols) == 0 {
		// Raw projection (no measures): first col = key, last col = value.
		keyCol := cols[0].Key
		valCol := cols[len(cols)-1].Key
		out := make([]dto.ChartPoint, 0, len(rs.Rows))
		for _, row := range rs.Rows {
			out = append(out, dto.ChartPoint{Group: "value", Key: asString(row[keyCol]), Value: row[valCol]})
		}
		return out
	}

	keyCol := ""
	if nDim >= 1 {
		keyCol = cols[0].Key
	}
	seriesCol := ""
	if nDim >= 2 {
		seriesCol = cols[1].Key
	}

	out := make([]dto.ChartPoint, 0, len(rs.Rows)*len(measureCols))
	for _, row := range rs.Rows {
		key := ""
		if keyCol != "" {
			key = asString(row[keyCol])
		}
		for _, mc := range measureCols {
			group := mc.Header // measure name is the series by default
			if seriesCol != "" {
				group = asString(row[seriesCol]) // 2nd dimension drives the series
			}
			out = append(out, dto.ChartPoint{Group: group, Key: key, Value: row[mc.Key]})
		}
	}
	return out
}

// quoteIdent double-quotes a SQL identifier (Trino/ClickHouse compatible),
// escaping embedded quotes. Identifiers are already schema-validated.
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// literal renders a filter value as a safe SQL literal. IN takes a list; numbers
// pass through; everything else is single-quoted with quotes escaped.
func literal(v any, op string) string {
	if op == "IN" {
		if arr, ok := v.([]any); ok {
			parts := make([]string, 0, len(arr))
			for _, e := range arr {
				parts = append(parts, sqlScalar(e))
			}
			return "(" + strings.Join(parts, ", ") + ")"
		}
		return "(" + sqlScalar(v) + ")"
	}
	return sqlScalar(v)
}

func sqlScalar(v any) string {
	switch x := v.(type) {
	case float64:
		return fmt.Sprintf("%v", x)
	case int, int64, int32:
		return fmt.Sprintf("%v", x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "NULL"
	default:
		return "'" + strings.ReplaceAll(fmt.Sprintf("%v", x), "'", "''") + "'"
	}
}
