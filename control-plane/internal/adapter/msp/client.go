// Package msp is the client for the MSP notification gateway — the platform's
// unified email/WeChat sender (see D:\qms\services\notification-service). The
// control plane calls it for report distribution instead of embedding SMTP /
// WeChat itself. Single endpoint: POST {api_url}/api/v1/messages, X-API-Key.
package msp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	apiURL          string
	apiKey          string
	wechatChannelID string
	wechatTemplate  string
	http            *http.Client
}

// New builds the client. Empty apiURL/apiKey → distribution disabled (Enabled()).
func New(apiURL, apiKey, wechatChannelID, wechatTemplateID string) *Client {
	return &Client{
		apiURL:          strings.TrimRight(apiURL, "/"),
		apiKey:          apiKey,
		wechatChannelID: wechatChannelID,
		wechatTemplate:  wechatTemplateID,
		http:            &http.Client{Timeout: 15 * time.Second},
	}
}

// Enabled reports whether MSP is configured (url + key present).
func (c *Client) Enabled() bool { return c.apiURL != "" && c.apiKey != "" }

type emailReq struct {
	Channel    string   `json:"channel"`
	Recipients []string `json:"recipients"`
	Subject    string   `json:"subject"`
	Content    string   `json:"content"`
	Priority   int      `json:"priority"`
}

type wechatReq struct {
	Channel         string            `json:"channel"`
	ChannelConfigID string            `json:"channel_config_id"`
	Recipients      []string          `json:"recipients"`
	Subject         string            `json:"subject"`
	Content         string            `json:"content"`
	TemplateID      string            `json:"template_id,omitempty"`
	Variables       map[string]string `json:"variables,omitempty"`
	Priority        int               `json:"priority"`
}

// SendEmail delivers an HTML email via MSP.
func (c *Client) SendEmail(ctx context.Context, recipients []string, subject, htmlBody string) error {
	if !c.Enabled() {
		return fmt.Errorf("MSP not configured")
	}
	if len(recipients) == 0 {
		return nil
	}
	return c.post(ctx, emailReq{
		Channel: "email", Recipients: recipients, Subject: subject, Content: htmlBody, Priority: 7,
	})
}

// SendWeChat delivers a WeChat Work message via MSP (template + variables).
func (c *Client) SendWeChat(ctx context.Context, recipients []string, subject string, vars map[string]string) error {
	if !c.Enabled() {
		return fmt.Errorf("MSP not configured")
	}
	if c.wechatChannelID == "" {
		return fmt.Errorf("MSP wechat channel not configured")
	}
	if len(recipients) == 0 {
		return nil
	}
	return c.post(ctx, wechatReq{
		Channel: "wechat", ChannelConfigID: c.wechatChannelID, Recipients: recipients,
		Subject: subject, Content: "", TemplateID: c.wechatTemplate, Variables: vars, Priority: 7,
	})
}

// post sends the payload with retry (network/5xx retried, 4xx permanent),
// mirroring the rust msp_client retry policy.
func (c *Client) post(ctx context.Context, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	url := c.apiURL + "/api/v1/messages"
	const maxAttempts = 3
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", c.apiKey)
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = err
		} else {
			text, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			if resp.StatusCode >= 400 && resp.StatusCode < 500 {
				return fmt.Errorf("MSP %d: %s", resp.StatusCode, strings.TrimSpace(string(text)))
			}
			lastErr = fmt.Errorf("MSP %d: %s", resp.StatusCode, strings.TrimSpace(string(text)))
		}
		if attempt < maxAttempts {
			time.Sleep(time.Duration(200*(1<<(attempt-1))) * time.Millisecond)
		}
	}
	return fmt.Errorf("MSP send failed after %d attempts: %w", maxAttempts, lastErr)
}
