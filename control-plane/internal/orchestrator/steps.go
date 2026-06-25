package orchestrator

import (
	"context"
	"fmt"

	"gitlab.siptory.com/ipas/control-plane/internal/adapter"
)

// createConnector registers a Debezium connector for the source tables. The
// debezium adapter enforces the §5.4 schema-history retention guardrail.
func (o *Orchestrator) createConnector(ctx context.Context, spec Spec) (adapter.ConnectorID, error) {
	id, err := o.ingest.CreateConnector(ctx, adapter.ConnectorSpec{
		Name:        spec.Source,
		Source:      spec.Source,
		TopicPrefix: spec.Source,
		Tables:      spec.Tables,
	})
	if err != nil {
		return "", fmt.Errorf("create connector: %w", err)
	}
	return id, nil
}

// createTable creates target table metadata in the Iceberg namespace for each
// requested table.
func (o *Orchestrator) createTable(ctx context.Context, ns string, spec Spec) error {
	for _, t := range spec.Tables {
		schema := adapter.Schema{Columns: []adapter.ColumnMeta{{Name: t, Type: "string"}}}
		if err := o.catalog.CreateTable(ctx, ns, schema); err != nil {
			return fmt.Errorf("create table %s.%s: %w", ns, t, err)
		}
	}
	return nil
}

// compensations is a LIFO stack of rollback actions.
type compensations struct {
	fns []func(context.Context)
}

func (c *compensations) add(fn func(context.Context)) { c.fns = append(c.fns, fn) }

func (c *compensations) run(ctx context.Context) {
	for i := len(c.fns) - 1; i >= 0; i-- {
		c.fns[i](ctx)
	}
}

// namespaceFor maps a target layer to its Iceberg namespace (§5.5).
func namespaceFor(layer string) string {
	switch layer {
	case "Gold", "gold":
		return "gold_qms"
	case "Silver", "silver":
		return "silver_qms"
	default:
		return "bronze_qms"
	}
}

func datasetURN(ns, name string) string {
	return fmt.Sprintf("urn:li:dataset:(urn:li:dataPlatform:iceberg,%s.%s,PROD)", ns, name)
}
