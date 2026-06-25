package http

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// QualityCache memoizes per-dataset completeness scores and computes missing
// ones in the background (bounded concurrency) so the catalog list can show real
// quality without blocking on a scan per row.
type QualityCache struct {
	mu       sync.Mutex
	scores   map[string]cachedScore
	inflight map[string]bool
	ttl      time.Duration
	sem      chan struct{}
}

type cachedScore struct {
	score int
	exp   time.Time
}

// NewQualityCache builds a cache with the given TTL and max concurrent scans.
func NewQualityCache(ttl time.Duration, concurrency int) *QualityCache {
	if concurrency <= 0 {
		concurrency = 6
	}
	return &QualityCache{
		scores:   map[string]cachedScore{},
		inflight: map[string]bool{},
		ttl:      ttl,
		sem:      make(chan struct{}, concurrency),
	}
}

// Get returns a cached score if present and fresh.
func (q *QualityCache) Get(urn string) (int, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	s, ok := q.scores[urn]
	if ok && time.Now().Before(s.exp) {
		return s.score, true
	}
	return 0, false
}

// Set stores a freshly computed score (used to warm the cache from detail views).
func (q *QualityCache) Set(urn string, score int) {
	q.mu.Lock()
	q.scores[urn] = cachedScore{score: score, exp: time.Now().Add(q.ttl)}
	q.mu.Unlock()
}

// Ensure schedules a background computation if the urn isn't cached/in-flight.
func (q *QualityCache) Ensure(urn string, compute func(context.Context) (int, error)) {
	q.mu.Lock()
	if s, ok := q.scores[urn]; ok && time.Now().Before(s.exp) {
		q.mu.Unlock()
		return
	}
	if q.inflight[urn] {
		q.mu.Unlock()
		return
	}
	q.inflight[urn] = true
	q.mu.Unlock()

	go func() {
		q.sem <- struct{}{}
		defer func() { <-q.sem }()
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		score, err := compute(ctx)
		q.mu.Lock()
		delete(q.inflight, urn)
		if err == nil {
			q.scores[urn] = cachedScore{score: score, exp: time.Now().Add(q.ttl)}
		}
		q.mu.Unlock()
	}()
}

// completenessScan computes the average non-null rate (0–100) across the given
// columns from a sampled scan of the table.
func (h *Handlers) completenessScan(ctx context.Context, cat, ns, table string, colNames []string) (int, error) {
	if len(colNames) == 0 {
		return 0, nil
	}
	var sb strings.Builder
	sb.WriteString("SELECT count(*) AS __n")
	for i, c := range colNames {
		fmt.Fprintf(&sb, `, count("%s") AS __c%d`, c, i)
	}
	fmt.Fprintf(&sb, ` FROM (SELECT * FROM %s."%s"."%s" LIMIT 50000) t`, cat, ns, table)
	rs, err := h.Adapters.Trino.Execute(ctx, sb.String())
	if err != nil {
		return 0, err
	}
	if len(rs.Rows) != 1 {
		return 0, nil
	}
	row := rs.Rows[0]
	n := toFloat(row["__n"])
	if n <= 0 {
		return 0, nil
	}
	var sum float64
	for i := range colNames {
		sum += toFloat(row[fmt.Sprintf("__c%d", i)]) / n
	}
	return int(math.Round(sum / float64(len(colNames)) * 100)), nil
}

// computeCompleteness resolves a dataset's columns (information_schema) then
// scans for completeness — used by the cache to fill the catalog list in the bg.
func (h *Handlers) computeCompleteness(ctx context.Context, urn string) (int, error) {
	platform, ns, table := parseDatasetURN(urn)
	cat := trinoCatalog(platform)
	if cat == "" || ns == "" || table == "" {
		return 0, nil
	}
	descSQL := fmt.Sprintf(`SELECT column_name FROM %s.information_schema.columns
		WHERE table_schema = '%s' AND table_name = '%s' ORDER BY ordinal_position`, cat, ns, table)
	rs, err := h.Adapters.Trino.Execute(ctx, descSQL)
	if err != nil {
		return 0, err
	}
	names := make([]string, 0, len(rs.Rows))
	for _, row := range rs.Rows {
		if c := asString(row["column_name"]); c != "" {
			names = append(names, c)
		}
	}
	return h.completenessScan(ctx, cat, ns, table, names)
}
