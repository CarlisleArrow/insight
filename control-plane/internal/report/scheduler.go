// Package report provides the in-process cron scheduler that fires due report
// subscriptions. The actual run/render/deliver logic lives in the http handlers
// (it reuses the query gateway); the scheduler only owns timing and calls back.
package report

import (
	"context"
	"log/slog"
	"sync"

	"github.com/robfig/cron/v3"
)

// RunFunc executes a report by id (implemented by the http handlers).
type RunFunc func(ctx context.Context, reportID string) error

// ListFunc returns the active report schedules: id -> cron expression.
type ListFunc func(ctx context.Context) (map[string]string, error)

// Scheduler registers report cron entries and re-syncs them on demand.
type Scheduler struct {
	cron *cron.Cron
	log  *slog.Logger
	run  RunFunc
	list ListFunc

	mu      sync.Mutex
	entries map[string]cron.EntryID // reportID -> entry
}

// New builds a scheduler. cron uses standard 5-field expressions.
func New(log *slog.Logger, run RunFunc, list ListFunc) *Scheduler {
	return &Scheduler{
		cron:    cron.New(),
		log:     log,
		run:     run,
		list:    list,
		entries: map[string]cron.EntryID{},
	}
}

// Start loads schedules and starts the cron loop.
func (s *Scheduler) Start(ctx context.Context) {
	if err := s.Sync(ctx); err != nil {
		s.log.Warn("report scheduler sync", "err", err.Error())
	}
	s.cron.Start()
	s.log.Info("report scheduler started", "jobs", len(s.entries))
}

// Stop halts the cron loop, waiting for running jobs.
func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	<-ctx.Done()
}

// Sync reconciles registered cron entries with the current active reports.
func (s *Scheduler) Sync(ctx context.Context) error {
	want, err := s.list(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	// Remove entries no longer wanted (or whose schedule changed — re-added below).
	for id, eid := range s.entries {
		if _, ok := want[id]; !ok {
			s.cron.Remove(eid)
			delete(s.entries, id)
		}
	}
	// Add/replace.
	for id, expr := range want {
		if expr == "" {
			continue
		}
		// Always re-register so schedule edits take effect.
		if eid, ok := s.entries[id]; ok {
			s.cron.Remove(eid)
		}
		rid := id
		eid, err := s.cron.AddFunc(expr, func() {
			runCtx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := s.run(runCtx, rid); err != nil {
				s.log.Error("scheduled report failed", "report", rid, "err", err.Error())
			} else {
				s.log.Info("scheduled report ran", "report", rid)
			}
		})
		if err != nil {
			s.log.Warn("invalid report schedule", "report", id, "expr", expr, "err", err.Error())
			continue
		}
		s.entries[id] = eid
	}
	return nil
}
