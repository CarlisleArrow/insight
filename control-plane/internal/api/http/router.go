package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
)

// NewRouter builds the BFF route table (§11). `/healthz` and `/metrics` are
// unauthenticated; everything under `/api` sits behind the auth boundary and
// coarse RBAC (§2.2).
func NewRouter(h *Handlers, verifier auth.Verifier) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)

	// Liveness + metrics (no auth).
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	r.Handle("/metrics", h.Metrics.Handler())

	// Authenticated API surface.
	r.Route("/api", func(api chi.Router) {
		// Pass the DB-backed effective-permission resolver when configured; a
		// nil *authz.RBAC must become a nil interface so the middleware falls
		// back to coarse-group checks (router_test has no store).
		var resolver auth.Resolver
		if h.RBAC != nil {
			resolver = h.RBAC
		}
		api.Use(auth.Middleware(verifier, h.Log, resolver))

		// Home overview (aggregate).
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/overview", h.Overview)

		// Self-service analytics.
		api.With(auth.RequirePermission(auth.PermQueryRun)).Post("/query", h.Query)
		api.With(auth.RequirePermission(auth.PermQueryRun)).Post("/query/build", h.QueryBuild)
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/datasets", h.Datasets)
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/datasets/{ns}/{table}/schema", h.DatasetSchema)

		// Analytics — dashboards + report subscriptions (platform_metadata).
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/dashboards", h.collectionList("dashboard"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Post("/dashboards", h.collectionCreate("dashboard"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Put("/dashboards/{id}", h.collectionUpdate("dashboard"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Delete("/dashboards/{id}", h.collectionDelete("dashboard"))
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Post("/dashboards/{id}/render", h.DashboardRender)
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/reports", h.collectionList("report"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Post("/reports", h.collectionCreate("report"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Put("/reports/{id}", h.collectionUpdate("report"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Delete("/reports/{id}", h.collectionDelete("report"))
		api.With(auth.RequirePermission(auth.PermAnalyticsWrite)).Post("/reports/{id}/run", h.RunReport)
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/reports/{id}/runs", h.ReportRuns)
		api.With(auth.RequirePermission(auth.PermDatasetsRead)).Get("/reports/runs/{runId}/download", h.ReportDownload)

		// Modeling — business metrics (DataHub Glossary + local drafts).
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/metrics", h.MetricsList)
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Post("/metrics", h.collectionCreate("metric"))
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Put("/metrics/{id}", h.collectionUpdate("metric"))
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Delete("/metrics/{id}", h.collectionDelete("metric"))
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/semantic-model", h.SemanticModel)

		// Data dev — pipelines + data sources.
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/pipelines", h.Pipelines)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/pipelines", h.CreatePipeline)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/pipelines/dag", h.PipelineDag)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/pipelines/{id}", h.PipelineDetail)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/pipelines/{id}/run", h.RunPipeline)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/pipelines/{id}/pause", h.PausePipeline)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/pipelines/{id}/backfill", h.BackfillPipeline)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/datasources", h.ListDataSources)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/datasources/test", h.TestDataSource)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/datasources/tables", h.ListDataSourceTables)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/datasources", h.CreateDataSource)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Put("/datasources/{id}", h.UpdateDataSource)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Delete("/datasources/{id}", h.DeleteDataSource)

		// CDC connectors (Debezium direct).
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/connectors", h.CreateConnector)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Put("/connectors/{id}", h.UpdateConnector)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Delete("/connectors/{id}", h.DeleteConnector)

		// Data quality rules (platform_metadata).
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/dq/rules", h.collectionList("dq_rule"))
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/dq/rules", h.collectionCreate("dq_rule"))
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Put("/dq/rules/{id}", h.collectionUpdate("dq_rule"))
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Delete("/dq/rules/{id}", h.collectionDelete("dq_rule"))

		// Catalog (DataHub proxy + Iceberg schema).
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/catalog/search", h.CatalogSearch)
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/catalog/lineage", h.CatalogLineage)
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/catalog/facets", h.CatalogFacets)
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/catalog/asset", h.CatalogAsset)

		// Governance — policy CRUD + preview.
		api.With(auth.RequirePermission(auth.PermPoliciesRead)).Get("/policies/row", h.ListRowPolicies)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Post("/policies/row", h.CreateRowPolicy)
		api.With(auth.RequirePermission(auth.PermPoliciesRead)).Get("/policies/column", h.ListColumnPolicies)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Post("/policies/column", h.CreateColumnPolicy)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Post("/policies/preview", h.Preview)

		// Governance — access control (users from Keycloak, roles in platform_metadata).
		api.With(auth.RequirePermission(auth.PermPoliciesRead)).Get("/access/users", h.AccessUsers)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Post("/access/users", h.AccessCreateUser)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Put("/access/users/{username}", h.AccessUpdateUser)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Delete("/access/users/{username}", h.AccessDeleteUser)
		api.With(auth.RequirePermission(auth.PermPoliciesRead)).Get("/access/roles", h.AccessRoles)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Post("/access/roles", h.AccessCreateRole)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Put("/access/roles/{id}", h.AccessUpdateRole)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Delete("/access/roles/{id}", h.AccessDeleteRole)
		api.With(auth.RequirePermission(auth.PermPoliciesRead)).Get("/access/users/{username}/roles", h.AccessUserRoles)
		api.With(auth.RequirePermission(auth.PermPoliciesWrite)).Put("/access/users/{username}/roles", h.AccessSetUserRoles)

		// Monitoring & Ops.
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/ops/runs", h.OpsRuns)
		api.With(auth.RequirePermission(auth.PermPipelinesWrite)).Post("/ops/runs/{id}/retry", h.RetryRun)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/ops/logs", h.OpsLogs)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/ops/metrics", h.OpsMetrics)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/ops/metrics/range", h.OpsMetricsRange)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/ops/errors", h.OpsErrors)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/ops/sla", h.OpsSla)

		// Notifications (any authenticated user).
		api.Get("/notifications", h.Notifications)
		api.Post("/notifications/read-all", h.MarkAllNotificationsRead)
		api.Post("/notifications/{id}/read", h.MarkNotificationRead)
		api.Delete("/notifications/{id}", h.DeleteNotification)

		// Personal center (self-service, any authenticated user).
		api.Get("/me", h.Me)
		api.Get("/me/permissions", h.MyPermissions)
		api.Get("/me/sessions", h.MySessions)
		api.Delete("/me/sessions/{id}", h.DeleteMySession)
		api.Get("/me/apikeys", h.MyListKeys)
		api.Post("/me/apikeys", h.MyCreateKey)
		api.Delete("/me/apikeys/{id}", h.MyDeleteKey)

		// Platform admin.
		// Data API management (§15) — internal, admin-gated.
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/data-apis", h.ListDataAPIs)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/data-apis", h.CreateDataAPIHandler)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/data-apis/{id}", h.GetDataAPIHandler)
		api.With(auth.RequirePermission(auth.PermAdmin)).Put("/data-apis/{id}", h.UpdateDataAPIHandler)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/data-apis/{id}", h.DeleteDataAPIHandler)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/data-apis/{id}/publish", h.PublishDataAPI)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/data-apis/{id}/deprecate", h.DeprecateDataAPI)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/data-apis/{id}/keys", h.ListDataAPIKeysHandler)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/data-apis/{id}/keys", h.CreateDataAPIKeyHandler)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/data-apis/{id}/keys/{keyId}", h.DeleteDataAPIKeyHandler)

		// Modeling-as-Code (§16): meta-model IR CRUD + generate/deploy.
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/models", h.ListModels)
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Post("/models", h.CreateModel)
		api.With(auth.RequirePermission(auth.PermCatalogRead)).Get("/models/{id}", h.GetModel)
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Delete("/models/{id}", h.DeleteModel)
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Put("/models/{id}/tables", h.ReplaceModelTables)
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Post("/models/{id}/generate", h.GenerateModel)
		api.With(auth.RequirePermission(auth.PermModelingWrite)).Post("/models/{id}/deploy", h.DeployModel)

		// Table operations (§17): schema evolution, maintenance, watermarks, data patch, approvals.
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Post("/tables/{ns}/{table}/schema/diff", h.SchemaDiff)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/tables/{ns}/{table}/schema/alter", h.SchemaAlter)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/tables/{ns}/{table}/health", h.TableHealth)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/tables/{ns}/{table}/maintenance/{op}", h.RunMaintenance)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/maintenance/jobs", h.ListMaintenanceJobs)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/tables/{ns}/{table}/watermarks", h.Watermarks)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/tables/{ns}/{table}/watermarks/reset", h.ResetWatermark)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Post("/tables/{ns}/{table}/patch/preview", h.PatchPreview)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/tables/{ns}/{table}/patch/apply", h.PatchApply)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/approvals", h.ListApprovals)
		api.With(auth.RequirePermission(auth.PermPipelinesRead)).Get("/approvals/{id}", h.GetApproval)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/approvals/{id}/approve", h.ApproveRequest)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/approvals/{id}/reject", h.RejectRequest)

		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/admin/users", h.AdminUsers)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/admin/users", h.AdminCreateUser)
		api.With(auth.RequirePermission(auth.PermAdmin)).Put("/admin/users/{username}", h.AdminUpdateUser)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/admin/users/{username}", h.AdminDeleteUser)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/admin/audit", h.AdminAudit)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/admin/orgs", h.AdminOrgs)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/admin/orgs", h.AdminCreateOrg)
		api.With(auth.RequirePermission(auth.PermAdmin)).Put("/admin/orgs/{id}", h.AdminUpdateOrg)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/admin/orgs/{id}", h.AdminDeleteOrg)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/admin/config", h.AdminConfig)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/admin/config", h.AdminSetConfig)
		api.With(auth.RequirePermission(auth.PermAdmin)).Put("/admin/config/{id}", h.AdminUpdateConfig)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/admin/config/{id}", h.AdminDeleteConfig)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/admin/tenancy", h.AdminTenancy)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/admin/tenancy", h.AdminCreateTenant)
		api.With(auth.RequirePermission(auth.PermAdmin)).Put("/admin/tenancy/{id}", h.AdminUpdateTenant)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/admin/tenancy/{id}", h.AdminDeleteTenant)
		api.With(auth.RequirePermission(auth.PermAdmin)).Get("/admin/apikeys", h.AdminListKeys)
		api.With(auth.RequirePermission(auth.PermAdmin)).Post("/admin/apikeys", h.AdminCreateKey)
		api.With(auth.RequirePermission(auth.PermAdmin)).Delete("/admin/apikeys/{id}", h.AdminDeleteKey)
	})

	// External Data API surface (§15) — its own contract+masking boundary, NOT
	// the internal Keycloak middleware. Auth is per-endpoint (auth_mode).
	r.Route("/data-api/v1", func(ext chi.Router) {
		ext.Get("/{name}", h.DataAPIServe)
		ext.Post("/{name}", h.DataAPIServe)
	})

	return r
}
