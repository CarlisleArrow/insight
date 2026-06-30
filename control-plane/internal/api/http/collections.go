package http

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/go-chi/chi/v5"

	"gitlab.siptory.com/ipas/control-plane/internal/auth"
	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// tenantScoped marks the UI-owned collections that are partitioned per tenant
// (§2 logical scoping). Rows are visible to their owning tenant plus shared
// (NULL-tenant) rows. Platform-global collections (notification) are not listed
// here and stay visible to everyone.
var tenantScoped = map[string]bool{
	"dashboard": true, "report": true, "metric": true, "dq_rule": true, "api_key": true,
}

// collectionList returns GET handler for a JSONB-backed platform collection.
func (h *Handlers) collectionList(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var (
			items []pg.Doc
			err   error
		)
		if tenantScoped[name] {
			items, err = h.Store.ListDocsForTenant(r.Context(), name, callerTenant(r.Context()))
		} else {
			items, err = h.Store.ListDocs(r.Context(), name)
		}
		if err != nil {
			h.Log.Error("list collection", "name", name, "err", err.Error())
			writeError(w, http.StatusInternalServerError, "list failed")
			return
		}
		writeJSON(w, http.StatusOK, items)
	}
}

// collectionCreate returns a POST handler that stores the request body as a doc.
func (h *Handlers) collectionCreate(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var doc pg.Doc
		if err := decodeJSON(r, &doc); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		created, err := h.createDoc(r, name, doc)
		if err != nil {
			h.Log.Error("create collection", "name", name, "err", err.Error())
			writeError(w, http.StatusInternalServerError, "create failed")
			return
		}
		writeJSON(w, http.StatusCreated, created)
	}
}

// createDoc inserts a doc, stamping the caller's tenant for tenant-scoped
// collections (§2). Centralizes the branch so every create path shares it.
func (h *Handlers) createDoc(r *http.Request, name string, doc pg.Doc) (pg.Doc, error) {
	if tenantScoped[name] {
		return h.Store.CreateDocForTenant(r.Context(), name, doc, callerTenant(r.Context()))
	}
	return h.Store.CreateDoc(r.Context(), name, doc)
}

// collectionUpdate returns a PUT handler that replaces a doc by id.
func (h *Handlers) collectionUpdate(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var doc pg.Doc
		if err := decodeJSON(r, &doc); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		updated, err := h.Store.UpdateDoc(r.Context(), name, chi.URLParam(r, "id"), doc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "update failed")
			return
		}
		writeJSON(w, http.StatusOK, updated)
	}
}

// collectionDelete returns a DELETE handler that removes a doc by id.
func (h *Handlers) collectionDelete(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h.Store.DeleteDoc(r.Context(), name, chi.URLParam(r, "id")); err != nil {
			writeError(w, http.StatusInternalServerError, "delete failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// --- Notifications (collection "notification") ---

func (h *Handlers) Notifications(w http.ResponseWriter, r *http.Request) {
	h.collectionList("notification")(w, r)
}

func (h *Handlers) MarkNotificationRead(w http.ResponseWriter, r *http.Request) {
	updated, err := h.Store.PatchDoc(r.Context(), "notification", chi.URLParam(r, "id"), pg.Doc{"unread": false})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "mark read failed")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (h *Handlers) MarkAllNotificationsRead(w http.ResponseWriter, r *http.Request) {
	if _, err := h.Store.PatchAll(r.Context(), "notification", pg.Doc{"unread": false}); err != nil {
		writeError(w, http.StatusInternalServerError, "mark all read failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) DeleteNotification(w http.ResponseWriter, r *http.Request) {
	h.collectionDelete("notification")(w, r)
}

// --- API keys (collection "api_key") ---
//
// On create the BFF mints a token, returns it ONCE in the response `token`
// field, and persists only a display prefix (never the full secret). The
// admin variant lists/creates all keys; the personal (/me) variant scopes by
// the caller's subject so a user only sees their own.

func mintToken(prefix string) (full, display string) {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	full = prefix + hex.EncodeToString(b)
	display = full[:min(len(full), 14)] + "…"
	return full, display
}

func (h *Handlers) createKey(w http.ResponseWriter, r *http.Request, owner string) {
	var doc pg.Doc
	if err := decodeJSON(r, &doc); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	tokenPrefix := "ipas_sk_"
	if owner != "" {
		tokenPrefix = "ipas_pat_"
		doc["owner"] = owner
	}
	full, display := mintToken(tokenPrefix)
	doc["prefix"] = display
	if _, ok := doc["status"]; !ok {
		doc["status"] = "Active"
	}
	if _, ok := doc["used"]; !ok {
		doc["used"] = "never"
	}
	created, err := h.createDoc(r, "api_key", doc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create failed")
		return
	}
	created["token"] = full // one-time plaintext, not stored
	writeJSON(w, http.StatusCreated, created)
}

func (h *Handlers) AdminListKeys(w http.ResponseWriter, r *http.Request) {
	h.collectionList("api_key")(w, r)
}
func (h *Handlers) AdminCreateKey(w http.ResponseWriter, r *http.Request) { h.createKey(w, r, "") }
func (h *Handlers) AdminDeleteKey(w http.ResponseWriter, r *http.Request) {
	h.collectionDelete("api_key")(w, r)
}

func (h *Handlers) MyListKeys(w http.ResponseWriter, r *http.Request) {
	caller, _ := auth.FromContext(r.Context())
	owner := subjectRef(caller)
	all, err := h.Store.ListDocs(r.Context(), "api_key")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	mine := []pg.Doc{}
	for _, d := range all {
		if o, _ := d["owner"].(string); o == owner {
			mine = append(mine, d)
		}
	}
	writeJSON(w, http.StatusOK, mine)
}
func (h *Handlers) MyCreateKey(w http.ResponseWriter, r *http.Request) {
	caller, _ := auth.FromContext(r.Context())
	h.createKey(w, r, subjectRef(caller))
}
func (h *Handlers) MyDeleteKey(w http.ResponseWriter, r *http.Request) {
	h.collectionDelete("api_key")(w, r)
}

// --- Audit log (read-only, acl_audit) ---

func (h *Handlers) AdminAudit(w http.ResponseWriter, r *http.Request) {
	rows, err := h.Store.ListAudit(r.Context(), limitParam(r, 200))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list failed")
		return
	}
	writeJSON(w, http.StatusOK, rows)
}
