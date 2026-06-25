// Package conntest performs REAL credentialed connectivity tests for the
// DevConfig "Test connection" button — it actually opens a connection with the
// supplied username/password and runs a trivial probe (Ping / SELECT 1 / broker
// metadata), then closes it. Credentials are used only for the test and never
// stored. Every driver here is pure-Go (no CGO / Oracle Instant Client).
package conntest

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	ch "github.com/ClickHouse/clickhouse-go/v2"
	_ "github.com/go-sql-driver/mysql"  // mysql driver
	_ "github.com/jackc/pgx/v5/stdlib"  // postgres database/sql driver
	_ "github.com/microsoft/go-mssqldb" // sqlserver driver
	"github.com/segmentio/kafka-go"
	_ "github.com/sijms/go-ora/v2" // oracle driver (pure Go)
	_ "github.com/trinodb/trino-go-client/trino"
)

// Spec is the connection under test. Password is transient (never persisted).
type Spec struct {
	Type     string `json:"type"`
	Host     string `json:"host"`
	Port     string `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// Result is the outcome shown by the front-end.
type Result struct {
	Status  string `json:"status"` // Connected | Error
	Ms      int64  `json:"ms"`
	Message string `json:"message"` // detail on success/failure
}

const timeout = 8 * time.Second

// Test opens a real connection per the spec's type and probes it.
func Test(ctx context.Context, s Spec) Result {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	err := dial(ctx, s)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		return Result{Status: "Error", Ms: ms, Message: short(err)}
	}
	return Result{Status: "Connected", Ms: ms, Message: "authenticated"}
}

func dial(ctx context.Context, s Spec) error {
	hp := hostPort(s)
	switch strings.ToLower(s.Type) {
	case "postgresql", "postgres":
		return pingSQL(ctx, "pgx", fmt.Sprintf("postgres://%s:%s@%s/%s?sslmode=disable&connect_timeout=8",
			url.QueryEscape(s.Username), url.QueryEscape(s.Password), hp, s.Database))
	case "mysql":
		return pingSQL(ctx, "mysql", fmt.Sprintf("%s:%s@tcp(%s)/%s?timeout=8s",
			s.Username, s.Password, hp, s.Database))
	case "sql server", "sqlserver", "mssql":
		return pingSQL(ctx, "sqlserver", fmt.Sprintf("sqlserver://%s:%s@%s?database=%s&dial timeout=8",
			url.QueryEscape(s.Username), url.QueryEscape(s.Password), hp, s.Database))
	case "oracle":
		return pingSQL(ctx, "oracle", fmt.Sprintf("oracle://%s:%s@%s/%s",
			url.QueryEscape(s.Username), url.QueryEscape(s.Password), hp, s.Database))
	case "clickhouse":
		return pingClickHouse(ctx, s, hp)
	case "trino":
		return pingTrino(ctx, s, hp)
	case "kafka":
		return pingKafka(ctx, hp)
	case "iceberg":
		return pingIceberg(ctx, hp) // REST catalog: no creds, GET /v1/config
	default:
		return tcp(ctx, hp) // unknown type → TCP reachability fallback
	}
}

// ListTables opens a real connection and returns the source's table names.
// Credentials are used only for this call and never stored.
func ListTables(ctx context.Context, s Spec) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	hp := hostPort(s)
	switch strings.ToLower(s.Type) {
	case "postgresql", "postgres":
		return queryTables(ctx, "pgx", fmt.Sprintf("postgres://%s:%s@%s/%s?sslmode=disable&connect_timeout=8",
			url.QueryEscape(s.Username), url.QueryEscape(s.Password), hp, s.Database),
			`SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name`)
	case "mysql":
		return queryTables(ctx, "mysql", fmt.Sprintf("%s:%s@tcp(%s)/%s?timeout=8s",
			s.Username, s.Password, hp, s.Database),
			`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`)
	case "sql server", "sqlserver", "mssql":
		return queryTables(ctx, "sqlserver", fmt.Sprintf("sqlserver://%s:%s@%s?database=%s&dial timeout=8",
			url.QueryEscape(s.Username), url.QueryEscape(s.Password), hp, s.Database),
			`SELECT table_name FROM information_schema.tables WHERE table_type='BASE TABLE' ORDER BY table_name`)
	case "oracle":
		return queryTables(ctx, "oracle", fmt.Sprintf("oracle://%s:%s@%s/%s",
			url.QueryEscape(s.Username), url.QueryEscape(s.Password), hp, s.Database),
			`SELECT table_name FROM user_tables ORDER BY table_name`)
	case "clickhouse":
		return listClickHouseTables(ctx, s, hp)
	case "trino":
		user := orDefault(s.Username, "control-plane")
		return queryTables(ctx, "trino", fmt.Sprintf("http://%s@%s?catalog=%s&schema=information_schema", url.QueryEscape(user), hp, orDefault(s.Database, "iceberg")),
			`SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema') ORDER BY table_name`)
	case "iceberg":
		return listIcebergTables(ctx, hp)
	case "kafka":
		return listKafkaTopics(ctx, hp)
	default:
		return nil, fmt.Errorf("listing tables not supported for type %q", s.Type)
	}
}

func queryTables(ctx context.Context, driver, dsn, q string) ([]string, error) {
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func listClickHouseTables(ctx context.Context, s Spec, hp string) ([]string, error) {
	conn, err := ch.Open(&ch.Options{
		Addr:        []string{hp},
		Auth:        ch.Auth{Database: orDefault(s.Database, "default"), Username: orDefault(s.Username, "default"), Password: s.Password},
		DialTimeout: timeout,
	})
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	rows, err := conn.Query(ctx, "SHOW TABLES")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func listIcebergTables(ctx context.Context, hp string) ([]string, error) {
	type nsResp struct {
		Namespaces [][]string `json:"namespaces"`
	}
	type tblResp struct {
		Identifiers []struct {
			Namespace []string `json:"namespace"`
			Name      string   `json:"name"`
		} `json:"identifiers"`
	}
	get := func(path string, v any) error {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+hp+path, nil)
		resp, err := (&http.Client{Timeout: timeout}).Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return fmt.Errorf("iceberg status %d", resp.StatusCode)
		}
		return jsonDecode(resp.Body, v)
	}
	var ns nsResp
	if err := get("/v1/namespaces", &ns); err != nil {
		return nil, err
	}
	out := []string{}
	for _, n := range ns.Namespaces {
		nsName := strings.Join(n, ".")
		var tr tblResp
		if err := get("/v1/namespaces/"+nsName+"/tables", &tr); err != nil {
			continue
		}
		for _, id := range tr.Identifiers {
			out = append(out, nsName+"."+id.Name)
		}
	}
	return out, nil
}

func listKafkaTopics(ctx context.Context, hp string) ([]string, error) {
	d := &kafka.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", hp)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	parts, err := conn.ReadPartitions()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []string{}
	for _, p := range parts {
		if !seen[p.Topic] {
			seen[p.Topic] = true
			out = append(out, p.Topic)
		}
	}
	return out, nil
}

// pingSQL opens a database/sql connection and pings it.
func pingSQL(ctx context.Context, driver, dsn string) error {
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	return db.PingContext(ctx)
}

func pingClickHouse(ctx context.Context, s Spec, hp string) error {
	conn, err := ch.Open(&ch.Options{
		Addr:        []string{hp},
		Auth:        ch.Auth{Database: orDefault(s.Database, "default"), Username: orDefault(s.Username, "default"), Password: s.Password},
		DialTimeout: timeout,
	})
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Ping(ctx)
}

func pingTrino(ctx context.Context, s Spec, hp string) error {
	user := orDefault(s.Username, "control-plane")
	dsn := fmt.Sprintf("http://%s@%s?catalog=%s", url.QueryEscape(user), hp, orDefault(s.Database, "iceberg"))
	db, err := sql.Open("trino", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	row := db.QueryRowContext(ctx, "SELECT 1")
	var x int
	return row.Scan(&x)
}

func pingKafka(ctx context.Context, hp string) error {
	d := &kafka.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", hp)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.ReadPartitions() // requires a successful metadata exchange
	return err
}

func pingIceberg(ctx context.Context, hp string) error {
	url := "http://" + hp + "/v1/config"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("iceberg rest status %d", resp.StatusCode)
	}
	return nil
}

func tcp(ctx context.Context, hp string) error {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", hp)
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}

// hostPort assembles host:port, stripping any scheme and applying a per-type
// default port when none is supplied.
func hostPort(s Spec) string {
	host := s.Host
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	host = strings.TrimRight(host, "/")
	if s.Port != "" && !strings.Contains(host, ":") {
		return host + ":" + s.Port
	}
	if !strings.Contains(host, ":") {
		if p := defaultPort(s.Type); p != "" {
			return host + ":" + p
		}
	}
	return host
}

func defaultPort(t string) string {
	switch strings.ToLower(t) {
	case "postgresql", "postgres":
		return "5432"
	case "mysql":
		return "3306"
	case "sql server", "sqlserver", "mssql":
		return "1433"
	case "oracle":
		return "1521"
	case "clickhouse":
		return "9000"
	case "trino":
		return "8080"
	case "kafka":
		return "9092"
	case "iceberg":
		return "8181"
	default:
		return ""
	}
}

func jsonDecode(r io.Reader, v any) error { return json.NewDecoder(r).Decode(v) }

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func short(err error) string {
	m := err.Error()
	switch {
	case strings.Contains(m, "deadline exceeded") || strings.Contains(m, "i/o timeout"):
		return "timeout"
	case strings.Contains(m, "connection refused"):
		return "connection refused"
	case strings.Contains(m, "no such host"):
		return "dns error"
	case strings.Contains(strings.ToLower(m), "password") || strings.Contains(strings.ToLower(m), "auth") || strings.Contains(m, "28000") || strings.Contains(m, "28P01"):
		return "authentication failed"
	}
	if len(m) > 120 {
		return m[:120]
	}
	return m
}
