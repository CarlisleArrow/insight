// Package orchestrator implements the "build pipeline" saga (ARCHITECTURE.md §11):
// create the Debezium connector and Iceberg table in parallel, then render the
// Airflow DAG and record status in DataHub — rolling back on any failure.
package orchestrator

import (
	"context"
	"fmt"
	"log/slog"

	"golang.org/x/sync/errgroup"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// Spec is the POST /api/pipelines request.
type Spec struct {
	Source      string   `json:"source"`       // datasource name / topic prefix
	TargetLayer string   `json:"target_layer"` // RAW|Bronze|Silver|Gold
	Schedule    string   `json:"schedule"`     // cron, e.g. "@hourly"
	Tables      []string `json:"tables"`
}

// Result is returned to the caller on success.
type Result struct {
	ConnectorID string `json:"connector_id"`
	DAGID       string `json:"dag_id"`
	Namespace   string `json:"namespace"`
}

// Orchestrator wires the adapters the saga needs.
type Orchestrator struct {
	ingest   adapter.IngestAdapter
	catalog  adapter.CatalogAdapter
	orch     adapter.OrchestrationAdapter
	metadata adapter.MetadataAdapter
	log      *slog.Logger
}

func New(set adapter.Set, log *slog.Logger) *Orchestrator {
	return &Orchestrator{
		ingest:   set.Ingest,
		catalog:  set.Catalog,
		orch:     set.Orch,
		metadata: set.Metadata,
		log:      log,
	}
}

// BuildPipeline runs the saga. On any failure it triggers the registered
// compensations in reverse order and returns the original error.
func (o *Orchestrator) BuildPipeline(ctx context.Context, spec Spec) (Result, error) {
	if spec.Source == "" || len(spec.Tables) == 0 {
		return Result{}, fmt.Errorf("source and tables are required")
	}
	ns := namespaceFor(spec.TargetLayer)

	var (
		comp   compensations
		connID adapter.ConnectorID
		res    Result
	)

	// Step group 1+2 run in parallel (independent side effects).
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		id, err := o.createConnector(gctx, spec)
		if err != nil {
			return err
		}
		connID = id
		comp.add(func(c context.Context) { _ = o.ingest.DeleteConnector(c, id) })
		return nil
	})
	g.Go(func() error {
		if err := o.createTable(gctx, ns, spec); err != nil {
			return err
		}
		// (No catalog drop API in §8; table create is idempotent metadata — left as
		// a logged no-op compensation.)
		comp.add(func(_ context.Context) { o.log.Warn("rollback: iceberg table left in place (no drop API)", "ns", ns) })
		return nil
	})
	if err := g.Wait(); err != nil {
		comp.run(ctx)
		return Result{}, fmt.Errorf("build pipeline (parallel steps): %w", err)
	}

	// Sequential: render DAG, then record status.
	dagID, err := o.orch.EnsureDAG(ctx, adapter.DAGSpec{Name: spec.Source, Schedule: spec.Schedule, Tables: spec.Tables})
	if err != nil {
		comp.run(ctx)
		return Result{}, fmt.Errorf("ensure dag: %w", err)
	}

	urn := datasetURN(ns, spec.Source)
	if err := o.metadata.UpsertStatus(ctx, urn, map[string]any{"pipeline": spec.Source, "state": "PROVISIONED"}); err != nil {
		// Status reporting is best-effort; don't roll back a working pipeline.
		o.log.Warn("datahub status upsert failed", "err", err.Error())
	}

	res = Result{ConnectorID: string(connID), DAGID: string(dagID), Namespace: ns}
	return res, nil
}
