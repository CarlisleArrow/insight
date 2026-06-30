// Command server is the IPAS control-plane BFF (ARCHITECTURE.md §7). It wires
// config, the auth boundary, the platform_metadata store, the adapter set
// (mock or real), the query gateway, and the HTTP API, then serves with graceful
// shutdown.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/admin"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/airflow"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/clickhouse"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/datahub"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/debezium"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/health"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/iceberg"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/k8s"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/msp"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/opensearch"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/prometheus"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/sentry"
	"gitlab.siptory.com/ipas/control-plane/internal/adapter/trino"
	httpapi "gitlab.siptory.com/ipas/control-plane/internal/api/http"
	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/authz"
	"gitlab.siptory.com/ipas/control-plane/internal/config"
	"gitlab.siptory.com/ipas/control-plane/internal/orchestrator"
	"gitlab.siptory.com/ipas/control-plane/internal/query"
	"gitlab.siptory.com/ipas/control-plane/internal/report"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
	"gitlab.siptory.com/ipas/control-plane/internal/telemetry"
)

func main() {
	configPath := flag.String("config", "", "path to config.yaml (default: search ./internal/config, /etc/control-plane)")
	flag.Parse()

	log := telemetry.NewLogger()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Error("load config", "err", err.Error())
		os.Exit(1)
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// --- platform_metadata store (§2.3) ---
	store, err := pg.New(rootCtx, cfg.Postgres.DSN(), cfg.Postgres.MaxConns)
	if err != nil {
		log.Error("connect postgres", "err", err.Error())
		os.Exit(1)
	}
	defer store.Close()
	if err := store.Migrate(rootCtx); err != nil {
		log.Error("migrate", "err", err.Error())
		os.Exit(1)
	}
	log.Info("platform_metadata ready")

	// --- auth boundary (§1, §2.1) ---
	verifier, err := auth.NewVerifier(rootCtx, cfg)
	if err != nil {
		log.Error("init verifier", "err", err.Error())
		os.Exit(1)
	}
	if cfg.Dev.AuthBypass {
		log.Warn("DEV AUTH BYPASS ENABLED — do not run this in production")
	}

	// --- real adapters (§8), reachable via Telepresence / in-cluster DNS ---
	adapters, err := buildAdapters(cfg, log)
	if err != nil {
		log.Error("init adapters", "err", err.Error())
		os.Exit(1)
	}

	// --- query gateway (§10) + orchestrator saga (§11) ---
	router := query.NewRouter(adapters.Trino, adapters.CH)
	rewrite := query.NewRewriteClient(cfg.Rewrite.BaseURL, cfg.Rewrite.Timeout())

	// Health prober — live status of the platform's data-infrastructure
	// components for the DevConfig "Data sources" page (§4 addresses).
	prober := health.New(health.Config{
		TrinoURL:      cfg.Adapters.TrinoURL,
		ClickHouseURL: cfg.Adapters.ClickHouseURL,
		IcebergURL:    cfg.Adapters.IcebergRestURL,
		DebeziumURL:   cfg.Adapters.DebeziumURL,
		AirflowURL:    cfg.Adapters.AirflowURL,
		DataHubURL:    cfg.Adapters.DataHubGMSURL,
		PrometheusURL: cfg.Adapters.PrometheusURL,
		OpenSearchURL: cfg.Adapters.OpenSearchURL,
		MinIOURL:      cfg.Adapters.MinIOURL,
		KafkaURL:      cfg.Adapters.KafkaURL,
		PostgresHost:  cfg.Postgres.Host,
		PostgresPort:  cfg.Postgres.Port,
	}, store.Ping)

	mspClient := msp.New(cfg.Adapters.MSPAPIURL, cfg.Adapters.MSPAPIKey,
		cfg.Adapters.MSPWeChatChannelID, cfg.Adapters.MSPWeChatTemplateID)
	if mspClient.Enabled() {
		log.Info("MSP notification gateway configured (report distribution on)")
	} else {
		log.Warn("MSP not configured — report distribution disabled (generate + download only)")
	}

	// Runtime config + DB-backed RBAC resolver (§2). The resolver merges static
	// Keycloak groups, bootstrap admins, DB role bindings, and a default-role
	// fallback so real users (whose tokens carry no groups) are still authorized.
	configSvc := authz.NewConfigService(store)
	rbacResolver := authz.NewRBAC(store, configSvc, cfg.Auth.BootstrapAdmins, cfg.Auth.DefaultRole)

	handlers := &httpapi.Handlers{
		Log:           log,
		Metrics:       telemetry.NewMetrics(),
		Store:         store,
		Resolver:      authz.NewResolver(store),
		RBAC:          rbacResolver,
		Config:        configSvc,
		Rewrite:       rewrite,
		Router:        router,
		Adapters:      adapters,
		Orchestrator:  orchestrator.New(adapters, log),
		Health:        prober,
		Quality:       httpapi.NewQualityCache(30*time.Minute, 6),
		MSP:           mspClient,
		PublicBaseURL: cfg.Server.PublicBaseURL,
		Verifier:      verifier,
		APILimiter:    httpapi.NewAPIRateLimiter(),
		DAGsDir:       cfg.Adapters.AirflowDAGsDir,
		CodegenDir:    codegenDir(cfg),
	}

	// Report scheduler (in-process cron). Fires Active reports on their cron.
	scheduler := report.New(log, handlers.RunReportByID, handlers.ListReportSchedules)
	scheduler.Start(rootCtx)
	defer scheduler.Stop()

	srv := &http.Server{
		Addr:         cfg.Server.HTTPAddr,
		Handler:      httpapi.NewRouter(handlers, verifier),
		ReadTimeout:  time.Duration(cfg.Server.ReadTimeoutSeconds) * time.Second,
		WriteTimeout: time.Duration(cfg.Server.WriteTimeoutSeconds) * time.Second,
	}

	go func() {
		log.Info("control-plane listening", "addr", cfg.Server.HTTPAddr, "auth_bypass", cfg.Dev.AuthBypass)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server", "err", err.Error())
			stop()
		}
	}()

	<-rootCtx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(),
		time.Duration(cfg.Server.ShutdownTimeoutSeconds)*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown", "err", err.Error())
	}
}

// codegenDir resolves where §16 writes generated ETL scripts on the shared RWX
// volume (default: a "generated" subdir of the Airflow DAGs dir).
func codegenDir(cfg *config.Config) string {
	if cfg.Adapters.CodegenDir != "" {
		return cfg.Adapters.CodegenDir
	}
	return filepath.Join(cfg.Adapters.AirflowDAGsDir, "generated")
}

// buildAdapters wires the real component clients per §4. They connect lazily on
// first use, so construction failing only happens for clients that dial eagerly
// (Trino/ClickHouse handle pooling internally; K8s needs a resolvable config).
func buildAdapters(cfg *config.Config, log *slog.Logger) (adapter.Set, error) {
	a := cfg.Adapters

	trinoCli, err := trino.New(a.TrinoURL, a.TrinoUser)
	if err != nil {
		return adapter.Set{}, fmt.Errorf("trino: %w", err)
	}
	chCli, err := clickhouse.New(a.ClickHouseURL, a.ClickHouseUser, a.ClickHousePassword, a.ClickHouseDatabase)
	if err != nil {
		return adapter.Set{}, fmt.Errorf("clickhouse: %w", err)
	}
	k8sCli, err := k8s.New()
	if err != nil {
		// K8s ops are non-critical for the data path; log and continue without it.
		log.Warn("k8s adapter unavailable (NetworkPolicy/pod-status disabled)", "err", err.Error())
	}

	log.Info("using REAL adapters (cluster clients)")
	return adapter.Set{
		Ingest:   debezium.New(a.DebeziumURL),
		Orch:     airflow.New(a.AirflowURL, a.AirflowDAGsDir, a.AirflowAuth),
		Catalog:  iceberg.New(a.IcebergRestURL),
		Trino:    trinoCli,
		CH:       chCli,
		Metadata: datahub.New(a.DataHubGMSURL, a.DataHubToken),
		Metrics:  prometheus.New(a.PrometheusURL),
		Logs:     opensearch.New(a.OpenSearchURL, a.OpenSearchIndex, a.OpenSearchAuth),
		Errors:   sentry.New(a.SentryURL, a.SentryToken, a.SentryOrg, a.SentryProject),
		Admin:    admin.New(cfg.Keycloak.Issuer, cfg.Keycloak.ClientID, cfg.Keycloak.ClientSecret),
		K8s:      k8sCli, // may be nil if config unresolved; handlers guard usage
	}, nil
}
