// Package health probes the real liveness of the platform's data-infrastructure
// components so the DevConfig "Data sources" page reflects actual cluster state
// (Connected / Degraded / Error) rather than stored/seeded values. Every status
// is measured at request time via a short-timeout probe.
package health

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Status is one component's measured state, shaped for the front-end data-source
// row ({name,type,host,status,tested}).
type Status struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Host     string `json:"host"`
	Status   string `json:"status"` // Connected | Degraded | Error
	Tested   string `json:"tested"` // latency on success, error reason otherwise
	ReadOnly bool   `json:"readonly"`
}

// kind selects how a target is probed.
type kind int

const (
	kindHTTP kind = iota // GET URL; 2xx/3xx => Connected, other response => Degraded
	kindTCP              // dial host:port
	kindPG               // pgPing callback
)

type target struct {
	name string
	typ  string
	host string // display host:port
	kind kind
	url  string // for kindHTTP
}

// Prober probes a fixed set of platform components plus any ad-hoc host.
type Prober struct {
	http    *http.Client
	targets []target
	pgPing  func(context.Context) error
}

// Config carries the component addresses (from config.Adapters + Postgres).
type Config struct {
	TrinoURL      string
	ClickHouseURL string
	IcebergURL    string
	DebeziumURL   string
	AirflowURL    string
	DataHubURL    string
	PrometheusURL string
	OpenSearchURL string
	MinIOURL      string
	KafkaURL      string // host:port
	PostgresHost  string
	PostgresPort  int
}

// New builds a prober for the platform's core components. pgPing measures the
// control-plane store (platform_metadata) connectivity.
func New(c Config, pgPing func(context.Context) error) *Prober {
	t := []target{}
	add := func(name, typ, rawURL, path string, k kind) {
		if rawURL == "" {
			return
		}
		full := rawURL
		if k == kindHTTP {
			full = strings.TrimRight(rawURL, "/") + path
		}
		t = append(t, target{name: name, typ: typ, host: hostOf(rawURL), kind: k, url: full})
	}
	add("trino", "Trino", c.TrinoURL, "/v1/info", kindHTTP)
	add("clickhouse", "ClickHouse", c.ClickHouseURL, "/ping", kindHTTP)
	add("iceberg-rest-catalog", "Iceberg", c.IcebergURL, "/v1/config", kindHTTP)
	add("debezium-connect", "Debezium", c.DebeziumURL, "/connectors", kindHTTP)
	add("airflow", "Airflow", c.AirflowURL, "/health", kindHTTP)
	add("datahub-gms", "DataHub", c.DataHubURL, "/health", kindHTTP)
	add("prometheus", "Prometheus", c.PrometheusURL, "/-/healthy", kindHTTP)
	add("opensearch", "OpenSearch", c.OpenSearchURL, "/_cluster/health", kindHTTP)
	add("minio", "S3", c.MinIOURL, "/minio/health/live", kindHTTP)

	if c.KafkaURL != "" {
		t = append(t, target{name: "kafka", typ: "Kafka", host: c.KafkaURL, kind: kindTCP, url: c.KafkaURL})
	}
	pgHost := ""
	if c.PostgresHost != "" {
		pgHost = fmt.Sprintf("%s:%d", c.PostgresHost, c.PostgresPort)
		t = append(t, target{name: "postgres", typ: "PostgreSQL", host: pgHost, kind: kindPG})
	}

	return &Prober{
		http:    &http.Client{Timeout: 4 * time.Second},
		targets: t,
		pgPing:  pgPing,
	}
}

// Check probes every component concurrently and returns their live statuses.
func (p *Prober) Check(ctx context.Context) []Status {
	out := make([]Status, len(p.targets))
	var wg sync.WaitGroup
	for i, tg := range p.targets {
		wg.Add(1)
		go func(i int, tg target) {
			defer wg.Done()
			out[i] = p.probe(ctx, tg)
		}(i, tg)
	}
	wg.Wait()
	return out
}

func (p *Prober) probe(ctx context.Context, tg target) Status {
	s := Status{ID: tg.name, Name: tg.name, Type: tg.typ, Host: tg.host, ReadOnly: true}
	start := time.Now()
	var err error
	var degraded bool
	switch tg.kind {
	case kindHTTP:
		degraded, err = p.probeHTTP(ctx, tg.url)
	case kindTCP:
		err = probeTCP(ctx, tg.host)
	case kindPG:
		if p.pgPing != nil {
			err = p.pgPing(ctx)
		}
	}
	ms := time.Since(start).Milliseconds()
	switch {
	case err != nil:
		s.Status = "Error"
		s.Tested = shortErr(err)
	case degraded:
		s.Status = "Degraded"
		s.Tested = fmt.Sprintf("reachable · %dms", ms)
	default:
		s.Status = "Connected"
		s.Tested = fmt.Sprintf("%dms", ms)
	}
	return s
}

// probeHTTP returns (degraded, err). degraded=true means the component answered
// but with a non-success status (alive but unhealthy/forbidden).
func (p *Prober) probeHTTP(ctx context.Context, url string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		return false, nil
	}
	// 401/403 means the service is up but auth-gated — count as reachable.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return true, nil
	}
	return true, nil
}

func probeTCP(ctx context.Context, hostPort string) error {
	d := net.Dialer{Timeout: 4 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", hostPort)
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}

// ProbeHost measures an arbitrary host:port (used for user-registered sources).
func (p *Prober) ProbeHost(ctx context.Context, hostPort string) string {
	if hostPort == "" {
		return "Error"
	}
	if err := probeTCP(ctx, hostPort); err != nil {
		return "Error"
	}
	return "Connected"
}

// hostOf strips the scheme from a URL for display (keeps host:port/path tail).
func hostOf(raw string) string {
	s := raw
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	return strings.TrimRight(s, "/")
}

func shortErr(err error) string {
	m := err.Error()
	switch {
	case strings.Contains(m, "deadline exceeded") || strings.Contains(m, "timeout"):
		return "timeout"
	case strings.Contains(m, "connection refused"):
		return "refused"
	case strings.Contains(m, "no such host"):
		return "dns error"
	default:
		if len(m) > 60 {
			return m[:60]
		}
		return m
	}
}
