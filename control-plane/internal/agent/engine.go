// Package agent is the workflow engine (§21): it walks a flow's node DAG in
// topological order, executes each node through injected executors (so every
// data touch goes through the query gateway — security inheritance, no bypass),
// persists a per-node trace, and pauses at human-approval nodes until resumed.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Node is one canvas node. Type ∈ trigger|query|retrieve|ai|tool|cond|hitl|
// output|loop (front-end AG_NODE_TYPES keys). Config carries the node's typed
// settings (dataset, prompt, expression, …).
type Node struct {
	ID     string         `json:"id"`
	Type   string         `json:"type"`
	Name   string         `json:"name"`
	Sub    string         `json:"sub,omitempty"`
	X      float64        `json:"x"`
	Y      float64        `json:"y"`
	Masked bool           `json:"masked,omitempty"`
	Config map[string]any `json:"config,omitempty"`
}

// Edge connects node a → b; Label "Yes"/"No" gates condition branches.
type Edge struct {
	A     string `json:"a"`
	B     string `json:"b"`
	Label string `json:"label,omitempty"`
}

// Step is one trace entry — shaped for the front-end run-trace panel.
type Step struct {
	ID       string         `json:"id"`
	Name     string         `json:"name,omitempty"`
	Type     string         `json:"type,omitempty"`
	Dur      string         `json:"dur"`
	Status   string         `json:"status"` // ok|err|wait|skip
	Masked   bool           `json:"masked,omitempty"`
	IO       *StepIO        `json:"io,omitempty"`
	Evidence [][]string     `json:"evidence,omitempty"` // header row + data rows
	Model    string         `json:"model,omitempty"`
	Prompt   string         `json:"prompt,omitempty"`
	Reply    string         `json:"reply,omitempty"`
	Output   map[string]any `json:"output,omitempty"` // upstream vars for {{templating}}
	Approved *bool          `json:"approved,omitempty"`
}

type StepIO struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

// Result is what a node executor returns: display strings for the trace plus
// the variable map downstream templates reference as {{nodeID.key}}.
type Result struct {
	Out      string
	Vars     map[string]any
	Evidence [][]string
	Masked   bool
	Model    string
	Prompt   string
	Reply    string
}

// Executors are the platform capabilities the engine calls per node type. All
// are injected by the HTTP layer so the engine itself never touches an engine
// or an LLM endpoint directly.
type Executors struct {
	// Query runs a governed data query (gateway + L6 masking + audit).
	Query func(ctx context.Context, dataset, filter string, limit int) (Result, error)
	// Retrieve searches the semantic layer (RAG).
	Retrieve func(ctx context.Context, query string, k int) (Result, error)
	// Chat calls a registered model by name ("" = default).
	Chat func(ctx context.Context, model, prompt string) (Result, error)
	// Tool invokes a platform capability (notify, …).
	Tool func(ctx context.Context, name string, args map[string]any) (Result, error)
	// Output delivers the flow result (notification / report / write-back).
	Output func(ctx context.Context, kind, target, message string) (Result, error)
}

// Run executes (or resumes) a flow. Completed steps in prior are kept and their
// outputs feed templating; execution continues at the first unfinished node.
// Returns the final trace and status: success|failed|awaiting_approval.
func Run(ctx context.Context, nodes []Node, edges []Edge, prior []Step, ex Executors) ([]Step, string) {
	order, err := topoSort(nodes, edges)
	if err != nil {
		return append(prior, Step{ID: "flow", Dur: "0 ms", Status: "err",
			IO: &StepIO{In: "validate", Out: err.Error()}}), "failed"
	}

	byID := map[string]Node{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	// Index prior steps (resume path) and their outputs (template vars).
	done := map[string]Step{}
	vars := map[string]map[string]any{}
	trace := []Step{}
	for _, s := range prior {
		if s.ID == "flow" {
			continue
		}
		done[s.ID] = s
		if s.Output != nil {
			vars[s.ID] = s.Output
		}
		trace = append(trace, s)
	}

	// skipped tracks nodes cut off by an untaken condition branch.
	skipped := map[string]bool{}

	for _, id := range order {
		n := byID[id]
		if prev, ok := done[id]; ok {
			if prev.Status == "wait" {
				// Approval node from a previous run: approved → continue, else stay paused.
				if prev.Approved == nil {
					return trace, "awaiting_approval"
				}
				mark := func(status, out string) {
					for i := range trace {
						if trace[i].ID == id {
							trace[i].Status = status
							trace[i].Dur = "resolved"
							if trace[i].IO != nil {
								trace[i].IO.Out = out
							}
						}
					}
				}
				if !*prev.Approved {
					mark("err", "rejected by approver")
					return trace, "rejected"
				}
				mark("ok", "approved — resumed")
				continue
			}
			continue // already executed (resume)
		}
		if isSkipped(n.ID, edges, skipped, vars) {
			skipped[n.ID] = true
			step := Step{ID: n.ID, Name: n.Name, Type: n.Type, Dur: "0 ms", Status: "skip",
				IO: &StepIO{In: "branch not taken", Out: "skipped"}}
			trace = append(trace, step)
			done[n.ID] = step
			continue
		}

		step, result := execNode(ctx, n, vars, ex)
		trace = append(trace, step)
		done[n.ID] = step
		if result != nil && result.Vars != nil {
			vars[n.ID] = result.Vars
		}
		switch step.Status {
		case "err":
			return trace, "failed"
		case "wait":
			return trace, "awaiting_approval"
		}
	}
	return trace, "success"
}

// execNode runs one node and renders its trace step.
func execNode(ctx context.Context, n Node, vars map[string]map[string]any, ex Executors) (Step, *Result) {
	t0 := time.Now()
	step := Step{ID: n.ID, Name: n.Name, Type: n.Type, Status: "ok"}
	fail := func(in string, err error) (Step, *Result) {
		step.Status = "err"
		step.Dur = durStr(time.Since(t0))
		step.IO = &StepIO{In: in, Out: err.Error()}
		return step, nil
	}
	finish := func(in string, r Result) (Step, *Result) {
		step.Dur = durStr(time.Since(t0))
		step.IO = &StepIO{In: in, Out: r.Out}
		step.Evidence = r.Evidence
		step.Masked = r.Masked
		step.Model = r.Model
		step.Prompt = r.Prompt
		step.Reply = r.Reply
		step.Output = r.Vars
		return step, &r
	}

	cfg := func(key string) string { return Interpolate(strAt(n.Config, key), vars) }

	switch n.Type {
	case "trigger":
		return finish("trigger", Result{Out: "fired", Vars: map[string]any{"fired": true}})

	case "query":
		dataset := cfg("dataset")
		if dataset == "" {
			dataset = n.Sub // canvas stores the table on the subtitle
		}
		if ex.Query == nil {
			return fail(dataset, fmt.Errorf("query executor unavailable"))
		}
		r, err := ex.Query(ctx, dataset, cfg("filter"), intAt(n.Config, "limit", 20))
		if err != nil {
			return fail(dataset, err)
		}
		return finish(dataset, r)

	case "retrieve":
		q := cfg("query")
		if q == "" {
			q = n.Name
		}
		if ex.Retrieve == nil {
			return fail(q, fmt.Errorf("retrieve executor unavailable"))
		}
		r, err := ex.Retrieve(ctx, q, intAt(n.Config, "topk", 5))
		if err != nil {
			return fail(q, err)
		}
		return finish(q, r)

	case "ai":
		prompt := cfg("prompt")
		if prompt == "" {
			prompt = "Summarize the upstream results: " + flattenVars(vars)
		}
		if ex.Chat == nil {
			return fail("ai", fmt.Errorf("chat executor unavailable"))
		}
		r, err := ex.Chat(ctx, strAt(n.Config, "model"), prompt)
		if err != nil {
			return fail(truncateStr(prompt, 120), err)
		}
		return finish(truncateStr(prompt, 120), r)

	case "tool":
		name := strAt(n.Config, "tool")
		if ex.Tool == nil {
			return fail(name, fmt.Errorf("tool executor unavailable"))
		}
		args := map[string]any{}
		if m, ok := n.Config["args"].(map[string]any); ok {
			for k, v := range m {
				if s, ok := v.(string); ok {
					args[k] = Interpolate(s, vars)
				} else {
					args[k] = v
				}
			}
		}
		r, err := ex.Tool(ctx, name, args)
		if err != nil {
			return fail(name, err)
		}
		return finish(name, r)

	case "cond":
		expr := strAt(n.Config, "expr")
		if expr == "" {
			expr = n.Sub
		}
		val, err := EvalCondition(expr, vars)
		if err != nil {
			return fail(expr, err)
		}
		branch := "No"
		if val {
			branch = "Yes"
		}
		return finish(expr, Result{Out: expr + " → " + branch + " branch",
			Vars: map[string]any{"result": val, "branch": branch}})

	case "hitl":
		step.Status = "wait"
		step.Dur = "waiting"
		step.IO = &StepIO{In: strAt(n.Config, "instruction"), Out: "paused for approval"}
		return step, nil

	case "output":
		if ex.Output == nil {
			return fail("output", fmt.Errorf("output executor unavailable"))
		}
		r, err := ex.Output(ctx, strAt(n.Config, "kind"), cfg("target"), cfg("message"))
		if err != nil {
			return fail("output", err)
		}
		return finish("deliver", r)

	default: // loop and future types — recorded, not executed
		return finish(n.Type, Result{Out: "node type not executed"})
	}
}

// isSkipped reports whether every incoming active edge of a node is cut off by
// an untaken condition branch (or comes from a skipped node).
func isSkipped(id string, edges []Edge, skipped map[string]bool, vars map[string]map[string]any) bool {
	incoming := 0
	active := 0
	for _, e := range edges {
		if e.B != id {
			continue
		}
		incoming++
		if skipped[e.A] {
			continue
		}
		if e.Label != "" {
			if v, ok := vars[e.A]; ok {
				if branch, _ := v["branch"].(string); !strings.EqualFold(branch, e.Label) {
					continue
				}
			}
		}
		active++
	}
	return incoming > 0 && active == 0
}

// topoSort returns nodes in dependency order; errors on cycles (reuses the
// validator idea from codegen: Kahn's algorithm).
func topoSort(nodes []Node, edges []Edge) ([]string, error) {
	indeg := map[string]int{}
	adj := map[string][]string{}
	for _, n := range nodes {
		indeg[n.ID] = 0
	}
	for _, e := range edges {
		if _, ok := indeg[e.A]; !ok {
			continue
		}
		if _, ok := indeg[e.B]; !ok {
			continue
		}
		adj[e.A] = append(adj[e.A], e.B)
		indeg[e.B]++
	}
	queue := []string{}
	for _, n := range nodes { // keep canvas order for stable traces
		if indeg[n.ID] == 0 {
			queue = append(queue, n.ID)
		}
	}
	out := []string{}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		out = append(out, id)
		for _, next := range adj[id] {
			indeg[next]--
			if indeg[next] == 0 {
				queue = append(queue, next)
			}
		}
	}
	if len(out) != len(nodes) {
		return nil, fmt.Errorf("flow has a cycle — %d of %d nodes unreachable", len(nodes)-len(out), len(nodes))
	}
	return out, nil
}

var tmplVar = regexp.MustCompile(`\{\{\s*([\w-]+)\.([\w-]+)\s*\}\}`)

// Interpolate replaces {{nodeID.key}} with upstream output values.
func Interpolate(s string, vars map[string]map[string]any) string {
	if s == "" {
		return s
	}
	return tmplVar.ReplaceAllStringFunc(s, func(m string) string {
		g := tmplVar.FindStringSubmatch(m)
		if v, ok := vars[g[1]]; ok {
			if val, ok := v[g[2]]; ok {
				return fmt.Sprintf("%v", val)
			}
		}
		return m
	})
}

// EvalCondition evaluates "lhs op rhs" where sides are literals or
// {{node.key}} / node.key references. Numeric compare when both parse.
func EvalCondition(expr string, vars map[string]map[string]any) (bool, error) {
	for _, op := range []string{"<=", ">=", "!=", "==", "<", ">", "="} {
		i := strings.Index(expr, op)
		if i < 0 {
			continue
		}
		lhs := resolveOperand(strings.TrimSpace(expr[:i]), vars)
		rhs := resolveOperand(strings.TrimSpace(expr[i+len(op):]), vars)
		lf, lok := toF(lhs)
		rf, rok := toF(rhs)
		if lok && rok {
			switch op {
			case "<":
				return lf < rf, nil
			case ">":
				return lf > rf, nil
			case "<=":
				return lf <= rf, nil
			case ">=":
				return lf >= rf, nil
			case "==", "=":
				return lf == rf, nil
			case "!=":
				return lf != rf, nil
			}
		}
		switch op {
		case "==", "=":
			return lhs == rhs, nil
		case "!=":
			return lhs != rhs, nil
		}
		return false, fmt.Errorf("non-numeric operands for %q in %q", op, expr)
	}
	return false, fmt.Errorf("no comparison operator in %q", expr)
}

// resolveOperand turns {{n2.cpk}} or n2.cpk into its upstream value; literals
// pass through (quotes stripped).
func resolveOperand(s string, vars map[string]map[string]any) string {
	s = strings.Trim(s, `"'`)
	inner := s
	if g := tmplVar.FindStringSubmatch(s); g != nil {
		inner = g[1] + "." + g[2]
	}
	if node, key, ok := strings.Cut(inner, "."); ok {
		if v, ok := vars[node]; ok {
			if val, ok := v[key]; ok {
				return fmt.Sprintf("%v", val)
			}
		}
	}
	return s
}

func toF(s string) (float64, bool) {
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

func strAt(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}

func intAt(m map[string]any, k string, def int) int {
	if m == nil {
		return def
	}
	switch v := m[k].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func flattenVars(vars map[string]map[string]any) string {
	b, _ := json.Marshal(vars)
	return truncateStr(string(b), 2000)
}

func durStr(d time.Duration) string {
	if d < time.Second {
		return fmt.Sprintf("%d ms", d.Milliseconds())
	}
	return fmt.Sprintf("%.1f s", d.Seconds())
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
