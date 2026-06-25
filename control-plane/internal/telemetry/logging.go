// Package telemetry wires structured logging and Prometheus metrics for the BFF.
package telemetry

import (
	"log/slog"
	"os"
)

// NewLogger returns a JSON slog logger destined for stdout (collected by
// Vector/OpenSearch per ARCHITECTURE.md §7).
func NewLogger() *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := slog.New(h)
	slog.SetDefault(l)
	return l
}
