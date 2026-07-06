package ai

import "testing"

// TestBoundary pins §20.3: Confidential/Restricted → local-only.
func TestBoundary(t *testing.T) {
	cases := []struct {
		deploy, sens string
		want         bool
	}{
		{"local", "Public", true},
		{"local", "Restricted", true},
		{"external", "Public", true},
		{"external", "Internal", true},
		{"external", "Confidential", false},
		{"external", "Restricted", false},
		{"external", "", true}, // unclassified treated as Public-tier
	}
	for _, c := range cases {
		if got := AllowedForData(c.deploy, c.sens); got != c.want {
			t.Errorf("AllowedForData(%s,%s) = %v, want %v", c.deploy, c.sens, got, c.want)
		}
	}
	if err := CheckBoundary("gpt", "external", "Confidential"); err == nil {
		t.Error("CheckBoundary should block external+Confidential")
	}
	if err := CheckBoundary("qwen", "local", "Restricted"); err != nil {
		t.Errorf("CheckBoundary local should pass: %v", err)
	}
}

func TestMaxSensitivity(t *testing.T) {
	if got := MaxSensitivity("Public", "Restricted", "Internal"); got != "Restricted" {
		t.Errorf("MaxSensitivity = %s, want Restricted", got)
	}
	if got := MaxSensitivity(); got != "Public" {
		t.Errorf("MaxSensitivity() = %s, want Public", got)
	}
}

// TestParseGrounded pins the §20.5 citation contract: JSON extracted from
// prose/fences, out-of-range citations dropped, non-JSON falls back.
func TestParseGrounded(t *testing.T) {
	g, ok := ParseGrounded("Here you go:\n```json\n{\"answer\":\"P1 is worst\",\"cited_rows\":[0,2,9]}\n```", 3)
	if !ok || g.Answer != "P1 is worst" {
		t.Fatalf("parse failed: %+v ok=%v", g, ok)
	}
	if len(g.CitedRows) != 2 { // 9 out of range for nRows=3
		t.Fatalf("cited = %v, want [0 2]", g.CitedRows)
	}

	g, ok = ParseGrounded("plain text answer without JSON", 3)
	if ok {
		t.Fatal("plain text must not parse as grounded")
	}
	if g.Answer == "" {
		t.Fatal("fallback answer must keep the reply text")
	}
}
