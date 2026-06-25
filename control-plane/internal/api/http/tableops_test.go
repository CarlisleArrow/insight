package http

import "testing"

func TestSchemaAlterToSQL(t *testing.T) {
	cases := []struct {
		req      schemaAlterReq
		want     string
		wantErr  bool
		destruct bool
	}{
		{schemaAlterReq{Op: "add", Column: "qty", DataType: "integer"},
			`ALTER TABLE iceberg."s"."t" ADD COLUMN qty integer`, false, false},
		{schemaAlterReq{Op: "rename", Column: "a", NewName: "b"},
			`ALTER TABLE iceberg."s"."t" RENAME COLUMN a TO b`, false, false},
		{schemaAlterReq{Op: "widen", Column: "n", DataType: "bigint"},
			`ALTER TABLE iceberg."s"."t" ALTER COLUMN n SET DATA TYPE bigint`, false, false},
		{schemaAlterReq{Op: "drop", Column: "old"},
			`ALTER TABLE iceberg."s"."t" DROP COLUMN old`, false, true},
		{schemaAlterReq{Op: "add", Column: "bad name", DataType: "int"}, "", true, false},
		{schemaAlterReq{Op: "frobnicate"}, "", true, false},
	}
	for _, c := range cases {
		got, err := c.req.toSQL("s", "t")
		if c.wantErr {
			if err == nil {
				t.Errorf("%+v: expected error", c.req)
			}
			continue
		}
		if err != nil {
			t.Errorf("%+v: unexpected error %v", c.req, err)
			continue
		}
		if got != c.want {
			t.Errorf("%+v:\n got %q\nwant %q", c.req, got, c.want)
		}
		if c.req.destructive() != c.destruct {
			t.Errorf("%+v: destructive=%v want %v", c.req, c.req.destructive(), c.destruct)
		}
	}
}

func TestPatchToSQL(t *testing.T) {
	if _, err := (patchReq{Op: "delete"}).toSQL("s", "t"); err == nil {
		t.Error("expected error for delete without where (unbounded patch)")
	}
	got, err := (patchReq{Op: "delete", Where: "id = 5"}).toSQL("s", "t")
	if err != nil || got != `DELETE FROM iceberg."s"."t" WHERE id = 5` {
		t.Errorf("delete: got %q err %v", got, err)
	}
	got, err = (patchReq{Op: "update", Where: "id = 5", Set: map[string]string{"status": "'fixed'"}}).toSQL("s", "t")
	if err != nil || got != `UPDATE iceberg."s"."t" SET status = 'fixed' WHERE id = 5` {
		t.Errorf("update: got %q err %v", got, err)
	}
	if _, err := (patchReq{Op: "update", Where: "1=1", Set: map[string]string{"bad col": "1"}}).toSQL("s", "t"); err == nil {
		t.Error("expected error for invalid set column")
	}
}

func TestValidIdent(t *testing.T) {
	for _, ok := range []string{"abc", "a_1", "Table9"} {
		if !validIdent(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"a b", "a;drop", "a.b", "", `a"b`} {
		if validIdent(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}
