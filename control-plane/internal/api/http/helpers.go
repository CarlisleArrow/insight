package http

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	"gitlab.siptory.com/ipas/control-plane/internal/query"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

func encodeB64(b []byte) string          { return base64.StdEncoding.EncodeToString(b) }
func decodeB64(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

func marshalJSON(v any) ([]byte, error)   { return json.Marshal(v) }
func unmarshalJSON(b []byte, v any) error { return json.Unmarshal(b, v) }

func dialectFor(engine string) string { return query.DialectFor(engine) }

// subjectRef is the audit identity for a caller (preferred_username, else sub).
func subjectRef(c *auth.Claims) string {
	if c == nil {
		return "anonymous"
	}
	if c.PreferredUsername != "" {
		return c.PreferredUsername
	}
	return c.Subject
}

func pgAudit(subjectRef, raw, rewritten, engine string) pg.AuditEntry {
	return pg.AuditEntry{SubjectRef: subjectRef, RawSQL: raw, RewrittenSQL: rewritten, Engine: engine}
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

// configInt reads a runtime system_config int (§4), returning def when the
// config service is unset (e.g. tests) or the key is absent.
func (h *Handlers) configInt(ctx context.Context, key string, def int) int {
	if h.Config == nil {
		return def
	}
	return h.Config.Int(ctx, key, def)
}

// callerTenant returns the caller's resolved tenant id (§2 multi-tenancy), or ""
// when no resolver ran. Used to stamp tenant_id on created resources and to
// scope tenant-owned collections.
func callerTenant(ctx context.Context) string {
	if az, ok := auth.AuthzFromContext(ctx); ok && az != nil {
		return az.Tenant
	}
	return ""
}
