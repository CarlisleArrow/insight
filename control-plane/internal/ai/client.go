// Package ai implements the AI capability layer (§20): a provider-agnostic
// model client, the sensitive-data boundary, and the grounded-analysis prompt
// contract. It never touches the query engines — every data row an LLM sees
// comes in through the caller, who must have fetched it via the query gateway
// (masking + audit applied).
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// Model is the call target — a thin view of the registry row. SecretRef names
// the env var / mounted secret holding the API key (never the key itself).
type Model struct {
	Name      string
	Provider  string // Anthropic|OpenAI|Ollama|vLLM|Azure (case-insensitive)
	Endpoint  string
	Ref       string // provider model id, e.g. claude-opus-4-8
	SecretRef string
	Deploy    string // 'external'|'local'
	MaxTokens int
}

// Client dispatches chat calls by provider over plain HTTP.
type Client struct {
	http *http.Client
}

func NewClient(timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Client{http: &http.Client{Timeout: timeout}}
}

// Chat sends system+user prompts and returns the assistant reply text.
func (c *Client) Chat(ctx context.Context, m Model, system, user string) (string, error) {
	maxTok := m.MaxTokens
	if maxTok <= 0 {
		maxTok = 1024
	}
	switch strings.ToLower(m.Provider) {
	case "anthropic":
		return c.anthropicChat(ctx, m, system, user, maxTok)
	case "ollama":
		return c.ollamaChat(ctx, m, system, user)
	default: // openai, azure, vllm — all speak the OpenAI chat schema
		return c.openaiChat(ctx, m, system, user, maxTok)
	}
}

// TestConnection sends a short probe prompt and returns the reply + latency.
func (c *Client) TestConnection(ctx context.Context, m Model) (string, time.Duration, error) {
	t0 := time.Now()
	reply, err := c.Chat(ctx, m, "", `Reply with the single word "OK" if you can read this.`)
	return reply, time.Since(t0), err
}

// key resolves the API key from the named env var / secret ref at call time.
func key(m Model) string {
	if m.SecretRef == "" {
		return ""
	}
	return os.Getenv(m.SecretRef)
}

// baseURL normalizes the registered endpoint: local endpoints default to
// http://, external to https:// when no scheme was given.
func baseURL(m Model) string {
	ep := strings.TrimRight(m.Endpoint, "/")
	if strings.Contains(ep, "://") {
		return ep
	}
	if m.Deploy == "local" {
		return "http://" + ep
	}
	return "https://" + ep
}

func (c *Client) post(ctx context.Context, url string, hdr map[string]string, body any) ([]byte, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("model endpoint %s: HTTP %d: %s", url, res.StatusCode, truncate(string(out), 300))
	}
	return out, nil
}

func (c *Client) anthropicChat(ctx context.Context, m Model, system, user string, maxTok int) (string, error) {
	body := map[string]any{
		"model":      m.Ref,
		"max_tokens": maxTok,
		"messages":   []map[string]string{{"role": "user", "content": user}},
	}
	if system != "" {
		body["system"] = system
	}
	hdr := map[string]string{"anthropic-version": "2023-06-01"}
	if k := key(m); k != "" {
		hdr["x-api-key"] = k
	}
	raw, err := c.post(ctx, baseURL(m)+"/v1/messages", hdr, body)
	if err != nil {
		return "", err
	}
	var resp struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", fmt.Errorf("decode anthropic reply: %w", err)
	}
	var b strings.Builder
	for _, part := range resp.Content {
		b.WriteString(part.Text)
	}
	return b.String(), nil
}

func (c *Client) openaiChat(ctx context.Context, m Model, system, user string, maxTok int) (string, error) {
	msgs := []map[string]string{}
	if system != "" {
		msgs = append(msgs, map[string]string{"role": "system", "content": system})
	}
	msgs = append(msgs, map[string]string{"role": "user", "content": user})
	body := map[string]any{"model": m.Ref, "max_tokens": maxTok, "messages": msgs}
	hdr := map[string]string{}
	if k := key(m); k != "" {
		hdr["Authorization"] = "Bearer " + k
		hdr["api-key"] = k // Azure uses api-key; harmless for the others
	}
	url := baseURL(m) + "/v1/chat/completions"
	// Azure callers register the full deployment URL (…/chat/completions?api-version=…).
	if strings.Contains(m.Endpoint, "/chat/completions") {
		url = baseURL(m)
	}
	raw, err := c.post(ctx, url, hdr, body)
	if err != nil {
		return "", err
	}
	var resp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", fmt.Errorf("decode chat reply: %w", err)
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("model returned no choices")
	}
	return resp.Choices[0].Message.Content, nil
}

func (c *Client) ollamaChat(ctx context.Context, m Model, system, user string) (string, error) {
	msgs := []map[string]string{}
	if system != "" {
		msgs = append(msgs, map[string]string{"role": "system", "content": system})
	}
	msgs = append(msgs, map[string]string{"role": "user", "content": user})
	raw, err := c.post(ctx, baseURL(m)+"/api/chat", nil,
		map[string]any{"model": m.Ref, "messages": msgs, "stream": false})
	if err != nil {
		return "", err
	}
	var resp struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", fmt.Errorf("decode ollama reply: %w", err)
	}
	return resp.Message.Content, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
