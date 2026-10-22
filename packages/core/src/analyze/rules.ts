/**
 * Phase 4 rule registry.
 *
 * Rule metadata lives here as plain data so recommendations and apply/undo can
 * address rules by stable id. The detector list is derived from this registry.
 */
import type {
  DetectionContext,
  FindingCategory,
  FindingDetector,
  FindingDraft,
  FindingTier,
  VerificationMode,
} from "../domain/finding.js";
import type { ReplayKind } from "../domain/verification.js";
import { detectRepeatToolCalls } from "./findings/repeat-tool-calls.js";
import { detectRepeatedContext } from "./findings/repeated-context.js";
import {
  detectCacheChurn,
  detectColdResume,
  detectContextCompaction,
  detectCostSpike,
  detectErrorLoops,
  detectHeavyStart,
  detectModelDefault,
  detectModelFit,
  detectOversizedInput,
  detectOversizedOutput,
  detectOversizedToolOutput,
  detectPricingChange,
  detectPromptBloat,
  detectReasoningEffort,
  detectSpendConcentration,
} from "./rules/ported.js";

export type RuleId =
  | "pricing-change"
  | "cost-spike"
  | "spend-concentration"
  | "cache-churn"
  | "repeat-tool-calls"
  | "repeated-context"
  | "prompt-bloat"
  | "oversized-input"
  | "oversized-output"
  | "oversized-tool-output"
  | "error-loops"
  | "model-fit"
  | "reasoning-effort"
  | "context-compaction"
  | "cold-resume"
  | "heavy-start"
  | "model-default";

export interface RuleDefinition {
  id: RuleId;
  description: string;
  rationale: string;
  action: string;
  category: FindingCategory;
  tier: FindingTier;
  verificationMode: VerificationMode;
  /** Replay strategy for replay-gated rules; null for manual/not-required rules. */
  replayKind: ReplayKind | null;
  /** "Yes" means the implementation never writes Claude-specific surfaces. */
  claudeSafe: "Yes" | "No";
  run: (context: DetectionContext) => readonly FindingDraft[];
}

/**
 * Step 1 starts with the two Phase 3 rules. Step 2 adds more entries.
 *
 * Keep ids stable and byte-for-byte identical to the reference registry.
 */
export const RULES: readonly RuleDefinition[] = [
  {
    id: "pricing-change",
    description: "Observed effective pricing moved over the observed window.",
    rationale: "A changed effective rate shifts which optimizations matter first.",
    action: "Re-evaluate defaults and optimization order under the changed rate.",
    category: "pricing",
    tier: "test",
    verificationMode: "manual",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectPricingChange,
  },
  {
    id: "cost-spike",
    description: "Day-level spend anomaly above recent baseline.",
    rationale: "Spikes often expose avoidable retry/context/model drift patterns.",
    action: "Inspect the spike window by model/session and isolate root cause.",
    category: "anomaly",
    tier: "test",
    verificationMode: "manual",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectCostSpike,
  },
  {
    id: "spend-concentration",
    description: "A narrow lane carries most spend.",
    rationale: "Concentration creates high-leverage optimization targets.",
    action: "Prioritize the dominant lane for optimization and guardrails.",
    category: "concentration",
    tier: "test",
    verificationMode: "manual",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectSpendConcentration,
  },
  {
    id: "cache-churn",
    description: "Low cache reuse on substantial input traffic.",
    rationale: "Miss-heavy prefixes re-bill input that should hit cache.",
    action: "Stabilize and reuse cacheable prefixes.",
    category: "caching",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectCacheChurn,
  },
  {
    id: "repeat-tool-calls",
    description: "Duplicate read-only tool calls in the same context.",
    rationale:
      "The same content was fetched again without an intervening change, so duplicate results are re-written into context and re-read by later calls.",
    action: "Stop duplicate reads in the same context; reuse earlier results or narrow the read.",
    category: "context-bloat",
    tier: "fix",
    verificationMode: "not-required",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectRepeatToolCalls,
  },
  {
    id: "repeated-context",
    description: "Shared instruction prefixes are re-sent uncached across sessions.",
    rationale:
      "Several sessions resend the same prefix on the same agent/model identity, paying input rates again where cached rates could apply.",
    action: "Move shared prefixes to a longer-lived cached context and verify quality.",
    category: "caching",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectRepeatedContext,
  },
  {
    id: "prompt-bloat",
    description: "Instruction payload dominates repeated request input.",
    rationale: "Repeatedly paying for oversized prompt scaffolding wastes input budget.",
    action: "Trim and consolidate repeated instruction payload.",
    category: "context-bloat",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectPromptBloat,
  },
  {
    id: "oversized-input",
    description: "Calls with unusually large input payloads.",
    rationale: "Oversized input increases repeated per-call spend.",
    action: "Reduce carried context and target input more narrowly.",
    category: "context-bloat",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectOversizedInput,
  },
  {
    id: "oversized-output",
    description: "Calls with unusually large output payloads.",
    rationale: "Long outputs cost more and are often partially unused later.",
    action: "Constrain output format/length where suitable.",
    category: "context-bloat",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectOversizedOutput,
  },
  {
    id: "oversized-tool-output",
    description: "Tool responses injected into context are overly large.",
    rationale: "Large tool dumps inflate downstream input and repeated reads.",
    action: "Use ranges/summaries instead of full tool-output dumps.",
    category: "context-bloat",
    tier: "fix",
    verificationMode: "not-required",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectOversizedToolOutput,
  },
  {
    id: "error-loops",
    description: "Repeated failing calls in the same lane.",
    rationale: "Retry loops burn tokens and spend without advancing work.",
    action: "Add retry guards/backoff and stop repeated failing shapes.",
    category: "retries",
    tier: "fix",
    verificationMode: "not-required",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectErrorLoops,
  },
  {
    id: "model-fit",
    description: "Model lane appears over-provisioned for part of the workload.",
    rationale: "High average cost with light output suggests some calls can use a cheaper lane.",
    action: "Route routine calls to a cheaper lane and verify quality.",
    category: "model-selection",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectModelFit,
  },
  {
    id: "reasoning-effort",
    description: "Reasoning-token share appears high for the observed traffic.",
    rationale: "Reasoning tokens are billed output and can dominate spend.",
    action: "Try lower effort for routine traffic, then verify quality.",
    category: "reasoning",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectReasoningEffort,
  },
  {
    id: "context-compaction",
    description: "Frequent compaction epochs suggest context-pressure overhead.",
    rationale: "Repeated compaction often implies stale-context carry and rebuild cost.",
    action: "Reduce context pressure with tighter windows/checkpoints.",
    category: "context-bloat",
    tier: "try",
    verificationMode: "replay",
    replayKind: "plan",
    claudeSafe: "Yes",
    run: detectContextCompaction,
  },
  {
    id: "cold-resume",
    description: "Resumed sessions appear to re-pay context setup after long gaps.",
    rationale: "Cold resumes rebuild context at full input rates.",
    action: "Use compact resume checkpoints instead of full rebuild context.",
    category: "context-bloat",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectColdResume,
  },
  {
    id: "heavy-start",
    description: "First calls are much heavier than immediate follow-ups.",
    rationale: "Heavy starts indicate avoidable cold-start context load.",
    action: "Lighten first-call setup context and split warm-up from active work.",
    category: "context-bloat",
    tier: "try",
    verificationMode: "replay",
    replayKind: "token",
    claudeSafe: "Yes",
    run: detectHeavyStart,
  },
  {
    id: "model-default",
    description: "One default model dominates nearly all traffic.",
    rationale: "Single-model defaults reduce fit between task shape and model cost/capability.",
    action: "Review default routing so simple and complex tasks use different lanes.",
    category: "model-selection",
    tier: "test",
    verificationMode: "manual",
    replayKind: null,
    claudeSafe: "Yes",
    run: detectModelDefault,
  },
];

/** Detector list for the existing Phase 3 finding pipeline. */
export const DETECTORS: readonly FindingDetector[] = RULES.map((rule) => ({
  rule: rule.id,
  run: rule.run,
}));
