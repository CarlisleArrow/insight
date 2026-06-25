package codegen

import (
	"fmt"
	"regexp"
	"strings"
)

// Custom-logic preservation (§16.3). Generated scripts wrap hand-written
// business logic (SPC, special cleansing, …) between markers:
//
//	# === BEGIN CUSTOM LOGIC (<table>:<block>) ===
//	    ...author code...
//	# === END CUSTOM LOGIC (<table>:<block>) ===
//
// On regeneration we extract the old inner text by label and re-inject it, so
// hand edits inside the block survive while everything else is overwritten.

var blockRe = regexp.MustCompile(
	`(?s)# === BEGIN CUSTOM LOGIC \(([^)]+)\) ===\n(.*?)[ \t]*# === END CUSTOM LOGIC \(([^)]+)\) ===`)

// ExtractBlocks parses existing generated content into label -> inner body.
func ExtractBlocks(content string) map[string]string {
	out := map[string]string{}
	for _, m := range blockRe.FindAllStringSubmatch(content, -1) {
		label := strings.TrimSpace(m[1])
		out[label] = m[2]
	}
	return out
}

// customResolver answers the {{ .CustomBlock "name" }} template call for one table.
type customResolver struct {
	table  string
	blocks map[string]string // label -> preserved body
}

// CustomBlock returns the preserved body for <table>:<name>, or a default
// placeholder (correctly indented) when this is a first generation.
func (c customResolver) CustomBlock(name string) string {
	label := fmt.Sprintf("%s:%s", c.table, name)
	if body, ok := c.blocks[label]; ok && strings.TrimSpace(body) != "" {
		// keep the body verbatim but ensure it ends without an extra blank trailing run
		return strings.TrimRight(body, "\n")
	}
	return "    pass  # TODO: author custom logic here (preserved across regeneration)"
}
