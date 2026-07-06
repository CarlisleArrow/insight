// Package federation implements the factory side of §19: two outbound-only
// background workers. The reporter POSTs periodic health snapshots up to the
// group tower; the receiver pulls queued commands, executes them through
// injected platform capabilities, and reports results. Both are NAT-friendly
// (factory dials out; the tower never dials in) and both tolerate tower
// unavailability — the factory keeps running and retries next tick.
package federation

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Report is one factory→HQ snapshot (§19.3).
type Report struct {
	FactoryID     string             `json:"factory_id"`
	Name          string             `json:"name,omitempty"`
	Endpoint      string             `json:"endpoint,omitempty"`       // this site's control-plane base URL
	TrinoEndpoint string             `json:"trino_endpoint,omitempty"` // this site's Trino (federated drill)
	Version       string             `json:"version,omitempty"`
	Snapshot      json.RawMessage    `json:"snapshot"`          // health payload (components, pipelines, freshness)
	Metrics       map[string]float64 `json:"metrics,omitempty"` // rollup values (cpk, yield, …)
}

// Command mirrors the tower.command row a factory pulls.
type Command struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// CommandResult is reported back after execution.
type CommandResult struct {
	CommandID string `json:"command_id"`
	Status    string `json:"status"` // done|failed|rejected
	Result    string `json:"result"`
}

// Config is the shared worker configuration.
type Config struct {
	TowerEndpoint string        // e.g. https://hq.example.com — "" disables the worker
	SharedToken   string        // optional bearer for the ingest surface
	FactoryID     string
	ReportEvery   time.Duration
	PullEvery     time.Duration
}

// CollectFunc gathers this site's snapshot + rollup metrics.
type CollectFunc func(ctx context.Context) (Report, error)

// ExecuteFunc runs one tower command via existing platform capabilities and
// returns a human-readable result. An error marks the command failed; an
// ErrRejected marks it rejected (local policy said no, §19.6).
type ExecuteFunc func(ctx context.Context, cmd Command) (string, error)

// ErrRejected wraps command outcomes the local policy refused.
type ErrRejected struct{ Reason string }

func (e ErrRejected) Error() string { return "rejected: " + e.Reason }

func client() *http.Client { return &http.Client{Timeout: 30 * time.Second} }

func (c Config) url(path string) string {
	return strings.TrimRight(c.TowerEndpoint, "/") + path
}

func (c Config) do(ctx context.Context, method, u string, body any) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.SharedToken != "" {
		req.Header.Set("X-Federation-Token", c.SharedToken)
	}
	res, err := client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("%s %s: HTTP %d", method, u, res.StatusCode)
	}
	return out, nil
}

// --- Reporter -----------------------------------------------------------------

// Reporter POSTs a snapshot every ReportEvery (§19.3).
type Reporter struct {
	cfg     Config
	collect CollectFunc
	log     *slog.Logger
}

func NewReporter(cfg Config, collect CollectFunc, log *slog.Logger) *Reporter {
	return &Reporter{cfg: cfg, collect: collect, log: log}
}

// Run loops until ctx is done. Failures are logged and retried next tick.
func (r *Reporter) Run(ctx context.Context) {
	if r.cfg.TowerEndpoint == "" {
		r.log.Info("federation reporter disabled (no tower endpoint)")
		return
	}
	every := r.cfg.ReportEvery
	if every <= 0 {
		every = 60 * time.Second
	}
	r.log.Info("federation reporter started", "tower", r.cfg.TowerEndpoint, "every", every.String())
	tick := time.NewTicker(every)
	defer tick.Stop()
	r.reportOnce(ctx) // first report registers the site immediately
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			r.reportOnce(ctx)
		}
	}
}

func (r *Reporter) reportOnce(ctx context.Context) {
	rep, err := r.collect(ctx)
	if err != nil {
		r.log.Warn("federation snapshot failed", "err", err.Error())
		return
	}
	rep.FactoryID = r.cfg.FactoryID
	if _, err := r.cfg.do(ctx, http.MethodPost, r.cfg.url("/federation-ingest/report"), rep); err != nil {
		r.log.Warn("federation report failed (will retry)", "err", err.Error())
		return
	}
	r.log.Debug("federation report sent", "factory", rep.FactoryID)
}

// --- Receiver -----------------------------------------------------------------

// Receiver pulls queued commands every PullEvery and executes them (§19.4).
type Receiver struct {
	cfg  Config
	exec ExecuteFunc
	log  *slog.Logger
}

func NewReceiver(cfg Config, exec ExecuteFunc, log *slog.Logger) *Receiver {
	return &Receiver{cfg: cfg, exec: exec, log: log}
}

func (r *Receiver) Run(ctx context.Context) {
	if r.cfg.TowerEndpoint == "" {
		r.log.Info("federation receiver disabled (no tower endpoint)")
		return
	}
	every := r.cfg.PullEvery
	if every <= 0 {
		every = 30 * time.Second
	}
	r.log.Info("federation receiver started", "tower", r.cfg.TowerEndpoint, "every", every.String())
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			r.pullOnce(ctx)
		}
	}
}

func (r *Receiver) pullOnce(ctx context.Context) {
	u := r.cfg.url("/federation-ingest/commands") + "?factory_id=" + url.QueryEscape(r.cfg.FactoryID)
	raw, err := r.cfg.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		r.log.Warn("federation command pull failed (will retry)", "err", err.Error())
		return
	}
	var cmds []Command
	if err := json.Unmarshal(raw, &cmds); err != nil {
		r.log.Warn("federation command decode failed", "err", err.Error())
		return
	}
	for _, cmd := range cmds {
		res := CommandResult{CommandID: cmd.ID, Status: "done"}
		out, err := r.exec(ctx, cmd)
		switch e := err.(type) {
		case nil:
			res.Result = out
		case ErrRejected:
			res.Status, res.Result = "rejected", e.Reason
		default:
			res.Status, res.Result = "failed", err.Error()
		}
		if _, err := r.cfg.do(ctx, http.MethodPost, r.cfg.url("/federation-ingest/report-result"), res); err != nil {
			r.log.Warn("federation result report failed", "command", cmd.ID, "err", err.Error())
		}
		r.log.Info("federation command executed", "command", cmd.ID, "type", cmd.Type, "status", res.Status)
	}
}
