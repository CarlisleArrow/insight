package codegen

import (
	"fmt"
	"strings"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

// Validate runs pre-generation checks on the IR so we never render a script that
// can't run: every table routes to a template, FKs reference real tables, SCD2
// dims declare a business key, agg tables declare at least one measure, and the
// table dependency graph is acyclic (§16 validator).
func Validate(fm pg.FullModel) []string {
	var errs []string
	if len(fm.Tables) == 0 {
		errs = append(errs, "model has no tables")
	}
	ids := map[string]pg.DwmTable{}
	names := map[string]bool{}
	for _, t := range fm.Tables {
		ids[t.TableID] = t
		if names[t.Name] {
			errs = append(errs, fmt.Sprintf("duplicate table name %q", t.Name))
		}
		names[t.Name] = true
	}

	for _, t := range fm.Tables {
		if _, err := templateFor(t); err != nil {
			errs = append(errs, err.Error())
		}
		if t.TargetNS == "" {
			errs = append(errs, fmt.Sprintf("table %q missing target namespace", t.Name))
		}
		if len(t.Columns) == 0 {
			errs = append(errs, fmt.Sprintf("table %q has no columns", t.Name))
		}
		typ := strings.ToLower(t.TableType)
		if typ == "dim" && strings.ToLower(t.ScdType) == "scd2" {
			if !hasRole(t, "business_key") {
				errs = append(errs, fmt.Sprintf("SCD2 dim %q needs at least one business_key column", t.Name))
			}
			if !hasScd2Track(t) {
				errs = append(errs, fmt.Sprintf("SCD2 dim %q needs at least one scd2_track column", t.Name))
			}
		}
		if typ == "agg" && !hasAgg(t) {
			errs = append(errs, fmt.Sprintf("agg table %q needs at least one column with an agg_func", t.Name))
		}
	}

	// FK integrity
	for _, rel := range fm.Relationships {
		if _, ok := ids[rel.FactTableID]; !ok {
			errs = append(errs, fmt.Sprintf("relationship references unknown fact table %s", rel.FactTableID))
		}
		if _, ok := ids[rel.DimTableID]; !ok {
			errs = append(errs, fmt.Sprintf("relationship references unknown dim table %s", rel.DimTableID))
		}
		if rel.FactFK == "" || rel.DimPK == "" {
			errs = append(errs, "relationship missing fact_fk or dim_pk")
		}
	}

	// acyclic check on the same edges the DAG uses
	if cyc := detectCycle(fm, ids); cyc != "" {
		errs = append(errs, "dependency cycle detected: "+cyc)
	}
	return errs
}

func hasRole(t pg.DwmTable, role string) bool {
	for _, c := range t.Columns {
		if strings.EqualFold(c.Role, role) {
			return true
		}
	}
	return false
}

func hasScd2Track(t pg.DwmTable) bool {
	for _, c := range t.Columns {
		if c.Scd2Track {
			return true
		}
	}
	return false
}

func hasAgg(t pg.DwmTable) bool {
	for _, c := range t.Columns {
		if strings.TrimSpace(c.AggFunc) != "" {
			return true
		}
	}
	return false
}

func detectCycle(fm pg.FullModel, ids map[string]pg.DwmTable) string {
	idx := map[string]string{}
	for _, t := range fm.Tables {
		idx[t.Name] = t.Name
		idx[t.TargetNS+"."+t.Name] = t.Name
		idx["iceberg."+t.TargetNS+"."+t.Name] = t.Name
	}
	adj := map[string][]string{}
	add := func(from, to string) {
		if from != "" && to != "" && from != to {
			adj[from] = append(adj[from], to)
		}
	}
	for _, t := range fm.Tables {
		ref := strings.TrimPrefix(t.SourceRef, "iceberg.")
		if up, ok := idx[ref]; ok {
			add(up, t.Name)
		} else if up, ok := idx[t.SourceRef]; ok {
			add(up, t.Name)
		}
	}
	for _, rel := range fm.Relationships {
		add(ids[rel.DimTableID].Name, ids[rel.FactTableID].Name)
	}

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := map[string]int{}
	var path []string
	var visit func(n string) string
	visit = func(n string) string {
		color[n] = gray
		path = append(path, n)
		for _, m := range adj[n] {
			switch color[m] {
			case gray:
				return strings.Join(append(path, m), " -> ")
			case white:
				if c := visit(m); c != "" {
					return c
				}
			}
		}
		path = path[:len(path)-1]
		color[n] = black
		return ""
	}
	for _, t := range fm.Tables {
		if color[t.Name] == white {
			if c := visit(t.Name); c != "" {
				return c
			}
		}
	}
	return ""
}
