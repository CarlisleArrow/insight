// Package opensearch queries OpenSearch (ARCHITECTURE.md §4:
// opensearch-cluster-master.kubesphere-logging-system:9200) for the Ops "logs"
// tab.
package opensearch

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/httpx"
)

type Client struct {
	baseURL string
	index   string
	auth    string // optional "Basic ..." header
	http    *http.Client
}

// New builds the client. index is the log index pattern (e.g. "logstash-*" or
// "ks-logstash-log-*"); authHeader may be "".
func New(baseURL, index, authHeader string) *Client {
	if index == "" {
		index = "ks-logstash-log-*"
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		index:   index,
		auth:    authHeader,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

type searchBody struct {
	Size  int            `json:"size"`
	Sort  []any          `json:"sort"`
	Query map[string]any `json:"query"`
}

type searchResp struct {
	Hits struct {
		Hits []struct {
			Source map[string]any `json:"_source"`
		} `json:"hits"`
	} `json:"hits"`
}

// Search runs a free-text query_string search and maps hits to LogEntry. It is
// tolerant of differing field names across log shippers.
func (c *Client) Search(ctx context.Context, query string, limit int) ([]adapter.LogEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	q := map[string]any{"match_all": map[string]any{}}
	if strings.TrimSpace(query) != "" {
		q = map[string]any{"query_string": map[string]any{"query": query}}
	}
	body := searchBody{
		Size:  limit,
		Sort:  []any{map[string]any{"@timestamp": map[string]any{"order": "desc"}}},
		Query: q,
	}
	var r searchResp
	url := fmt.Sprintf("%s/%s/_search", c.baseURL, c.index)
	hdr := map[string]string{}
	if c.auth != "" {
		hdr["Authorization"] = c.auth
	}
	if err := httpx.Do(ctx, c.http, http.MethodPost, url, hdr, body, &r); err != nil {
		return nil, fmt.Errorf("opensearch search: %w", err)
	}
	out := make([]adapter.LogEntry, 0, len(r.Hits.Hits))
	for _, h := range r.Hits.Hits {
		out = append(out, adapter.LogEntry{
			Time:    str(h.Source, "@timestamp", "time"),
			Level:   str(h.Source, "level", "log.level"),
			Service: str(h.Source, "kubernetes.container_name", "container", "service"),
			Message: str(h.Source, "message", "log", "msg"),
		})
	}
	return out, nil
}

// str returns the first present string field among keys (supports dotted paths).
func str(src map[string]any, keys ...string) string {
	for _, k := range keys {
		if v := lookup(src, k); v != "" {
			return v
		}
	}
	return ""
}

func lookup(src map[string]any, dotted string) string {
	parts := strings.Split(dotted, ".")
	var cur any = src
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		cur = m[p]
	}
	if s, ok := cur.(string); ok {
		return s
	}
	if cur != nil {
		return fmt.Sprintf("%v", cur)
	}
	return ""
}
