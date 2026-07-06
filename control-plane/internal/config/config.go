// Package config loads control-plane configuration from a YAML file plus
// environment overrides (viper). All downstream endpoints come from
// ARCHITECTURE.md §4; secrets are env-only and never live in the file.
package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config is the fully-resolved configuration tree.
type Config struct {
	Server     Server     `mapstructure:"server"`
	Dev        Dev        `mapstructure:"dev"`
	Auth       Auth       `mapstructure:"auth"`
	Keycloak   Keycloak   `mapstructure:"keycloak"`
	Postgres   Postgres   `mapstructure:"postgres"`
	Rewrite    Rewrite    `mapstructure:"rewrite"`
	Adapters   Adapters   `mapstructure:"adapters"`
	Insight    Insight    `mapstructure:"insight"`
	Federation Federation `mapstructure:"federation"`
}

// Deployment roles (§22.2). A factory instance owns only its own site's data;
// a hybrid instance is a factory PLUS the group control tower (Federation UI).
const (
	RoleFactory = "factory"
	RoleHybrid  = "hybrid"
)

// Insight holds the deployment-role identity of THIS instance (§22.2).
type Insight struct {
	Role      string `mapstructure:"role"`       // "factory" | "hybrid"; env INSIGHT_ROLE; default "factory"
	FactoryID string `mapstructure:"factory_id"` // this site's id, e.g. "fab-a"; env INSIGHT_FACTORY_ID
	Version   string `mapstructure:"version"`    // build/blueprint version, informational
}

// IsHybrid reports whether this instance also serves the group control tower.
func (i Insight) IsHybrid() bool { return i.Role == RoleHybrid }

// Federation configures how a factory reports up, and (hybrid) the tower.
type Federation struct {
	TowerEndpoint  string `mapstructure:"tower_endpoint"`   // factory→HQ report target; empty on hybrid
	SharedToken    string `mapstructure:"shared_token"`     // env-only CP_FEDERATION_SHARED_TOKEN; gates the ingest surface
	ReportEverySec int    `mapstructure:"report_every_sec"` // default 60
	PullEverySec   int    `mapstructure:"pull_every_sec"`   // command pull interval, default 30
}

func (f Federation) ReportEvery() time.Duration { return time.Duration(f.ReportEverySec) * time.Second }
func (f Federation) PullEvery() time.Duration   { return time.Duration(f.PullEverySec) * time.Second }

// Auth configures the DB-backed RBAC fallback (§2). Because Keycloak carries no
// groups, DefaultRole gives every authenticated user a baseline (e.g. "viewer")
// and BootstrapAdmins names users/emails always granted full admin so a fresh
// production deployment has at least one administrator without any binding yet.
// Both are also surfaced as runtime system_config (auth.default_role); config
// wins when set, otherwise this static default applies.
type Auth struct {
	DefaultRole     string   `mapstructure:"default_role"`
	BootstrapAdmins []string `mapstructure:"bootstrap_admins"`
	// GroupAdminGroups lists Keycloak groups whose members get factory scope
	// "all" (group administrators, §22.7①); everyone else is scoped to this
	// instance's insight.factory_id.
	GroupAdminGroups []string `mapstructure:"group_admin_groups"`
}

type Server struct {
	HTTPAddr               string `mapstructure:"http_addr"`
	ReadTimeoutSeconds     int    `mapstructure:"read_timeout_seconds"`
	WriteTimeoutSeconds    int    `mapstructure:"write_timeout_seconds"`
	ShutdownTimeoutSeconds int    `mapstructure:"shutdown_timeout_seconds"`
	PublicBaseURL          string `mapstructure:"public_base_url"` // for links in delivered reports
}

// Dev holds local-development escape hatches. Defaults false so a production
// deployment is locked down unless explicitly opened.
type Dev struct {
	AuthBypass   bool     `mapstructure:"auth_bypass"`
	BypassGroups []string `mapstructure:"bypass_groups"`
}

type Keycloak struct {
	Issuer       string `mapstructure:"issuer"`
	ClientID     string `mapstructure:"client_id"`
	GroupsClaim  string `mapstructure:"groups_claim"`
	ClientSecret string `mapstructure:"client_secret"` // env-only: CP_KEYCLOAK_CLIENT_SECRET
}

type Postgres struct {
	Host       string `mapstructure:"host"`
	Port       int    `mapstructure:"port"`
	Database   string `mapstructure:"database"`
	User       string `mapstructure:"user"`
	Password   string `mapstructure:"password"` // env-only: CP_POSTGRES_PASSWORD
	SearchPath string `mapstructure:"search_path"`
	SSLMode    string `mapstructure:"sslmode"`
	MaxConns   int32  `mapstructure:"max_conns"`
}

// DSN builds a pgx connection string. search_path scopes the cp_app role to
// platform_metadata (§4.1).
func (p Postgres) DSN() string {
	return fmt.Sprintf(
		"postgres://%s:%s@%s:%d/%s?sslmode=%s&search_path=%s",
		p.User, p.Password, p.Host, p.Port, p.Database, p.SSLMode, p.SearchPath,
	)
}

type Rewrite struct {
	BaseURL        string `mapstructure:"base_url"`
	TimeoutSeconds int    `mapstructure:"timeout_seconds"`
}

func (r Rewrite) Timeout() time.Duration { return time.Duration(r.TimeoutSeconds) * time.Second }

type Adapters struct {
	DebeziumURL    string `mapstructure:"debezium_url"`
	AirflowURL     string `mapstructure:"airflow_url"`
	AirflowDAGsDir string `mapstructure:"airflow_dags_dir"`
	AirflowAuth    string `mapstructure:"airflow_auth"` // optional "Basic ..." header
	CodegenDir     string `mapstructure:"codegen_dir"`  // shared RWX volume for generated ETL scripts (§16); default <dags_dir>/generated
	IcebergRestURL string `mapstructure:"iceberg_rest_url"`

	KafkaURL string `mapstructure:"kafka_url"` // host:port (TCP health probe)
	MinIOURL string `mapstructure:"minio_url"`

	TrinoURL  string `mapstructure:"trino_url"`
	TrinoUser string `mapstructure:"trino_user"`

	ClickHouseURL      string `mapstructure:"clickhouse_url"`
	ClickHouseUser     string `mapstructure:"clickhouse_user"`
	ClickHousePassword string `mapstructure:"clickhouse_password"` // env-only: CP_ADAPTERS_CLICKHOUSE_PASSWORD
	ClickHouseDatabase string `mapstructure:"clickhouse_database"`

	DataHubGMSURL string `mapstructure:"datahub_gms_url"`
	DataHubToken  string `mapstructure:"datahub_token"` // env-only: CP_ADAPTERS_DATAHUB_TOKEN

	PrometheusURL string `mapstructure:"prometheus_url"`

	OpenSearchURL   string `mapstructure:"opensearch_url"`
	OpenSearchIndex string `mapstructure:"opensearch_index"`
	OpenSearchAuth  string `mapstructure:"opensearch_auth"` // optional "Basic ..." header

	SentryURL     string `mapstructure:"sentry_url"`
	SentryToken   string `mapstructure:"sentry_token"` // env-only: CP_ADAPTERS_SENTRY_TOKEN
	SentryOrg     string `mapstructure:"sentry_org"`
	SentryProject string `mapstructure:"sentry_project"`

	// MSP notification gateway (report distribution, §11). Secrets env-only.
	MSPAPIURL           string `mapstructure:"msp_api_url"`
	MSPAPIKey           string `mapstructure:"msp_api_key"`            // env-only: CP_ADAPTERS_MSP_API_KEY
	MSPWeChatChannelID  string `mapstructure:"msp_wechat_channel_id"`  // env-only
	MSPWeChatTemplateID string `mapstructure:"msp_wechat_template_id"` // env-only
}

// Load reads config.yaml (path may be "" to use the embedded defaults dir) and
// overlays environment variables. Env keys are prefixed CP_ and use "_" for the
// nested path separator, e.g. CP_POSTGRES_PASSWORD, CP_DEV_AUTH_BYPASS.
func Load(path string) (*Config, error) {
	v := viper.New()
	v.SetConfigType("yaml")
	if path != "" {
		v.SetConfigFile(path)
	} else {
		v.SetConfigName("config")
		v.AddConfigPath("./internal/config")
		v.AddConfigPath("/etc/control-plane")
		v.AddConfigPath(".")
	}

	v.SetEnvPrefix("CP")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	// Bind secret keys explicitly so AutomaticEnv resolves them even though they
	// are absent from the YAML file.
	for _, k := range []string{
		"auth.default_role", "auth.bootstrap_admins", "auth.group_admin_groups",
		"keycloak.client_secret", "postgres.password",
		"adapters.clickhouse_password", "adapters.datahub_token", "adapters.sentry_token",
		"adapters.airflow_auth", "adapters.opensearch_auth",
		"adapters.msp_api_url", "adapters.msp_api_key",
		"adapters.msp_wechat_channel_id", "adapters.msp_wechat_template_id",
		"federation.tower_endpoint", "federation.shared_token", // CP_FEDERATION_*
	} {
		_ = v.BindEnv(k)
	}
	// Deployment identity uses unprefixed env names by convention (§22.2), with
	// the CP_-prefixed forms accepted too.
	_ = v.BindEnv("insight.role", "INSIGHT_ROLE", "CP_INSIGHT_ROLE")
	_ = v.BindEnv("insight.factory_id", "INSIGHT_FACTORY_ID", "CP_INSIGHT_FACTORY_ID")
	_ = v.BindEnv("insight.version", "INSIGHT_VERSION", "CP_INSIGHT_VERSION")

	v.SetDefault("insight.role", RoleFactory)
	v.SetDefault("federation.report_every_sec", 60)
	v.SetDefault("federation.pull_every_sec", 30)

	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}
	if cfg.Insight.Role != RoleFactory && cfg.Insight.Role != RoleHybrid {
		return nil, fmt.Errorf("insight.role must be %q or %q, got %q", RoleFactory, RoleHybrid, cfg.Insight.Role)
	}
	return &cfg, nil
}
