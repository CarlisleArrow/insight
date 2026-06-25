// Package authz resolves fine-grained data-access policy (ARCHITECTURE.md §2.2
// ABAC layer) for a subject's Keycloak groups against a query target. It reads
// the acl_* tables via the postgres store and produces the row filters + column
// policies that the L6 rewrite service applies.
package authz

import (
	"context"
	"fmt"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Target identifies the (catalog, schema, table) a policy applies to.
type Target struct {
	Catalog string
	Schema  string
	Table   string
}

// Decision is the resolved policy set for one subject against one target.
type Decision struct {
	RowFilters     []string         // raw filter_expr strings, AND-combined downstream
	ColumnPolicies []ColumnMaskSpec // per-column masking instruction
}

// ColumnMaskSpec is the rewrite-service contract for one masked column.
type ColumnMaskSpec struct {
	Column   string `json:"column"`
	MaskType string `json:"mask_type"` // deny|full|partial|hash|none
	MaskExpr string `json:"mask_expr,omitempty"`
}

// Resolver loads policies for groups against a target.
type Resolver struct {
	store *pg.Store
}

func NewResolver(store *pg.Store) *Resolver { return &Resolver{store: store} }

// Resolve loads the enabled row + column policies that apply to the given
// Keycloak groups for the target. An empty Decision means fully visible.
func (r *Resolver) Resolve(ctx context.Context, groups []string, t Target) (Decision, error) {
	if len(groups) == 0 {
		return Decision{}, nil
	}
	subjectIDs, err := r.store.SubjectIDsForGroups(ctx, groups)
	if err != nil {
		return Decision{}, fmt.Errorf("resolve subjects: %w", err)
	}
	if len(subjectIDs) == 0 {
		return Decision{}, nil
	}

	rowPols, err := r.store.RowPoliciesFor(ctx, subjectIDs, t.Catalog, t.Schema, t.Table)
	if err != nil {
		return Decision{}, err
	}
	colPols, err := r.store.ColumnPoliciesFor(ctx, subjectIDs, t.Catalog, t.Schema, t.Table)
	if err != nil {
		return Decision{}, err
	}

	d := Decision{}
	for _, rp := range rowPols {
		d.RowFilters = append(d.RowFilters, rp.FilterExpr)
	}
	for _, cp := range colPols {
		if cp.MaskType == "" || cp.MaskType == "none" {
			continue
		}
		d.ColumnPolicies = append(d.ColumnPolicies, ColumnMaskSpec{
			Column:   cp.ColumnName,
			MaskType: cp.MaskType,
			MaskExpr: cp.MaskExpr,
		})
	}
	return d, nil
}
