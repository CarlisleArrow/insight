// Package adapter defines the typed boundaries between the control-plane BFF and
// the heterogeneous downstream stack (ARCHITECTURE.md §8). The front-end never
// calls a component directly; everything goes through these interfaces using
// platform service accounts. Each interface has a real client implementation in
// a sibling package (debezium, airflow, iceberg, trino, clickhouse, datahub,
// prometheus, opensearch, sentry, admin, k8s).
package adapter

import "context"

// --- Ingest (Debezium / Kafka Connect) ---

type ConnectorID string

type ConnectorSpec struct {
	Name        string            `json:"name"`
	Source      string            `json:"source"`
	TopicPrefix string            `json:"topic_prefix"`
	Tables      []string          `json:"tables"`
	Config      map[string]string `json:"config"`
}

type ConnectorStatus struct {
	ID      ConnectorID `json:"id"`
	Name    string      `json:"name"`
	Source  string      `json:"src"`
	Topic   string      `json:"topic"`
	State   string      `json:"status"` // Running|Failed|Paused
	Lag     string      `json:"lag"`
	LagKind string      `json:"lagKind"` // green|amber|red (front-end tag)
}

type IngestAdapter interface {
	CreateConnector(ctx context.Context, spec ConnectorSpec) (ConnectorID, error)
	UpdateConnector(ctx context.Context, id ConnectorID, spec ConnectorSpec) (ConnectorStatus, error)
	GetConnectorStatus(ctx context.Context, id ConnectorID) (ConnectorStatus, error)
	DeleteConnector(ctx context.Context, id ConnectorID) error
	ListConnectors(ctx context.Context) ([]ConnectorStatus, error)
}

// --- Orchestration (Airflow / Spark) ---

type (
	DAGID string
	RunID string
)

type DAGSpec struct {
	Name     string   `json:"name"`
	Schedule string   `json:"schedule"`
	Tables   []string `json:"tables"`
}

// RunStatus mirrors the front-end Monitoring "runs" row shape
// ({id,dag,task,start,dur,status}) so handlers can return it directly.
type RunStatus struct {
	ID     string `json:"id"`
	DAG    string `json:"dag"`
	Task   string `json:"task"`
	Start  string `json:"start"`
	Dur    string `json:"dur"`
	Status string `json:"status"` // Success|Running|Failed|Retrying|Queued
}

// DAGTask is one task node in a DAG graph, with its downstream edges and the
// status of the latest run's task instance.
type DAGTask struct {
	ID         string   `json:"id"`
	Label      string   `json:"label"`
	Status     string   `json:"status"` // success|running|queued|failed (front-end node colors)
	Downstream []string `json:"downstream"`
}

// DAGGraph is the task dependency graph + recent run states for the ETL DAG view.
type DAGGraph struct {
	DAGID      string    `json:"dag_id"`
	Schedule   string    `json:"schedule"`
	Tasks      []DAGTask `json:"tasks"`
	RecentRuns []string  `json:"recent_runs"` // newest-last state strings (success|failed|running)
}

type OrchestrationAdapter interface {
	EnsureDAG(ctx context.Context, spec DAGSpec) (DAGID, error)
	TriggerDAG(ctx context.Context, id DAGID, conf map[string]any) (RunID, error)
	GetRunStatus(ctx context.Context, id DAGID, run RunID) (RunStatus, error)
	Backfill(ctx context.Context, id DAGID, from, to string) (RunID, error)
	// ListRuns returns recent task-instance runs across DAGs (Monitoring page).
	ListRuns(ctx context.Context, limit int) ([]RunStatus, error)
	// PauseDAG toggles a DAG's paused state (DevConfig ETL toolbar).
	PauseDAG(ctx context.Context, id DAGID, paused bool) error
	// GetDAG returns the task graph + recent run states. Empty dagID picks the
	// first IPAS pipeline DAG.
	GetDAG(ctx context.Context, dagID string) (DAGGraph, error)
	// ListDAGIDs returns known DAG ids (used to resolve a default).
	ListDAGIDs(ctx context.Context) ([]string, error)
}

// --- Catalog (Iceberg REST) ---

type ColumnMeta struct {
	Name string `json:"col"`
	Type string `json:"type"`
	Desc string `json:"desc,omitempty"`
}

type Schema struct {
	Columns []ColumnMeta `json:"columns"`
}

type TableMeta struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Layer     string `json:"layer"` // Bronze|Silver|Gold
}

type CatalogAdapter interface {
	ListNamespaces(ctx context.Context) ([]string, error)
	ListTables(ctx context.Context, ns string) ([]TableMeta, error)
	GetSchema(ctx context.Context, ns, table string) (Schema, error)
	CreateTable(ctx context.Context, ns string, schema Schema) error
}

// --- Query engines (Trino / ClickHouse) ---

type Column struct {
	Key    string `json:"key"`
	Header string `json:"header"`
}

// ResultSet matches the front-end QUERY_RESULTS shape (columns + row maps).
type ResultSet struct {
	Columns []Column         `json:"columns"`
	Rows    []map[string]any `json:"rows"`
}

type QueryAdapter interface {
	Engine() string // "trino" | "clickhouse"
	Execute(ctx context.Context, sql string) (ResultSet, error)
}

// --- Metadata hub (DataHub GMS) ---

type Asset struct {
	URN   string `json:"urn"`
	Name  string `json:"name"`
	Layer string `json:"layer"`
	Desc  string `json:"desc"`
	Owner string `json:"owner"`
	Score int    `json:"score"`
	Sens  string `json:"sens"`
}

type LineageNode struct {
	URN   string `json:"urn"`
	Label string `json:"label"`
}

type LineageGraph struct {
	Nodes []LineageNode `json:"nodes"`
	Edges [][2]string   `json:"edges"`
}

// FacetOption is one value bucket within a facet group (label + count).
type FacetOption struct {
	Label string `json:"l"`
	Count int    `json:"n"`
}

// Facet is one catalog facet group (front-end CATALOG_FACETS shape).
type Facet struct {
	Title   string        `json:"title"`
	Options []FacetOption `json:"opts"`
}

// GlossaryTerm is a DataHub business-glossary term mapped to the front-end
// "metric" shape (Data Modeling → Metrics store).
type GlossaryTerm struct {
	URN     string `json:"urn"`
	Name    string `json:"name"`
	Def     string `json:"def"`     // term description / business definition
	Formula string `json:"formula"` // customProperties.formula
	Unit    string `json:"unit"`    // customProperties.unit
	Owner   string `json:"owner"`
	Status  string `json:"status"` // customProperties.status (Certified/Review/Draft)
	Source  string `json:"source"` // customProperties.source_dataset
}

type MetadataAdapter interface {
	Search(ctx context.Context, q string) ([]Asset, error)
	GetLineage(ctx context.Context, urn string) (LineageGraph, error)
	UpsertStatus(ctx context.Context, urn string, status any) error
	// Facets returns aggregated catalog facets (domain/layer/sensitivity/owner).
	Facets(ctx context.Context, q string) ([]Facet, error)
	// ListGlossaryTerms returns business-glossary terms (Metrics store source).
	ListGlossaryTerms(ctx context.Context) ([]GlossaryTerm, error)
	// GetDatasetSchema reads a dataset's column schema (schemaMetadata aspect) by
	// urn — works across platforms (Iceberg/ClickHouse/Postgres).
	GetDatasetSchema(ctx context.Context, urn string) ([]ColumnMeta, error)
}

// --- Observability: metrics (Prometheus) ---

// MetricSample is one labelled metric point.
type MetricSample struct {
	Metric string  `json:"metric"`
	Value  float64 `json:"value"`
	Time   string  `json:"time"`
}

// MetricPoint is one (time, value) sample in a range series.
type MetricPoint struct {
	Time  string  `json:"key"` // HH:MM label (front-end chart x-axis "key")
	Value float64 `json:"value"`
}

// MetricSeries is a labelled time series returned by a range query.
type MetricSeries struct {
	Metric string        `json:"group"` // front-end chart "group"
	Points []MetricPoint `json:"points"`
}

type MetricsAdapter interface {
	// Query runs an instant PromQL query.
	Query(ctx context.Context, promql string) ([]MetricSample, error)
	// QueryRange runs a PromQL range query over the last `minutes` at `stepSec`.
	QueryRange(ctx context.Context, promql string, minutes, stepSec int) ([]MetricSeries, error)
}

// --- Observability: logs (OpenSearch) ---

// LogEntry mirrors the front-end ELK log line shape.
type LogEntry struct {
	Time    string `json:"time"`
	Level   string `json:"level"`
	Service string `json:"service"`
	Message string `json:"message"`
}

type LogsAdapter interface {
	Search(ctx context.Context, query string, limit int) ([]LogEntry, error)
}

// --- Observability: errors (Sentry) ---

type ErrorIssue struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Culprit  string `json:"culprit"`
	Level    string `json:"level"`
	Count    string `json:"count"`
	LastSeen string `json:"last_seen"`
}

type ErrorsAdapter interface {
	ListIssues(ctx context.Context, limit int) ([]ErrorIssue, error)
}

// --- Admin: Keycloak users (read-only, §11) ---

type AdminUser struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Role     string `json:"role"`
	Org      string `json:"org"`
	Status   string `json:"status"` // Active|Suspended|Invited
	Username string `json:"username,omitempty"`
}

// UserSession is one active Keycloak session (Profile "security & sessions").
type UserSession struct {
	ID       string `json:"id"`
	IP       string `json:"ip"`
	Started  string `json:"started"`
	LastSeen string `json:"last_seen"`
	Clients  string `json:"clients"`
}

type AdminAdapter interface {
	ListUsers(ctx context.Context) ([]AdminUser, error)
	// GetUser returns one realm user by username (Personal center /api/me).
	GetUser(ctx context.Context, username string) (AdminUser, error)
	// CreateUser/UpdateUser/DeleteUser manage realm users via the Keycloak Admin
	// API. On LDAP-federated read-only realms these may return an error, which is
	// surfaced rather than faked.
	CreateUser(ctx context.Context, u AdminUser) (AdminUser, error)
	UpdateUser(ctx context.Context, username string, u AdminUser) error
	DeleteUser(ctx context.Context, username string) error
	// ListSessions returns a user's active sessions; DeleteSession revokes one.
	ListSessions(ctx context.Context, username string) ([]UserSession, error)
	DeleteSession(ctx context.Context, sessionID string) error
}

// --- Cluster ops (client-go) ---

type NetworkPolicySpec struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

type PodStatus struct {
	Name  string `json:"name"`
	Phase string `json:"phase"`
}

type K8sAdapter interface {
	ApplyNetworkPolicy(ctx context.Context, np NetworkPolicySpec) error
	PodStatus(ctx context.Context, ns, labelSelector string) ([]PodStatus, error)
}

// --- Pipeline aggregate (GET /api/pipelines/{id}) ---

// PipelineDetail combines a connector's status with its recent DAG runs.
type PipelineDetail struct {
	Connector ConnectorStatus `json:"connector"`
	Runs      []RunStatus     `json:"runs"`
}

// Set bundles every real adapter the BFF depends on, assembled once in main.
type Set struct {
	Ingest   IngestAdapter
	Orch     OrchestrationAdapter
	Catalog  CatalogAdapter
	Trino    QueryAdapter
	CH       QueryAdapter
	Metadata MetadataAdapter
	Metrics  MetricsAdapter
	Logs     LogsAdapter
	Errors   ErrorsAdapter
	Admin    AdminAdapter
	K8s      K8sAdapter
}
