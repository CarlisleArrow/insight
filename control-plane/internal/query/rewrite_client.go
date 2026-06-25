package query

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/authz"
)

// RewriteClient calls the L6 SQL-rewrite microservice (§10.3):
// POST /rewrite {sql, dialect, row_filters[], column_policies[]} -> {sql}.
type RewriteClient struct {
	baseURL string
	http    *http.Client
}

func NewRewriteClient(baseURL string, timeout time.Duration) *RewriteClient {
	return &RewriteClient{baseURL: baseURL, http: &http.Client{Timeout: timeout}}
}

type rewriteRequest struct {
	SQL            string                 `json:"sql"`
	Dialect        string                 `json:"dialect"`
	RowFilters     []string               `json:"row_filters"`
	ColumnPolicies []authz.ColumnMaskSpec `json:"column_policies"`
}

type rewriteResponse struct {
	SQL string `json:"sql"`
}

// Rewrite sends the raw SQL plus the resolved policy decision to L6 and returns
// the rewritten SQL (WHERE injected + columns masked).
func (c *RewriteClient) Rewrite(ctx context.Context, sql, dialect string, d authz.Decision) (string, error) {
	// Marshal nil slices as [] (not null) — the L6 FastAPI model types these as
	// list[...] and rejects a JSON null with 422.
	rowFilters := d.RowFilters
	if rowFilters == nil {
		rowFilters = []string{}
	}
	colPolicies := d.ColumnPolicies
	if colPolicies == nil {
		colPolicies = []authz.ColumnMaskSpec{}
	}
	body, err := json.Marshal(rewriteRequest{
		SQL:            sql,
		Dialect:        dialect,
		RowFilters:     rowFilters,
		ColumnPolicies: colPolicies,
	})
	if err != nil {
		return "", fmt.Errorf("marshal rewrite request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/rewrite", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("new rewrite request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("call rewrite: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("rewrite service status %d: %s", resp.StatusCode, string(detail))
	}
	var out rewriteResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode rewrite response: %w", err)
	}
	return out.SQL, nil
}
