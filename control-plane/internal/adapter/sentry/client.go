// Package sentry queries Sentry (ARCHITECTURE.md §4: my-sentry-web.sentry:80)
// for the Ops "errors" tab. Uses a bearer auth token (CP_SENTRY_TOKEN).
package sentry

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
	token   string
	org     string
	project string
	http    *http.Client
}

// New builds the client. org/project default to "ipas" when empty.
func New(baseURL, token, org, project string) *Client {
	if org == "" {
		org = "ipas"
	}
	if project == "" {
		project = "ipas"
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		org:     org,
		project: project,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

type issue struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Culprit  string `json:"culprit"`
	Level    string `json:"level"`
	Count    string `json:"count"`
	LastSeen string `json:"lastSeen"`
}

// ListIssues returns the most recent unresolved issues for the project.
func (c *Client) ListIssues(ctx context.Context, limit int) ([]adapter.ErrorIssue, error) {
	if limit <= 0 {
		limit = 25
	}
	var issues []issue
	url := fmt.Sprintf("%s/api/0/projects/%s/%s/issues/?query=is:unresolved&limit=%d",
		c.baseURL, c.org, c.project, limit)
	hdr := map[string]string{}
	if c.token != "" {
		hdr["Authorization"] = "Bearer " + c.token
	}
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, hdr, nil, &issues); err != nil {
		return nil, fmt.Errorf("sentry issues: %w", err)
	}
	out := make([]adapter.ErrorIssue, 0, len(issues))
	for _, i := range issues {
		out = append(out, adapter.ErrorIssue{
			ID: i.ID, Title: i.Title, Culprit: i.Culprit,
			Level: i.Level, Count: i.Count, LastSeen: i.LastSeen,
		})
	}
	return out, nil
}
