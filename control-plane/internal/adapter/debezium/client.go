// Package debezium is the Kafka-Connect REST client for Debezium connectors
// (ARCHITECTURE.md §4: debezium-connect.data-warehouse:8083, no auth — locked
// by NetworkPolicy §9). Reachable from the BFF via Telepresence / in-cluster DNS.
package debezium

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

// Kafka-Connect wire types.
type connectorPut struct {
	Name   string            `json:"name"`
	Config map[string]string `json:"config"`
}

type connectorStatusResp struct {
	Name      string `json:"name"`
	Connector struct {
		State string `json:"state"`
	} `json:"connector"`
	Tasks []struct {
		State string `json:"state"`
		Trace string `json:"trace,omitempty"`
	} `json:"tasks"`
}

// CreateConnector registers a Debezium connector. Per §5.4 the schema-history
// topic must never expire, so we pin retention on the connector config (the
// connector creates the topic with these settings).
func (c *Client) CreateConnector(ctx context.Context, spec adapter.ConnectorSpec) (adapter.ConnectorID, error) {
	body := connectorPut{Name: spec.Name, Config: buildConfig(spec)}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.baseURL+"/connectors", nil, body, nil); err != nil {
		return "", fmt.Errorf("create connector: %w", err)
	}
	return adapter.ConnectorID(spec.Name), nil
}

// UpdateConnector upserts a connector's config via PUT /connectors/{name}/config
// (idempotent) and returns its refreshed status.
func (c *Client) UpdateConnector(ctx context.Context, id adapter.ConnectorID, spec adapter.ConnectorSpec) (adapter.ConnectorStatus, error) {
	if spec.Name == "" {
		spec.Name = string(id)
	}
	url := fmt.Sprintf("%s/connectors/%s/config", c.baseURL, id)
	if err := httpx.Do(ctx, c.http, http.MethodPut, url, nil, buildConfig(spec), nil); err != nil {
		return adapter.ConnectorStatus{}, fmt.Errorf("update connector: %w", err)
	}
	return c.GetConnectorStatus(ctx, id)
}

// buildConfig assembles the Kafka-Connect config for a Debezium MySQL connector
// (§5.4), pinning the schema-history retention guardrail. Caller-supplied
// spec.Config overrides any default (bootstrap servers, db creds, server id…).
func buildConfig(spec adapter.ConnectorSpec) map[string]string {
	cfg := map[string]string{
		"connector.class":       "io.debezium.connector.mysql.MySqlConnector",
		"topic.prefix":          spec.TopicPrefix,
		"table.include.list":    strings.Join(spec.Tables, ","),
		"snapshot.mode":         "schema_only_recovery",
		"decimal.handling.mode": "double",
		// §5.4 guardrail: schema-history topic must be retained forever.
		"schema.history.internal.kafka.topic":              "schema-changes." + spec.Name,
		"schema.history.internal.producer.retention.ms":    "-1",
		"schema.history.internal.producer.retention.bytes": "-1",
	}
	for k, v := range spec.Config {
		cfg[k] = v
	}
	return cfg
}

func (c *Client) GetConnectorStatus(ctx context.Context, id adapter.ConnectorID) (adapter.ConnectorStatus, error) {
	var s connectorStatusResp
	url := fmt.Sprintf("%s/connectors/%s/status", c.baseURL, id)
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, nil, nil, &s); err != nil {
		return adapter.ConnectorStatus{}, fmt.Errorf("get connector status: %w", err)
	}
	return mapStatus(s), nil
}

func (c *Client) DeleteConnector(ctx context.Context, id adapter.ConnectorID) error {
	url := fmt.Sprintf("%s/connectors/%s", c.baseURL, id)
	if err := httpx.Do(ctx, c.http, http.MethodDelete, url, nil, nil, nil); err != nil {
		return fmt.Errorf("delete connector: %w", err)
	}
	return nil
}

// ListConnectors uses the expand API to get name+status in one round trip.
func (c *Client) ListConnectors(ctx context.Context) ([]adapter.ConnectorStatus, error) {
	var raw map[string]struct {
		Status connectorStatusResp `json:"status"`
		Info   struct {
			Config map[string]string `json:"config"`
		} `json:"info"`
	}
	url := c.baseURL + "/connectors?expand=status&expand=info"
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, nil, nil, &raw); err != nil {
		return nil, fmt.Errorf("list connectors: %w", err)
	}
	out := make([]adapter.ConnectorStatus, 0, len(raw))
	for name, v := range raw {
		cs := mapStatus(v.Status)
		if cs.Name == "" {
			cs.Name = name
		}
		cs.ID = adapter.ConnectorID(name)
		cs.Source = v.Info.Config["database.server.name"]
		if cs.Source == "" {
			cs.Source = v.Info.Config["topic.prefix"]
		}
		cs.Topic = v.Info.Config["topic.prefix"]
		out = append(out, cs)
	}
	return out, nil
}

// mapStatus translates Kafka-Connect state into the front-end ConnectorStatus
// (status + a RAG lag indicator derived from task health).
func mapStatus(s connectorStatusResp) adapter.ConnectorStatus {
	state := "Running"
	lagKind := "green"
	switch strings.ToUpper(s.Connector.State) {
	case "RUNNING":
		state, lagKind = "Running", "green"
	case "PAUSED":
		state, lagKind = "Paused", "amber"
	case "FAILED":
		state, lagKind = "Failed", "red"
	default:
		state, lagKind = s.Connector.State, "amber"
	}
	for _, t := range s.Tasks {
		if strings.ToUpper(t.State) == "FAILED" {
			state, lagKind = "Failed", "red"
		}
	}
	return adapter.ConnectorStatus{
		ID:      adapter.ConnectorID(s.Name),
		Name:    s.Name,
		State:   state,
		Lag:     "—",
		LagKind: lagKind,
	}
}
