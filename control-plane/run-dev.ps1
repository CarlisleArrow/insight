# run-dev.ps1 — start the IPAS control-plane BFF locally against the cluster.
#
# Prereqs (one-time):
#   1) kubeconfig is at ~\.kube\config (already installed from .\config).
#   2) Telepresence client at ~\bin\telepresence\telepresence.exe (already downloaded).
#   3) Connect Telepresence so in-cluster DNS (*.svc.cluster.local) resolves:
#        & "$HOME\bin\telepresence\telepresence.exe" connect
#      (needs Administrator the first time; installs the TUN device + daemon.)
#
# Then run this script from the control-plane directory.

$ErrorActionPreference = "Stop"

# --- Dev auth bypass: skip Keycloak, inject a synthetic data-platform-admin caller.
$env:CP_DEV_AUTH_BYPASS = "true"

# --- DB-backed RBAC (§2). Keycloak carries no groups, so real users are authorized
#     from rbac_role/rbac_binding. bootstrap_admins (comma list) are always full
#     admins so the first prod login has an administrator before any binding exists.
#     In production set CP_DEV_AUTH_BYPASS=false and list your real username(s)/email(s).
if (-not $env:CP_AUTH_BOOTSTRAP_ADMINS) { $env:CP_AUTH_BOOTSTRAP_ADMINS = "" }   # e.g. "pengluyi,admin@siptory.com"

# --- Secrets (override with your real values; these are NOT committed).
#     cp_app is the platform_metadata role (§4.1). Set its real password here.
if (-not $env:CP_POSTGRES_PASSWORD)          { $env:CP_POSTGRES_PASSWORD = "Pg123654" }
if (-not $env:CP_ADAPTERS_CLICKHOUSE_PASSWORD) { $env:CP_ADAPTERS_CLICKHOUSE_PASSWORD = "" }
if (-not $env:CP_ADAPTERS_DATAHUB_TOKEN)     { $env:CP_ADAPTERS_DATAHUB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhY3RvclR5cGUiOiJVU0VSIiwiYWN0b3JJZCI6ImRhdGFodWIiLCJ0eXBlIjoiUEVSU09OQUwiLCJ2ZXJzaW9uIjoiMiIsImp0aSI6ImI1MmFlNWMyLTEzZjItNGU2Ny05OTk5LTdiNzEzMTU2N2QxYiIsInN1YiI6ImRhdGFodWIiLCJpc3MiOiJkYXRhaHViLW1ldGFkYXRhLXNlcnZpY2UifQ.oUMCy-8SUIJ2sEjPIzgnkYW0rQbHHAyCYCTGBcac1Pg" }
if (-not $env:CP_ADAPTERS_SENTRY_TOKEN)      { $env:CP_ADAPTERS_SENTRY_TOKEN = "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" }
if (-not $env:CP_KEYCLOAK_CLIENT_SECRET)     { $env:CP_KEYCLOAK_CLIENT_SECRET = "PFAcOhFxF7L3T4mc7bqcyAEcF9w72HKU" }

# --- MSP notification gateway (report distribution). Fill to enable email/企微.
#     Without these, reports still generate + give a download link, but no delivery.
if (-not $env:CP_ADAPTERS_MSP_API_URL)          { $env:CP_ADAPTERS_MSP_API_URL = "" }   # e.g. http://msg-centre.<ns>.svc.cluster.local:10080
if (-not $env:CP_ADAPTERS_MSP_API_KEY)          { $env:CP_ADAPTERS_MSP_API_KEY = "" }   # sk_...
if (-not $env:CP_ADAPTERS_MSP_WECHAT_CHANNEL_ID)  { $env:CP_ADAPTERS_MSP_WECHAT_CHANNEL_ID = "" }
if (-not $env:CP_ADAPTERS_MSP_WECHAT_TEMPLATE_ID) { $env:CP_ADAPTERS_MSP_WECHAT_TEMPLATE_ID = "" }

# --- Airflow REST Basic auth (this 2.7.3 has auth enabled). Set your creds:
$airflowUser = "admin"
$airflowPass = "Admin2025"
if (-not $env:CP_ADAPTERS_AIRFLOW_AUTH) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${airflowUser}:${airflowPass}"))
  $env:CP_ADAPTERS_AIRFLOW_AUTH = "Basic $b64"
}

# --- L6 SQL-rewrite service. Running locally via Docker → point at localhost.
#     (In-cluster it would be http://sql-rewrite.control-plane.svc.cluster.local:8000)
if (-not $env:CP_REWRITE_BASE_URL) { $env:CP_REWRITE_BASE_URL = "http://localhost:8000" }

Write-Host "Starting control-plane BFF on :8088 (dev auth bypass ON)..." -ForegroundColor Cyan
go run ./cmd/server
