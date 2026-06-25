// Package admin reads users from Keycloak's Admin REST API (ARCHITECTURE.md §4,
// §11 admin/users — read-only). It obtains a service-account token via
// client_credentials on the `insight` client; that service account must hold the
// realm-management `view-users` role (§14.2) or the calls return 403.
package admin

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
	"gitlab.siptory.com/ipas/control-plane/internal/httpx"
)

type Client struct {
	tokenURL     string // {issuer}/protocol/openid-connect/token
	adminBase    string // {keycloak}/admin/realms/{realm}
	clientID     string
	clientSecret string
	http         *http.Client

	mu     sync.Mutex
	token  string
	expiry time.Time

	// usersCache memoizes the (expensive) paged user list + group lookups.
	usersMu    sync.Mutex
	usersCache []adapter.AdminUser
	usersExp   time.Time
}

// usersTTL is how long a computed user list is reused before re-paging Keycloak.
const usersTTL = 5 * time.Minute

// New derives the token + admin endpoints from the OIDC issuer. issuer is like
// http://ias.siptory.com:8443/realms/Unified_SSO.
func New(issuer, clientID, clientSecret string) *Client {
	issuer = strings.TrimRight(issuer, "/")
	base := issuer
	realm := ""
	if i := strings.Index(issuer, "/realms/"); i >= 0 {
		base = issuer[:i]
		realm = issuer[i+len("/realms/"):]
	}
	return &Client{
		tokenURL:     issuer + "/protocol/openid-connect/token",
		adminBase:    fmt.Sprintf("%s/admin/realms/%s", base, realm),
		clientID:     clientID,
		clientSecret: clientSecret,
		http:         &http.Client{Timeout: 15 * time.Second},
	}
}

type tokenResp struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   int    `json:"expires_in"`
}

// accessToken returns a cached service-account token, refreshing when near expiry.
func (c *Client) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.expiry) {
		return c.token, nil
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)
	var tr tokenResp
	if err := httpx.PostForm(ctx, c.http, c.tokenURL, form.Encode(), &tr); err != nil {
		return "", fmt.Errorf("keycloak token: %w", err)
	}
	c.token = tr.AccessToken
	c.expiry = time.Now().Add(time.Duration(tr.ExpiresIn-30) * time.Second)
	return c.token, nil
}

type kcUser struct {
	ID         string              `json:"id"`
	Username   string              `json:"username"`
	Email      string              `json:"email"`
	FirstName  string              `json:"firstName"`
	LastName   string              `json:"lastName"`
	Enabled    bool                `json:"enabled"`
	Attributes map[string][]string `json:"attributes"`
}

// cnFromDN extracts the CN (common name = person's name) from an LDAP DN, e.g.
// "CN=彭橹屹,OU=IT部,OU=制造中心,..." -> "彭橹屹".
func cnFromDN(dn string) string {
	for _, part := range strings.Split(dn, ",") {
		p := strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToUpper(p), "CN=") {
			return p[3:]
		}
	}
	return ""
}

// orgFromDN builds the organization from the LDAP DN's OU components, most-
// specific first (excluding the structural root OUs), e.g.
// "...OU=IT部,OU=制造中心,OU=siptory,DC=..." -> "制造中心 / IT部".
func orgFromDN(dn string) string {
	ous := []string{}
	for _, part := range strings.Split(dn, ",") {
		p := strings.TrimSpace(part)
		if strings.HasPrefix(strings.ToUpper(p), "OU=") {
			v := p[3:]
			if strings.EqualFold(v, "siptory") { // structural root — not a real org unit
				continue
			}
			ous = append(ous, v)
		}
	}
	if len(ous) == 0 {
		return ""
	}
	// Reverse to broad→specific (e.g. "制造中心 / IT部").
	for i, j := 0, len(ous)-1; i < j; i, j = i+1, j-1 {
		ous[i], ous[j] = ous[j], ous[i]
	}
	return strings.Join(ous, " / ")
}

// ListUsers returns the realm's real (human) users mapped to the front-end admin
// shape. It pages through ALL users — AD computer accounts (username ending in
// '$') are numerous and sort first, so a single ?max=N would return only those.
// Result is cached for usersTTL since AD membership changes infrequently.
func (c *Client) ListUsers(ctx context.Context) ([]adapter.AdminUser, error) {
	c.usersMu.Lock()
	if c.usersCache != nil && time.Now().Before(c.usersExp) {
		cached := c.usersCache
		c.usersMu.Unlock()
		return cached, nil
	}
	c.usersMu.Unlock()

	tok, err := c.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	hdr := map[string]string{"Authorization": "Bearer " + tok}

	// Page through every user (FULL representation — we need attributes for the
	// LDAP_ENTRY_DN, which carries the real CN/OU) and keep only humans (drop
	// machine accounts ending in '$').
	const pageSize = 100
	const safetyCap = 50000
	real := make([]kcUser, 0, 256)
	for first := 0; first < safetyCap; first += pageSize {
		var batch []kcUser
		url := fmt.Sprintf("%s/users?first=%d&max=%d", c.adminBase, first, pageSize)
		if err := httpx.Do(ctx, c.http, http.MethodGet, url, hdr, nil, &batch); err != nil {
			return nil, fmt.Errorf("keycloak users: %w", err)
		}
		for _, u := range batch {
			if !isMachineAccount(u.Username) {
				real = append(real, u)
			}
		}
		if len(batch) < pageSize {
			break // last page
		}
	}

	out := make([]adapter.AdminUser, 0, len(real))
	for _, u := range real {
		dn := attr(u.Attributes, "LDAP_ENTRY_DN")

		// Name: prefer first/last, else the DN's CN, else username.
		name := strings.TrimSpace(u.FirstName + " " + u.LastName)
		if name == "" {
			name = cnFromDN(dn)
		}
		if name == "" {
			name = u.Username
		}

		// Organization: the OU path from the DN (broad → specific).
		org := orgFromDN(dn)

		status := "Active"
		if !u.Enabled {
			status = "Suspended"
		}
		out = append(out, adapter.AdminUser{
			Name:     name,
			Email:    u.Email,
			Role:     "Regular user", // realm has no role mapping; all humans are regular users
			Org:      org,
			Status:   status,
			Username: u.Username,
		})
	}

	c.usersMu.Lock()
	c.usersCache = out
	c.usersExp = time.Now().Add(usersTTL)
	c.usersMu.Unlock()
	return out, nil
}

// invalidateUsers drops the cached user list (after a create/update/delete).
func (c *Client) invalidateUsers() {
	c.usersMu.Lock()
	c.usersCache = nil
	c.usersMu.Unlock()
}

// isMachineAccount reports whether a username is an AD computer/service account
// (sAMAccountName ends with '$'), which should not appear in the user list.
func isMachineAccount(username string) bool {
	return strings.HasSuffix(username, "$")
}

// GetUser returns one realm user by username (Personal center /api/me).
func (c *Client) GetUser(ctx context.Context, username string) (adapter.AdminUser, error) {
	tok, err := c.accessToken(ctx)
	if err != nil {
		return adapter.AdminUser{}, err
	}
	var users []kcUser
	url := c.adminBase + "/users?exact=true&username=" + url.QueryEscape(username)
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, hdr, nil, &users); err != nil {
		return adapter.AdminUser{}, fmt.Errorf("keycloak get user: %w", err)
	}
	if len(users) == 0 {
		return adapter.AdminUser{Username: username, Name: username, Status: "Active"}, nil
	}
	u := users[0]
	name := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if name == "" {
		name = u.Username
	}
	status := "Active"
	if !u.Enabled {
		status = "Suspended"
	}
	return adapter.AdminUser{
		Name:     name,
		Email:    u.Email,
		Role:     attr(u.Attributes, "role"),
		Org:      attr(u.Attributes, "org", "organization", "department"),
		Status:   status,
		Username: u.Username,
	}, nil
}

type kcUserBrief struct {
	ID string `json:"id"`
}

// usernameFor derives a username from the supplied user (explicit, else email
// local-part, else slugged name).
func usernameFor(u adapter.AdminUser) string {
	if u.Username != "" {
		return u.Username
	}
	if u.Email != "" {
		if i := strings.Index(u.Email, "@"); i > 0 {
			return u.Email[:i]
		}
		return u.Email
	}
	return strings.ToLower(strings.ReplaceAll(u.Name, " ", "."))
}

// kcUserWrite is the Keycloak Admin create/update body.
type kcUserWrite struct {
	Username   string              `json:"username"`
	Email      string              `json:"email,omitempty"`
	FirstName  string              `json:"firstName,omitempty"`
	LastName   string              `json:"lastName,omitempty"`
	Enabled    bool                `json:"enabled"`
	Attributes map[string][]string `json:"attributes,omitempty"`
}

func writeBody(u adapter.AdminUser, username string) kcUserWrite {
	first, last := u.Name, ""
	if parts := strings.SplitN(strings.TrimSpace(u.Name), " ", 2); len(parts) == 2 {
		first, last = parts[0], parts[1]
	}
	attrs := map[string][]string{}
	if u.Role != "" {
		attrs["role"] = []string{u.Role}
	}
	if u.Org != "" {
		attrs["org"] = []string{u.Org}
	}
	return kcUserWrite{
		Username:   username,
		Email:      u.Email,
		FirstName:  first,
		LastName:   last,
		Enabled:    u.Status != "Suspended",
		Attributes: attrs,
	}
}

// CreateUser creates a realm user. enabled defaults true unless status=Suspended.
func (c *Client) CreateUser(ctx context.Context, u adapter.AdminUser) (adapter.AdminUser, error) {
	tok, err := c.accessToken(ctx)
	if err != nil {
		return adapter.AdminUser{}, err
	}
	username := usernameFor(u)
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodPost, c.adminBase+"/users", hdr, writeBody(u, username), nil); err != nil {
		return adapter.AdminUser{}, fmt.Errorf("keycloak create user: %w", err)
	}
	c.invalidateUsers()
	u.Username = username
	if u.Status == "" {
		u.Status = "Active"
	}
	return u, nil
}

// UpdateUser updates an existing user resolved by username.
func (c *Client) UpdateUser(ctx context.Context, username string, u adapter.AdminUser) error {
	tok, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	uid, err := c.userID(ctx, tok, username)
	if err != nil {
		return err
	}
	if uid == "" {
		return fmt.Errorf("user %s not found", username)
	}
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodPut, c.adminBase+"/users/"+uid, hdr, writeBody(u, username), nil); err != nil {
		return fmt.Errorf("keycloak update user: %w", err)
	}
	c.invalidateUsers()
	return nil
}

// DeleteUser removes a user resolved by username.
func (c *Client) DeleteUser(ctx context.Context, username string) error {
	tok, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	uid, err := c.userID(ctx, tok, username)
	if err != nil {
		return err
	}
	if uid == "" {
		return nil
	}
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodDelete, c.adminBase+"/users/"+uid, hdr, nil, nil); err != nil {
		return fmt.Errorf("keycloak delete user: %w", err)
	}
	c.invalidateUsers()
	return nil
}

type kcSession struct {
	ID         string            `json:"id"`
	IPAddress  string            `json:"ipAddress"`
	Start      int64             `json:"start"`
	LastAccess int64             `json:"lastAccess"`
	Clients    map[string]string `json:"clients"`
}

// userID resolves a username to its Keycloak user id.
func (c *Client) userID(ctx context.Context, tok, username string) (string, error) {
	var users []kcUserBrief
	url := c.adminBase + "/users?exact=true&username=" + url.QueryEscape(username)
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, hdr, nil, &users); err != nil {
		return "", fmt.Errorf("resolve user id: %w", err)
	}
	if len(users) == 0 {
		return "", nil
	}
	return users[0].ID, nil
}

// ListSessions returns a user's active Keycloak sessions.
func (c *Client) ListSessions(ctx context.Context, username string) ([]adapter.UserSession, error) {
	tok, err := c.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	uid, err := c.userID(ctx, tok, username)
	if err != nil {
		return nil, err
	}
	if uid == "" {
		return []adapter.UserSession{}, nil
	}
	var sessions []kcSession
	url := c.adminBase + "/users/" + uid + "/sessions"
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodGet, url, hdr, nil, &sessions); err != nil {
		return nil, fmt.Errorf("keycloak sessions: %w", err)
	}
	out := make([]adapter.UserSession, 0, len(sessions))
	for _, s := range sessions {
		clients := make([]string, 0, len(s.Clients))
		for _, name := range s.Clients {
			clients = append(clients, name)
		}
		out = append(out, adapter.UserSession{
			ID:       s.ID,
			IP:       s.IPAddress,
			Started:  msToTime(s.Start),
			LastSeen: msToTime(s.LastAccess),
			Clients:  strings.Join(clients, ", "),
		})
	}
	return out, nil
}

// DeleteSession revokes one Keycloak session by id.
func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	tok, err := c.accessToken(ctx)
	if err != nil {
		return err
	}
	url := c.adminBase + "/sessions/" + sessionID
	hdr := map[string]string{"Authorization": "Bearer " + tok}
	if err := httpx.Do(ctx, c.http, http.MethodDelete, url, hdr, nil, nil); err != nil {
		return fmt.Errorf("keycloak delete session: %w", err)
	}
	return nil
}

func msToTime(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

func attr(a map[string][]string, keys ...string) string {
	for _, k := range keys {
		if v, ok := a[k]; ok && len(v) > 0 {
			return v[0]
		}
	}
	return ""
}
