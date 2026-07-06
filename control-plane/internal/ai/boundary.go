package ai

import "fmt"

// Data-boundary enforcement (§20.3): data classified Confidential or Restricted
// may only be processed by locally-deployed models — prompts carrying it never
// leave the cluster. External models are capped at Public/Internal.

// sensRank orders the sensitivity ladder; unknown labels are treated as
// Internal (safe-ish default: still blocked from nothing, allowed everywhere
// an Internal row is).
var sensRank = map[string]int{"Public": 0, "Internal": 1, "Confidential": 2, "Restricted": 3}

// AllowedForData reports whether a model deployment may process data at the
// given sensitivity level.
func AllowedForData(deploy, sensitivity string) bool {
	if deploy == "local" {
		return true
	}
	return sensRank[sensitivity] < sensRank["Confidential"]
}

// CheckBoundary returns a descriptive error when the boundary blocks the call.
func CheckBoundary(modelName, deploy, sensitivity string) error {
	if AllowedForData(deploy, sensitivity) {
		return nil
	}
	return fmt.Errorf("data boundary: %s-classified data may not be sent to external model %q — use a local model", sensitivity, modelName)
}

// MaxSensitivity returns the highest sensitivity among the given labels.
func MaxSensitivity(labels ...string) string {
	max := "Public"
	for _, l := range labels {
		if sensRank[l] > sensRank[max] {
			max = l
		}
	}
	return max
}
