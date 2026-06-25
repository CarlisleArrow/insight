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
	Server   Server   `mapstructure:"server"`
	Dev      Dev      `mapstructure:"dev"`
	Keycloak Keycloak `mapstructure:"keycloak"`
	Postgres Postgres `mapstructure:"postgres"`
	Rewrite  Rewrite  `mapstructure:"rewrite"`
	Adapters Adapters `mapstructure:"adapters"`
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
		"keycloak.client_secret", "postgres.password",
		"adapters.clickhouse_password", "adapters.datahub_token", "adapters.sentry_token",
		"adapters.airflow_auth", "adapters.opensearch_auth",
		"adapters.msp_api_url", "adapters.msp_api_key",
		"adapters.msp_wechat_channel_id", "adapters.msp_wechat_template_id",
	} {
		_ = v.BindEnv(k)
	}

	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}
	return &cfg, nil
}
