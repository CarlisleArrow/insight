package ai

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Grounded-analysis prompt contract (§20.5 iron rules). The LLM only ever
// explains ALREADY-COMPUTED gold rows fed to it — it never computes SPC or any
// arithmetic-derived claim itself — and must cite the rows it used. The caller
// validates citations before returning an answer to the user.

// SemanticDoc is the retrieval unit handed to the prompt (mirrors ai_semantic).
type SemanticDoc struct {
	URN         string
	Type        string
	NL          string
	Caliber     string
	Domain      string
	Samples     string
	Rels        string
	Constraints string
	Sens        string
}

// Grounded is the parsed model output: the answer plus indexes (0-based) into
// the evidence rows that support it.
type Grounded struct {
	Answer    string `json:"answer"`
	CitedRows []int  `json:"cited_rows"`
}

// AnalyzePrompt renders the system+user prompts for /ai/analyze and /ai/assist.
// roleCtx is empty for analyze; assist passes the caller's role framing
// (management → summary/rollup tone, line role → actionable detail).
func AnalyzePrompt(question string, sem []SemanticDoc, columns []string, rows []map[string]any, roleCtx string) (string, string) {
	var sys strings.Builder
	sys.WriteString("You are the InSight data analyst. Answer ONLY from the data rows provided — they were computed by the platform's gold pipelines and masked per the caller's permissions. ")
	sys.WriteString("NEVER perform statistical recomputation (Cpk, Cp, control limits are already computed). NEVER use prior knowledge for data claims. ")
	sys.WriteString(`Respond with strict JSON: {"answer": "<concise answer>", "cited_rows": [<0-based indexes of the rows your answer relies on>]}. `)
	sys.WriteString("cited_rows MUST list every row you relied on and MUST NOT be empty when the answer makes a claim about the data.")
	if roleCtx != "" {
		sys.WriteString(" Caller context: " + roleCtx)
	}

	var usr strings.Builder
	if len(sem) > 0 {
		usr.WriteString("Semantic layer (authoritative definitions — ground your interpretation in these):\n")
		for _, d := range sem {
			usr.WriteString("- " + d.URN + " (" + d.Type + ")")
			for _, part := range []struct{ label, v string }{
				{"meaning", d.NL}, {"caliber", d.Caliber}, {"domain", d.Domain}, {"constraints", d.Constraints},
			} {
				if part.v != "" {
					usr.WriteString("; " + part.label + ": " + part.v)
				}
			}
			usr.WriteString("\n")
		}
		usr.WriteString("\n")
	}
	usr.WriteString("Data rows (index: values — already masked, already computed):\n")
	usr.WriteString("columns: " + strings.Join(columns, ", ") + "\n")
	for i, r := range rows {
		vals := make([]string, 0, len(columns))
		for _, c := range columns {
			vals = append(vals, fmt.Sprintf("%v", r[c]))
		}
		usr.WriteString(fmt.Sprintf("%d: %s\n", i, strings.Join(vals, ", ")))
	}
	usr.WriteString("\nQuestion: " + question)
	return sys.String(), usr.String()
}

// ParseGrounded extracts the JSON contract from a model reply. Models wrap JSON
// in prose or code fences at times; scan for the outermost object. Returns
// ok=false when no valid contract was found — the caller decides the fallback.
func ParseGrounded(reply string, nRows int) (Grounded, bool) {
	txt := strings.TrimSpace(reply)
	start := strings.Index(txt, "{")
	end := strings.LastIndex(txt, "}")
	if start < 0 || end <= start {
		return Grounded{Answer: txt}, false
	}
	var g Grounded
	if err := json.Unmarshal([]byte(txt[start:end+1]), &g); err != nil || g.Answer == "" {
		return Grounded{Answer: txt}, false
	}
	// Drop out-of-range citations.
	valid := g.CitedRows[:0]
	for _, i := range g.CitedRows {
		if i >= 0 && i < nRows {
			valid = append(valid, i)
		}
	}
	g.CitedRows = valid
	return g, true
}

// UnderstandPrompt renders the "test AI understanding" prompt (§20.4): explain
// an entity using ONLY its semantic-layer fields, so a human can judge whether
// the authored semantics are sufficient.
func UnderstandPrompt(d SemanticDoc) (string, string) {
	sys := "You are validating a data platform's semantic layer. Explain the entity using ONLY the provided semantics — do not use prior knowledge. If the semantics are too thin to explain the entity, say exactly what is missing. Reply with 2-4 plain sentences, no JSON."
	var usr strings.Builder
	usr.WriteString("Entity: " + d.URN + " (" + d.Type + ")\n")
	for _, part := range []struct{ label, v string }{
		{"nl_description", d.NL}, {"business_caliber", d.Caliber},
		{"domain_knowledge", d.Domain}, {"sample_values", d.Samples},
		{"relationships", d.Rels}, {"constraints", d.Constraints},
	} {
		if part.v != "" {
			usr.WriteString(part.label + ": " + part.v + "\n")
		}
	}
	usr.WriteString("\nExplain what this entity is and how it must be used.")
	return sys, usr.String()
}
