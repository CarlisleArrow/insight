// Package clickhouse is the ClickHouse query client (ARCHITECTURE.md §4, §10.1:
// clickhouse-service.default:8123 HTTP / :9000 native). Serves the hot/report
// path (mirror of Iceberg gold_qms). Use a dedicated cp user (§12.3), not the
// empty default.
package clickhouse

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/sqlscan"
)

type Client struct {
	db *sql.DB
}

// New opens a ClickHouse connection from the configured URL (http://host:8123 or
// clickhouse://host:9000). HTTP scheme selects the HTTP protocol; otherwise
// native. Credentials come from the cp-clickhouse Secret.
func New(rawURL, user, password, database string) (*Client, error) {
	if database == "" {
		database = "default"
	}
	addr, httpProto, err := parseAddr(rawURL)
	if err != nil {
		return nil, err
	}
	proto := clickhouse.Native
	if httpProto {
		proto = clickhouse.HTTP
	}
	db := clickhouse.OpenDB(&clickhouse.Options{
		Addr:     []string{addr},
		Protocol: proto,
		Auth: clickhouse.Auth{
			Database: database,
			Username: user,
			Password: password,
		},
		DialTimeout: 10 * time.Second,
	})
	db.SetMaxOpenConns(10)
	db.SetConnMaxIdleTime(5 * time.Minute)
	return &Client{db: db}, nil
}

func (c *Client) Engine() string { return "clickhouse" }

func (c *Client) Execute(ctx context.Context, query string) (adapter.ResultSet, error) {
	rows, err := c.db.QueryContext(ctx, query)
	if err != nil {
		return adapter.ResultSet{}, fmt.Errorf("clickhouse query: %w", err)
	}
	defer rows.Close()
	return sqlscan.Scan(rows)
}

func (c *Client) Close() error { return c.db.Close() }

// parseAddr extracts host:port and whether the HTTP protocol should be used.
func parseAddr(rawURL string) (string, bool, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", false, fmt.Errorf("parse clickhouse url: %w", err)
	}
	host := u.Host
	if host == "" { // rawURL was "host:port" without scheme
		host = rawURL
	}
	httpProto := strings.HasPrefix(u.Scheme, "http")
	return host, httpProto, nil
}
