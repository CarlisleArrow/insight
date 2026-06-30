package auth

// Coarse RBAC (ARCHITECTURE.md §2.2): Keycloak groups map to feature
// permissions. Fine-grained data access (row/column masking) is handled
// separately by the authz package + L6 rewrite — NOT here.

// Permission is a coarse, page/feature-level capability.
type Permission string

const (
	PermQueryRun       Permission = "query:run"
	PermDatasetsRead   Permission = "datasets:read"
	PermPipelinesRead  Permission = "pipelines:read"
	PermPipelinesWrite Permission = "pipelines:write"
	PermCatalogRead    Permission = "catalog:read"
	PermPoliciesRead   Permission = "policies:read"
	PermPoliciesWrite  Permission = "policies:write"
	PermAnalyticsWrite Permission = "analytics:write" // dashboards, report subscriptions
	PermModelingWrite  Permission = "modeling:write"  // business metrics, semantic models
	PermAdmin          Permission = "admin:all"
)

// Coarse groups defined in §2.2. Factory-scoped analyst groups (e.g.
// data-analyst-fab1) inherit the analyst permission set via prefix match.
const (
	GroupPlatformAdmin = "data-platform-admin"
	GroupAnalyst       = "data-analyst"
	GroupViewer        = "data-viewer"
)

// groupPermissions is the static role→permission table.
var groupPermissions = map[string][]Permission{
	GroupPlatformAdmin: {
		PermQueryRun, PermDatasetsRead, PermPipelinesRead, PermPipelinesWrite,
		PermCatalogRead, PermPoliciesRead, PermPoliciesWrite,
		PermAnalyticsWrite, PermModelingWrite, PermAdmin,
	},
	GroupAnalyst: {
		PermQueryRun, PermDatasetsRead, PermPipelinesRead, PermCatalogRead, PermPoliciesRead,
		PermAnalyticsWrite, PermModelingWrite,
	},
	GroupViewer: {
		PermDatasetsRead, PermCatalogRead,
	},
}

// permsForGroup resolves a single group to its permissions, treating any
// `data-analyst-*` factory-scoped group as an analyst.
func permsForGroup(g string) []Permission {
	if p, ok := groupPermissions[g]; ok {
		return p
	}
	if len(g) > len(GroupAnalyst) && g[:len(GroupAnalyst)+1] == GroupAnalyst+"-" {
		return groupPermissions[GroupAnalyst]
	}
	return nil
}

// HasPermission reports whether any of the caller's groups grants perm.
func HasPermission(groups []string, perm Permission) bool {
	for _, g := range groups {
		for _, p := range permsForGroup(g) {
			if p == perm {
				return true
			}
		}
	}
	return false
}

// PermissionsForGroups returns the de-duplicated permission set granted by the
// caller's coarse groups. Used by the DB-backed effective-permission resolver
// to seed the static-group baseline before adding role-binding permissions.
func PermissionsForGroups(groups []string) []Permission {
	seen := map[Permission]bool{}
	out := []Permission{}
	for _, g := range groups {
		for _, p := range permsForGroup(g) {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

// AllPermissions returns every defined feature permission. The resolver uses it
// to expand the `admin:all` wildcard so an admin role passes every gate.
func AllPermissions() []Permission {
	return []Permission{
		PermQueryRun, PermDatasetsRead, PermPipelinesRead, PermPipelinesWrite,
		PermCatalogRead, PermPoliciesRead, PermPoliciesWrite,
		PermAnalyticsWrite, PermModelingWrite, PermAdmin,
	}
}
