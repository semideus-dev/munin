/**
 * The Phase 3 detector registry: the two repeated-work rules. Phase 4 adds the
 * rest. `detectFindings` (from analyze/findings.ts) runs these; a detector
 * that throws becomes an `AnalysisError` with its rule name, never silence.
 */
import type { FindingDetector } from "../../domain/finding.js";
import { detectRepeatToolCalls } from "./repeat-tool-calls.js";
import { detectRepeatedContext, REPEATED_CONTEXT_THRESHOLDS } from "./repeated-context.js";

export { detectRepeatToolCalls } from "./repeat-tool-calls.js";
export { detectRepeatedContext, REPEATED_CONTEXT_THRESHOLDS } from "./repeated-context.js";

export const DETECTORS: readonly FindingDetector[] = [
  { rule: "repeat-tool-calls", run: detectRepeatToolCalls },
  { rule: "repeated-context", run: detectRepeatedContext },
];
