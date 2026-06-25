// Package query implements the BFF query gateway: engine routing (§10.1) and the
// L6 rewrite client (§10.2/§10.3). PG is never a query surface (§5.5) — routing
// is only ClickHouse-vs-Trino.
package query

import (
	"regexp"
	"strings"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// Engine identifiers.
const (
	EngineClickHouse = "clickhouse"
	EngineTrino      = "trino"
)

// gold report/aggregate tables already mirrored into ClickHouse (§5.5, §6.3).
// A hot-path point-lookup/aggregation over these routes to ClickHouse; anything
// else (bronze/silver detail, large scans, federation) routes to Trino.
var aggKeywords = regexp.MustCompile(`(?i)\b(count|sum|avg|min|max|group\s+by)\b`)

// Router picks an execution engine per the §10.1 rule. The choice is invisible
// to the front-end, which only calls POST /api/query.
type Router struct {
	trino adapter.QueryAdapter
	ch    adapter.QueryAdapter
}

func NewRouter(trino, ch adapter.QueryAdapter) *Router {
	return &Router{trino: trino, ch: ch}
}

// Route returns the engine name and adapter for the given SQL.
//
//	IF query targets a Gold report/aggregate mirrored in ClickHouse
//	   AND is an aggregation/point-lookup        -> ClickHouse
//	ELSE (Iceberg detail, large scans, federation) -> Trino
func (r *Router) Route(sql string) (string, adapter.QueryAdapter) {
	lower := strings.ToLower(sql)
	hitsGold := strings.Contains(lower, "gold_qms") || strings.Contains(lower, "gold.") ||
		strings.Contains(lower, "agg_") || strings.Contains(lower, "spc_")
	isAgg := aggKeywords.MatchString(sql)

	if hitsGold && isAgg {
		return EngineClickHouse, r.ch
	}
	return EngineTrino, r.trino
}

// ForEngine returns the adapter for an explicit engine name, bypassing the
// keyword routing (used when the caller already knows the target engine, e.g.
// the visual builder which fully-qualifies tables for Trino federation).
func (r *Router) ForEngine(engine string) (string, adapter.QueryAdapter) {
	if engine == EngineClickHouse {
		return EngineClickHouse, r.ch
	}
	return EngineTrino, r.trino
}

// DialectFor maps an engine to the sqlglot dialect name used by L6.
func DialectFor(engine string) string {
	if engine == EngineClickHouse {
		return "clickhouse"
	}
	return "trino"
}
