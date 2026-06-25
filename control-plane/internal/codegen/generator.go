// Package codegen renders the Modeling-as-Code meta-model IR (dwm_* tables) into
// runnable Spark ETL scripts and an Airflow DAG (ARCHITECTURE_SUPPLEMENT §16).
// Templates are abstracted from the proven hand-written etls/ scripts so generated
// code keeps the verified Iceberg/S3 config, day-partitioning and idempotent writes.
// Hand-written business logic is preserved across regeneration via custom blocks.
package codegen

import (
	"bytes"
	"embed"
	"fmt"
	"regexp"
	"strings"
	"text/template"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

//go:embed templates/*.tmpl
var templatesFS embed.FS

var tmplSet = template.Must(template.ParseFS(templatesFS, "templates/*.tmpl"))

// GeneratedFile is one rendered artifact (script or DAG).
type GeneratedFile struct {
	Name    string `json:"name"`    // e.g. salesmodel_dim_product.py
	Content string `json:"content"` // full rendered source
	Kind    string `json:"kind"`    // etl | dag
	Table   string `json:"table,omitempty"`
}

type relCtx struct{ DimNS, DimName, FactFK, DimPK string }

type tableCtx struct {
	ModelID       string
	ModelName     string
	Layer         string
	TableType     string
	Table         pg.DwmTable
	Relationships []relCtx
	customResolver
}

type dagTask struct{ ID, Script string }
type dagEdge struct{ From, To string }

type dagCtx struct {
	ModelID   string
	ModelName string
	DagID     string
	Owner     string
	Schedule  string
	Domain    string
	Tasks     []dagTask
	Edges     []dagEdge
}

var sanitizeRe = regexp.MustCompile(`[^a-z0-9_]+`)

func sanitize(s string) string {
	return strings.Trim(sanitizeRe.ReplaceAllString(strings.ToLower(s), "_"), "_")
}

func scriptName(modelName, tableName string) string {
	return fmt.Sprintf("%s_%s.py", sanitize(modelName), sanitize(tableName))
}

// templateFor routes a table to its template by (layer, table_type).
func templateFor(t pg.DwmTable) (string, error) {
	layer := strings.ToLower(t.Layer)
	typ := strings.ToLower(t.TableType)
	switch {
	case typ == "sync":
		return "clickhouse_sync.py.tmpl", nil
	case layer == "bronze":
		return "raw_to_bronze.py.tmpl", nil
	case layer == "silver" && typ == "dim":
		return "dim_scd2.py.tmpl", nil
	case layer == "silver" && typ == "fact":
		return "fact.py.tmpl", nil
	case layer == "gold" && typ == "agg":
		return "gold_simple_agg.py.tmpl", nil
	default:
		return "", fmt.Errorf("no template for layer=%q type=%q (table %s)", t.Layer, t.TableType, t.Name)
	}
}

// Generate renders every table's ETL plus the orchestrating DAG. `existing` maps a
// previously-generated filename to its content so custom blocks survive regeneration.
func Generate(fm pg.FullModel, existing map[string]string) ([]GeneratedFile, error) {
	model := fm.Model
	tableByID := map[string]pg.DwmTable{}
	for _, t := range fm.Tables {
		tableByID[t.TableID] = t
	}

	var out []GeneratedFile
	for _, t := range fm.Tables {
		tmplName, err := templateFor(t)
		if err != nil {
			return nil, err
		}
		fname := scriptName(model.Name, t.Name)

		// gather this fact's dim joins from relationships
		var rels []relCtx
		for _, rel := range fm.Relationships {
			if rel.FactTableID != t.TableID {
				continue
			}
			dim := tableByID[rel.DimTableID]
			rels = append(rels, relCtx{DimNS: dim.TargetNS, DimName: dim.Name, FactFK: rel.FactFK, DimPK: rel.DimPK})
		}

		ctx := tableCtx{
			ModelID:       model.ModelID,
			ModelName:     model.Name,
			Layer:         t.Layer,
			TableType:     t.TableType,
			Table:         t,
			Relationships: rels,
			customResolver: customResolver{
				table:  t.Name,
				blocks: ExtractBlocks(existing[fname]),
			},
		}
		var buf bytes.Buffer
		if err := tmplSet.ExecuteTemplate(&buf, tmplName, ctx); err != nil {
			return nil, fmt.Errorf("render %s: %w", fname, err)
		}
		out = append(out, GeneratedFile{Name: fname, Content: buf.String(), Kind: "etl", Table: t.Name})
	}

	dag, err := renderDAG(fm, tableByID)
	if err != nil {
		return nil, err
	}
	out = append(out, dag)
	return out, nil
}

func renderDAG(fm pg.FullModel, tableByID map[string]pg.DwmTable) (GeneratedFile, error) {
	model := fm.Model
	owner := model.Owner
	if owner == "" {
		owner = "data-platform"
	}
	domain := model.Domain
	if domain == "" {
		domain = "default"
	}

	// identifier index for dependency resolution
	idx := map[string]string{}
	for _, t := range fm.Tables {
		idx[t.Name] = t.Name
		idx[t.TargetNS+"."+t.Name] = t.Name
		idx["iceberg."+t.TargetNS+"."+t.Name] = t.Name
	}

	var tasks []dagTask
	for _, t := range fm.Tables {
		tasks = append(tasks, dagTask{ID: sanitize(t.Name), Script: scriptName(model.Name, t.Name)})
	}

	var edges []dagEdge
	seen := map[string]bool{}
	addEdge := func(from, to string) {
		from, to = sanitize(from), sanitize(to)
		if from == "" || to == "" || from == to {
			return
		}
		k := from + ">" + to
		if !seen[k] {
			seen[k] = true
			edges = append(edges, dagEdge{From: from, To: to})
		}
	}
	for _, t := range fm.Tables {
		ref := strings.TrimPrefix(t.SourceRef, "iceberg.")
		if up, ok := idx[ref]; ok {
			addEdge(up, t.Name)
		} else if up, ok := idx[t.SourceRef]; ok {
			addEdge(up, t.Name)
		}
	}
	for _, rel := range fm.Relationships {
		fact := tableByID[rel.FactTableID]
		dim := tableByID[rel.DimTableID]
		addEdge(dim.Name, fact.Name)
	}

	ctx := dagCtx{
		ModelID:   model.ModelID,
		ModelName: model.Name,
		DagID:     sanitize(model.Name),
		Owner:     owner,
		Schedule:  "@daily",
		Domain:    sanitize(domain),
		Tasks:     tasks,
		Edges:     edges,
	}
	var buf bytes.Buffer
	if err := tmplSet.ExecuteTemplate(&buf, "dag.py.tmpl", ctx); err != nil {
		return GeneratedFile{}, fmt.Errorf("render dag: %w", err)
	}
	return GeneratedFile{Name: "model_" + sanitize(model.Name) + "_dag.py", Content: buf.String(), Kind: "dag"}, nil
}
