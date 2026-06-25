// Package iceberg is the Iceberg REST catalog client (ARCHITECTURE.md §4, §5.3.1:
// iceberg-rest-catalog.data-warehouse:8181, PG-JDBC backend — authoritative for
// schema/table listing). Namespaces of interest: bronze_qms/silver_qms/gold_qms.
package iceberg

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
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{Timeout: 15 * time.Second}}
}

type namespacesResp struct {
	Namespaces [][]string `json:"namespaces"`
}

func (c *Client) ListNamespaces(ctx context.Context) ([]string, error) {
	var r namespacesResp
	if err := httpx.Do(ctx, c.http, http.MethodGet, c.baseURL+"/v1/namespaces", nil, nil, &r); err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}
	out := make([]string, 0, len(r.Namespaces))
	for _, ns := range r.Namespaces {
		out = append(out, strings.Join(ns, "."))
	}
	return out, nil
}

type tablesResp struct {
	Identifiers []struct {
		Namespace []string `json:"namespace"`
		Name      string   `json:"name"`
	} `json:"identifiers"`
}

func (c *Client) ListTables(ctx context.Context, ns string) ([]adapter.TableMeta, error) {
	var r tablesResp
	url := fmt.Sprintf("%s/v1/namespaces/%s/tables", c.baseURL, ns)
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, nil, nil, &r); err != nil {
		return nil, fmt.Errorf("list tables: %w", err)
	}
	layer := layerFor(ns)
	out := make([]adapter.TableMeta, 0, len(r.Identifiers))
	for _, id := range r.Identifiers {
		out = append(out, adapter.TableMeta{Namespace: ns, Name: id.Name, Layer: layer})
	}
	return out, nil
}

type loadTableResp struct {
	Metadata struct {
		CurrentSchemaID int `json:"current-schema-id"`
		Schemas         []struct {
			SchemaID int `json:"schema-id"`
			Fields   []struct {
				Name string `json:"name"`
				Type any    `json:"type"`
				Doc  string `json:"doc"`
			} `json:"fields"`
		} `json:"schemas"`
	} `json:"metadata"`
}

func (c *Client) GetSchema(ctx context.Context, ns, table string) (adapter.Schema, error) {
	var r loadTableResp
	url := fmt.Sprintf("%s/v1/namespaces/%s/tables/%s", c.baseURL, ns, table)
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, nil, nil, &r); err != nil {
		return adapter.Schema{}, fmt.Errorf("get schema: %w", err)
	}
	// Prefer the current schema; fall back to the first.
	var fields []struct {
		Name string `json:"name"`
		Type any    `json:"type"`
		Doc  string `json:"doc"`
	}
	for _, s := range r.Metadata.Schemas {
		if s.SchemaID == r.Metadata.CurrentSchemaID {
			fields = s.Fields
			break
		}
	}
	if fields == nil && len(r.Metadata.Schemas) > 0 {
		fields = r.Metadata.Schemas[0].Fields
	}
	cols := make([]adapter.ColumnMeta, 0, len(fields))
	for _, f := range fields {
		cols = append(cols, adapter.ColumnMeta{Name: f.Name, Type: typeStr(f.Type), Desc: f.Doc})
	}
	return adapter.Schema{Columns: cols}, nil
}

type createTableReq struct {
	Name   string `json:"name"`
	Schema struct {
		Type   string  `json:"type"`
		Fields []field `json:"fields"`
	} `json:"schema"`
}

type field struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Type     string `json:"type"`
}

// CreateTable registers table metadata in the REST catalog (metadata-only; the
// actual data write is script-side per §8). Name is taken from schema columns.
func (c *Client) CreateTable(ctx context.Context, ns string, schema adapter.Schema) error {
	// The table name is conventionally carried as the first column's table; here
	// callers pass it via a synthetic first column "__table__". Keep it simple:
	// require at least one column and name the table after the namespace caller.
	if len(schema.Columns) == 0 {
		return fmt.Errorf("create table: empty schema")
	}
	req := createTableReq{Name: schema.Columns[0].Name}
	req.Schema.Type = "struct"
	for i, col := range schema.Columns {
		req.Schema.Fields = append(req.Schema.Fields, field{
			ID: i + 1, Name: col.Name, Required: false, Type: orDefault(col.Type, "string"),
		})
	}
	url := fmt.Sprintf("%s/v1/namespaces/%s/tables", c.baseURL, ns)
	if err := httpx.Do(ctx, c.http, http.MethodPost, url, nil, req, nil); err != nil {
		return fmt.Errorf("create table: %w", err)
	}
	return nil
}

func layerFor(ns string) string {
	switch {
	case strings.HasPrefix(ns, "gold"):
		return "Gold"
	case strings.HasPrefix(ns, "silver"):
		return "Silver"
	default:
		return "Bronze"
	}
}

// typeStr renders an Iceberg field type, which is a string for primitives or a
// nested object for list/map/struct.
func typeStr(t any) string {
	switch v := t.(type) {
	case string:
		return v
	case map[string]any:
		if s, ok := v["type"].(string); ok {
			return s
		}
		return "complex"
	default:
		return fmt.Sprintf("%v", v)
	}
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
