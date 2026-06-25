package codegen

import (
	"strings"
	"testing"

	pg "gitlab.siptory.com/ipas/control-plane/internal/store/postgres"
)

func sampleModel() pg.FullModel {
	dim := pg.DwmTable{
		TableID: "t-dim", Name: "dim_product", Layer: "silver", TableType: "dim",
		TargetNS: "silver_qms", ScdType: "scd2", SourceRef: "bronze_qms.products",
		Columns: []pg.DwmColumn{
			{Name: "product_code", Dtype: "string", Role: "business_key"},
			{Name: "product_name", Dtype: "string", Scd2Track: true},
		},
	}
	fact := pg.DwmTable{
		TableID: "t-fact", Name: "fact_sales", Layer: "silver", TableType: "fact",
		TargetNS: "silver_qms", SourceRef: "bronze_qms.sales",
		Columns: []pg.DwmColumn{
			{Name: "product_code", Dtype: "string"},
			{Name: "amount", Dtype: "double"},
		},
	}
	bronze := pg.DwmTable{
		TableID: "t-bronze", Name: "products", Layer: "bronze", TableType: "dim",
		TargetNS: "bronze_qms", SourceRef: "s3a://raw/products",
		Columns: []pg.DwmColumn{{Name: "product_code", Dtype: "string"}},
	}
	agg := pg.DwmTable{
		TableID: "t-agg", Name: "agg_sales_daily", Layer: "gold", TableType: "agg",
		TargetNS: "gold_qms", SourceRef: "silver_qms.fact_sales",
		Columns: []pg.DwmColumn{
			{Name: "product_code", Dtype: "string", Role: "attribute"},
			{Name: "amount", Dtype: "double", AggFunc: "sum"},
		},
	}
	return pg.FullModel{
		Model:  pg.DwmModel{ModelID: "m1", Name: "Sales Model", Domain: "sales", Owner: "alice"},
		Tables: []pg.DwmTable{bronze, dim, fact, agg},
		Relationships: []pg.DwmRelationship{
			{FactTableID: "t-fact", DimTableID: "t-dim", FactFK: "product_code", DimPK: "product_code"},
		},
	}
}

func TestValidatePasses(t *testing.T) {
	if errs := Validate(sampleModel()); len(errs) != 0 {
		t.Fatalf("expected valid model, got: %v", errs)
	}
}

func TestValidateCatchesBadScd2(t *testing.T) {
	fm := sampleModel()
	// strip business_key + scd2_track from the dim
	for i := range fm.Tables {
		if fm.Tables[i].Name == "dim_product" {
			fm.Tables[i].Columns = []pg.DwmColumn{{Name: "x", Dtype: "string"}}
		}
	}
	if errs := Validate(fm); len(errs) == 0 {
		t.Fatal("expected validation errors for SCD2 dim without keys")
	}
}

func TestGenerateRendersAllTablesAndDAG(t *testing.T) {
	files, err := Generate(sampleModel(), nil)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	// 4 etl scripts + 1 dag
	if len(files) != 5 {
		t.Fatalf("expected 5 files, got %d", len(files))
	}
	var dags, etls int
	for _, f := range files {
		switch f.Kind {
		case "dag":
			dags++
			if !strings.Contains(f.Content, "model_sales_model") {
				t.Errorf("dag missing dag_id: %s", f.Content)
			}
			// fact depends on dim (relationship) and dim/bronze ordering present
			if !strings.Contains(f.Content, ">>") {
				t.Errorf("dag has no dependency edges")
			}
		case "etl":
			etls++
			if !strings.Contains(f.Content, "AUTO-GENERATED") {
				t.Errorf("%s missing AUTO-GENERATED header", f.Name)
			}
			if !strings.Contains(f.Content, "build_spark") {
				t.Errorf("%s missing spark header", f.Name)
			}
		}
	}
	if dags != 1 || etls != 4 {
		t.Fatalf("expected 1 dag + 4 etl, got %d dag %d etl", dags, etls)
	}
}

func TestCustomBlockPreserved(t *testing.T) {
	files, err := Generate(sampleModel(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var dimFile string
	for _, f := range files {
		if f.Name == "sales_model_dim_product.py" {
			dimFile = f.Content
		}
	}
	if dimFile == "" {
		t.Fatal("dim_product script not generated")
	}
	// inject hand-written logic into the custom block, then regenerate
	marker := "# === BEGIN CUSTOM LOGIC (dim_product:transform) ==="
	endMarker := "# === END CUSTOM LOGIC (dim_product:transform) ==="
	custom := "    df = df.filter(df.product_name.isNotNull())  # HANDWRITTEN"
	start := strings.Index(dimFile, marker) + len(marker)
	end := strings.Index(dimFile, endMarker)
	edited := dimFile[:start] + "\n" + custom + "\n    " + dimFile[end:]

	files2, err := Generate(sampleModel(), map[string]string{"sales_model_dim_product.py": edited})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files2 {
		if f.Name == "sales_model_dim_product.py" {
			if !strings.Contains(f.Content, "HANDWRITTEN") {
				t.Fatalf("custom block not preserved on regeneration:\n%s", f.Content)
			}
			return
		}
	}
	t.Fatal("regenerated dim_product not found")
}
