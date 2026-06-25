// Package trino is the Trino query client (ARCHITECTURE.md §4, §10.1:
// my-trino-trino.trino:8080, no auth — locked by NetworkPolicy §9). The
// iceberg/clickhouse/postgresql catalogs are pre-configured for federation, so
// this client only executes routed SQL; Trino does the work.
package trino

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/trinodb/trino-go-client/trino" // registers the "trino" driver

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/sqlscan"
)

type Client struct {
	db *sql.DB
}

// New opens a Trino connection. baseURL is like http://my-trino-trino.trino:8080.
// The default catalog is iceberg (the lakehouse query surface); fully-qualified
// names (clickhouse.*, postgresql.*) still work for federation.
func New(baseURL, user string) (*Client, error) {
	if user == "" {
		user = "control-plane"
	}
	// trino-go-client DSN: http://user@host:port?catalog=..&schema=..
	dsn := fmt.Sprintf("%s?catalog=iceberg&schema=gold_qms", injectUser(baseURL, user))
	db, err := sql.Open("trino", dsn)
	if err != nil {
		return nil, fmt.Errorf("open trino: %w", err)
	}
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetMaxOpenConns(10)
	return &Client{db: db}, nil
}

func (c *Client) Engine() string { return "trino" }

func (c *Client) Execute(ctx context.Context, query string) (adapter.ResultSet, error) {
	rows, err := c.db.QueryContext(ctx, query)
	if err != nil {
		return adapter.ResultSet{}, fmt.Errorf("trino query: %w", err)
	}
	defer rows.Close()
	return sqlscan.Scan(rows)
}

func (c *Client) Close() error { return c.db.Close() }

// injectUser turns http://host:port into http://user@host:port.
func injectUser(baseURL, user string) string {
	const httpp = "http://"
	const httpsp = "https://"
	switch {
	case len(baseURL) > len(httpp) && baseURL[:len(httpp)] == httpp:
		return httpp + user + "@" + baseURL[len(httpp):]
	case len(baseURL) > len(httpsp) && baseURL[:len(httpsp)] == httpsp:
		return httpsp + user + "@" + baseURL[len(httpsp):]
	default:
		return baseURL
	}
}
