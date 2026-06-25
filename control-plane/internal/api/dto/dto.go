// Package dto holds request/response payloads for the BFF HTTP surface (§11).
package dto

import (
	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// TargetRef identifies the dataset a query/policy applies to. The front-end
// supplies it explicitly so the BFF need not parse SQL to resolve policy.
type TargetRef struct {
	Catalog string `json:"catalog"` // iceberg | clickhouse
	Schema  string `json:"schema"`  // e.g. gold_qms
	Table   string `json:"table"`
}

// QueryRequest is POST /api/query.
type QueryRequest struct {
	SQL    string    `json:"sql"`
	Target TargetRef `json:"target"`
}

// QueryResponse returns the engine chosen + the (masked) result set.
type QueryResponse struct {
	Engine       string            `json:"engine"`
	RewrittenSQL string            `json:"rewritten_sql"`
	Result       adapter.ResultSet `json:"result"`
}

// PreviewRequest is POST /api/policies/preview — run a query "as" the given
// groups to see what a subject would receive (§2.3 audit / §11).
type PreviewRequest struct {
	SQL    string    `json:"sql"`
	Target TargetRef `json:"target"`
	Groups []string  `json:"groups"`
}

// --- Visual query builder (POST /api/query/build) ---

// Measure is an aggregated column (agg ∈ sum|avg|min|max|count).
type Measure struct {
	Col string `json:"col"`
	Agg string `json:"agg"`
}

// Filter is a WHERE predicate (op ∈ =|!=|>|>=|<|<=|in|like).
type Filter struct {
	Col   string `json:"col"`
	Op    string `json:"op"`
	Value any    `json:"value"`
}

// OrderBy is a sort term (dir ∈ asc|desc).
type OrderBy struct {
	Col string `json:"col"`
	Dir string `json:"dir"`
}

// BuildSpec is a structured query the BFF compiles to SQL (validated against the
// dataset's real schema — no free-form SQL from the client).
type BuildSpec struct {
	Dataset    TargetRef `json:"dataset"`
	Dimensions []string  `json:"dimensions"`
	Measures   []Measure `json:"measures"`
	Filters    []Filter  `json:"filters"`
	OrderBy    []OrderBy `json:"orderBy"`
	Limit      int       `json:"limit"`
}

// ChartPoint is one {group,key,value} datum for the front-end charts.
type ChartPoint struct {
	Group string `json:"group"`
	Key   string `json:"key"`
	Value any    `json:"value"`
}

// BuildResponse extends QueryResponse with chart-ready data + the compiled SQL.
type BuildResponse struct {
	Engine       string            `json:"engine"`
	SQL          string            `json:"sql"`
	RewrittenSQL string            `json:"rewritten_sql"`
	Result       adapter.ResultSet `json:"result"`
	ChartData    []ChartPoint      `json:"chartData"`
}

// RowPolicyRequest is POST /api/policies/row.
type RowPolicyRequest struct {
	KeycloakRef string `json:"keycloak_ref"` // group this applies to
	Catalog     string `json:"catalog"`
	Schema      string `json:"schema"`
	Table       string `json:"table"`
	FilterExpr  string `json:"filter_expr"`
	Enabled     *bool  `json:"enabled"`
}

// ColumnPolicyRequest is POST /api/policies/column.
type ColumnPolicyRequest struct {
	KeycloakRef string `json:"keycloak_ref"`
	Catalog     string `json:"catalog"`
	Schema      string `json:"schema"`
	Table       string `json:"table"`
	Column      string `json:"column"`
	MaskType    string `json:"mask_type"` // deny|full|partial|hash|none
	MaskExpr    string `json:"mask_expr"`
	Enabled     *bool  `json:"enabled"`
}
