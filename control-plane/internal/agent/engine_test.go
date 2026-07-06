package agent

import (
	"context"
	"fmt"
	"testing"
)

func testExecutors() Executors {
	return Executors{
		Query: func(_ context.Context, dataset, filter string, limit int) (Result, error) {
			return Result{
				Out:      "3 rows from " + dataset,
				Vars:     map[string]any{"cpk": 0.74, "rows": 3},
				Evidence: [][]string{{"process_id", "cpk"}, {"P1", "0.74"}},
				Masked:   true,
			}, nil
		},
		Retrieve: func(_ context.Context, q string, k int) (Result, error) {
			return Result{Out: "2 chunks", Vars: map[string]any{"retrieved": "cpk definition"}}, nil
		},
		Chat: func(_ context.Context, model, prompt string) (Result, error) {
			return Result{Out: "drafted", Vars: map[string]any{"reply": "plan"},
				Model: "test-model", Prompt: prompt, Reply: "plan"}, nil
		},
		Output: func(_ context.Context, kind, target, msg string) (Result, error) {
			return Result{Out: "delivered to " + target, Vars: map[string]any{"delivered": true}}, nil
		},
	}
}

func flow() ([]Node, []Edge) {
	nodes := []Node{
		{ID: "n1", Type: "trigger", Name: "On breach"},
		{ID: "n2", Type: "query", Name: "Query capability", Config: map[string]any{"dataset": "gold.spc_capability_daily"}},
		{ID: "n3", Type: "ai", Name: "Draft", Config: map[string]any{"prompt": "Cpk is {{n2.cpk}} — draft a plan"}},
		{ID: "n4", Type: "cond", Name: "Severity gate", Config: map[string]any{"expr": "n2.cpk < 0.8"}},
		{ID: "n5", Type: "hitl", Name: "Approval"},
		{ID: "n6", Type: "output", Name: "Notify", Config: map[string]any{"target": "#quality"}},
	}
	edges := []Edge{
		{A: "n1", B: "n2"}, {A: "n2", B: "n3"}, {A: "n3", B: "n4"},
		{A: "n4", B: "n5", Label: "Yes"}, {A: "n4", B: "n6", Label: "No"}, {A: "n5", B: "n6"},
	}
	return nodes, edges
}

// TestRunPausesAtApprovalAndResumes pins §21.5: hitl pauses the run; approving
// resumes to completion with the full trace preserved.
func TestRunPausesAtApprovalAndResumes(t *testing.T) {
	nodes, edges := flow()
	trace, status := Run(context.Background(), nodes, edges, nil, testExecutors())
	if status != "awaiting_approval" {
		t.Fatalf("status = %s, want awaiting_approval", status)
	}
	var wait *Step
	for i := range trace {
		if trace[i].ID == "n5" {
			wait = &trace[i]
		}
	}
	if wait == nil || wait.Status != "wait" {
		t.Fatalf("approval step missing or not waiting: %+v", wait)
	}
	// The AI prompt must have been interpolated from the query output.
	for _, s := range trace {
		if s.ID == "n3" && s.Prompt != "Cpk is 0.74 — draft a plan" {
			t.Fatalf("prompt interpolation failed: %q", s.Prompt)
		}
		if s.ID == "n2" && (!s.Masked || len(s.Evidence) == 0) {
			t.Fatalf("query step must carry masked evidence: %+v", s)
		}
	}

	// Approve and resume.
	yes := true
	wait.Approved = &yes
	trace2, status2 := Run(context.Background(), nodes, edges, trace, testExecutors())
	if status2 != "success" {
		t.Fatalf("resumed status = %s, want success (trace %+v)", status2, trace2)
	}
	found := false
	for _, s := range trace2 {
		if s.ID == "n6" && s.Status == "ok" {
			found = true
		}
	}
	if !found {
		t.Fatal("output node did not run after approval")
	}
}

// TestConditionBranchSkips pins branch gating: when the condition is false the
// Yes-branch approval is skipped and the No-branch output runs directly.
func TestConditionBranchSkips(t *testing.T) {
	nodes, edges := flow()
	ex := testExecutors()
	ex.Query = func(_ context.Context, dataset, filter string, limit int) (Result, error) {
		return Result{Out: "1 row", Vars: map[string]any{"cpk": 1.4}}, nil
	}
	trace, status := Run(context.Background(), nodes, edges, nil, ex)
	if status != "success" {
		t.Fatalf("status = %s, want success", status)
	}
	statuses := map[string]string{}
	for _, s := range trace {
		statuses[s.ID] = s.Status
	}
	if statuses["n5"] != "skip" {
		t.Fatalf("approval should be skipped on No branch, got %q", statuses["n5"])
	}
	if statuses["n6"] != "ok" {
		t.Fatalf("output should still run, got %q", statuses["n6"])
	}
}

// TestCycleDetected pins DAG validation.
func TestCycleDetected(t *testing.T) {
	nodes := []Node{{ID: "a", Type: "trigger"}, {ID: "b", Type: "cond"}}
	edges := []Edge{{A: "a", B: "b"}, {A: "b", B: "a"}}
	_, status := Run(context.Background(), nodes, edges, nil, testExecutors())
	if status != "failed" {
		t.Fatalf("cycle must fail the run, got %s", status)
	}
}

// TestExecutorErrorFailsRun pins error propagation into the trace.
func TestExecutorErrorFailsRun(t *testing.T) {
	nodes, edges := flow()
	ex := testExecutors()
	ex.Query = func(_ context.Context, dataset, filter string, limit int) (Result, error) {
		return Result{}, fmt.Errorf("boom")
	}
	trace, status := Run(context.Background(), nodes, edges, nil, ex)
	if status != "failed" {
		t.Fatalf("status = %s, want failed", status)
	}
	for _, s := range trace {
		if s.ID == "n2" && (s.Status != "err" || s.IO == nil || s.IO.Out != "boom") {
			t.Fatalf("query error not traced: %+v", s)
		}
	}
}

func TestEvalCondition(t *testing.T) {
	vars := map[string]map[string]any{"n2": {"cpk": 0.74, "plant": "A"}}
	for expr, want := range map[string]bool{
		"n2.cpk < 0.8":        true,
		"n2.cpk >= 1.0":       false,
		"{{n2.cpk}} == 0.74":  true,
		"n2.plant == A":       true,
		`n2.plant != "B"`:     true,
	} {
		got, err := EvalCondition(expr, vars)
		if err != nil {
			t.Fatalf("EvalCondition(%q): %v", expr, err)
		}
		if got != want {
			t.Errorf("EvalCondition(%q) = %v, want %v", expr, got, want)
		}
	}
	if _, err := EvalCondition("no operator here", vars); err == nil {
		t.Error("expected error for missing operator")
	}
}
