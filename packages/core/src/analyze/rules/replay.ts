import type { ConfidenceLevel, Finding } from "../../domain/finding.js";
import type { ReplayKind, VerificationRecord } from "../../domain/verification.js";
import type { UsageEvent } from "../../domain/usage.js";
import { CONFIDENCE_RANK } from "../../domain/finding.js";
import { detectFindings } from "../findings.js";
import { RULES } from "../rules.js";
import { recordVerification, stateForVerdict, type VerificationStore } from "../verification.js";

export type ReplayVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface ReplayResult {
  kind: ReplayKind;
  verdict: ReplayVerdict;
  expectedClaimWindowUsd: number;
  refreshedClaimWindowUsd: number | null;
  differenceUsd: number | null;
  expectedTokensWasted: number;
  refreshedTokensWasted: number | null;
  differenceTokens: number | null;
  confidence: ConfidenceLevel;
  samples: number;
  reason: string;
  record: VerificationRecord;
}

function claimWindowOf(finding: Finding): number {
  let total = 0;
  for (const claim of finding.claimByEvent.values()) total += claim;
  return total;
}

function recordFor(
  finding: Finding,
  kind: ReplayKind,
  verdict: ReplayVerdict,
  at: string,
  samples: number,
  reason: string,
): VerificationRecord {
  return {
    rule: finding.rule,
    at,
    mode: "replay",
    state: stateForVerdict(verdict) as "passed" | "failed" | "inconclusive",
    samples,
    note: `[${kind} replay] ${reason}`,
  };
}

function replayKindFor(finding: Finding, expected: ReplayKind): void {
  const definition = RULES.find((rule) => rule.id === finding.rule);
  if (definition?.replayKind !== expected) {
    throw new TypeError(`rule '${finding.rule}' does not declare ${expected} replay`);
  }
}

export interface TokenReplayDriver {
  /** Re-run the finding's detector over local events and return its refreshed finding. */
  recompute(finding: Finding, events: readonly UsageEvent[]): Finding | null;
}

/** Built-in, offline token replay: it re-runs only this rule's pure detector. */
export const detectorTokenReplayDriver: TokenReplayDriver = {
  recompute(finding, events) {
    const definition = RULES.find((rule) => rule.id === finding.rule);
    if (definition === undefined) throw new Error(`unknown rule '${finding.rule}'`);
    const detection = detectFindings([...events], [{ rule: definition.id, run: definition.run }]);
    if (detection.errors.length > 0) {
      throw new Error(detection.errors.map((error) => error.message).join("; "));
    }

    const previousIds = new Set(events.filter(finding.affects).map((event) => event.id));
    const candidates = detection.findings
      .map((candidate) => {
        const overlap = [...candidate.claimByEvent.keys()].filter((id) =>
          previousIds.has(id),
        ).length;
        return {
          candidate,
          overlap,
          delta: Math.abs(claimWindowOf(candidate) - claimWindowOf(finding)),
        };
      })
      .filter((row) => row.overlap > 0)
      .sort(
        (a, b) =>
          b.overlap - a.overlap ||
          a.delta - b.delta ||
          CONFIDENCE_RANK[b.candidate.savings.confidence] -
            CONFIDENCE_RANK[a.candidate.savings.confidence] ||
          (a.candidate.title < b.candidate.title
            ? -1
            : a.candidate.title > b.candidate.title
              ? 1
              : 0),
      );
    return candidates[0]?.candidate ?? null;
  },
};

/** Recompute a token-based finding and compare its saved claim window. */
export function runTokenReplay(input: {
  finding: Finding;
  events: readonly UsageEvent[];
  driver?: TokenReplayDriver;
  at: string;
}): ReplayResult {
  replayKindFor(input.finding, "token");
  if (!Number.isFinite(Date.parse(input.at)))
    throw new TypeError("replay timestamp must be a valid date");
  const driver = input.driver ?? detectorTokenReplayDriver;
  const expected = claimWindowOf(input.finding);
  const expectedTokens = input.finding.savings.tokensWasted;
  const samples = input.events.filter(input.finding.affects).length;
  let refreshed: Finding | null;
  try {
    refreshed = driver.recompute(input.finding, input.events);
  } catch (error) {
    const reason = `Token replay could not recompute the finding: ${error instanceof Error ? error.message : String(error)}`;
    return {
      kind: "token",
      verdict: "INCONCLUSIVE",
      expectedClaimWindowUsd: expected,
      refreshedClaimWindowUsd: null,
      differenceUsd: null,
      expectedTokensWasted: expectedTokens,
      refreshedTokensWasted: null,
      differenceTokens: null,
      confidence: input.finding.savings.confidence,
      samples,
      reason,
      record: recordFor(input.finding, "token", "INCONCLUSIVE", input.at, samples, reason),
    };
  }

  if (refreshed === null) {
    const reason = "Replay no longer reproduces this finding; the saved claim is stale.";
    return {
      kind: "token",
      verdict: "FAIL",
      expectedClaimWindowUsd: expected,
      refreshedClaimWindowUsd: 0,
      differenceUsd: -expected,
      expectedTokensWasted: expectedTokens,
      refreshedTokensWasted: null,
      differenceTokens: null,
      confidence: input.finding.savings.confidence,
      samples,
      reason,
      record: recordFor(input.finding, "token", "FAIL", input.at, samples, reason),
    };
  }

  const refreshedWindow = claimWindowOf(refreshed);
  const difference = refreshedWindow - expected;
  const refreshedTokens = refreshed.savings.tokensWasted;
  const tokenDifference = refreshedTokens - expectedTokens;
  const matches = Math.abs(difference) <= 1e-12 && tokenDifference === 0;
  const verdict: ReplayVerdict = matches ? "PASS" : "FAIL";
  const reason = matches
    ? `Recomputed ${refreshedTokens} wasted tokens and the ${expected.toFixed(12)} USD claim match the saved finding.`
    : `Saved ${expectedTokens} tokens / ${expected.toFixed(12)} USD differs from recomputed ${refreshedTokens} tokens / ${refreshedWindow.toFixed(12)} USD; finding is stale.`;
  return {
    kind: "token",
    verdict,
    expectedClaimWindowUsd: expected,
    refreshedClaimWindowUsd: refreshedWindow,
    differenceUsd: difference,
    expectedTokensWasted: expectedTokens,
    refreshedTokensWasted: refreshedTokens,
    differenceTokens: tokenDifference,
    confidence: refreshed.savings.confidence,
    samples,
    reason,
    record: recordFor(input.finding, "token", verdict, input.at, samples, reason),
  };
}

export interface PlanReplayDriver {
  /** Execute a mocked/canned plan locally; implementations must not call a model API. */
  execute(
    finding: Finding,
    events: readonly UsageEvent[],
  ): {
    verdict: ReplayVerdict;
    claimWindowUsd: number;
    tokensWasted?: number;
    confidence: ConfidenceLevel;
    samples: number;
    reason: string;
  };
}

/** Replay a disposition-changing rule through a caller-supplied local plan executor. */
export function runPlanReplay(input: {
  finding: Finding;
  events: readonly UsageEvent[];
  driver: PlanReplayDriver;
  at: string;
}): ReplayResult {
  replayKindFor(input.finding, "plan");
  if (!Number.isFinite(Date.parse(input.at)))
    throw new TypeError("replay timestamp must be a valid date");
  const expected = claimWindowOf(input.finding);
  const expectedTokens = input.finding.savings.tokensWasted;
  let result: ReturnType<PlanReplayDriver["execute"]>;
  try {
    result = input.driver.execute(input.finding, input.events);
  } catch (error) {
    const reason = `Plan replay could not complete: ${error instanceof Error ? error.message : String(error)}`;
    return {
      kind: "plan",
      verdict: "INCONCLUSIVE",
      expectedClaimWindowUsd: expected,
      refreshedClaimWindowUsd: null,
      differenceUsd: null,
      expectedTokensWasted: expectedTokens,
      refreshedTokensWasted: null,
      differenceTokens: null,
      confidence: input.finding.savings.confidence,
      samples: 0,
      reason,
      record: recordFor(input.finding, "plan", "INCONCLUSIVE", input.at, 0, reason),
    };
  }
  const difference = result.claimWindowUsd - expected;
  return {
    kind: "plan",
    verdict: result.verdict,
    expectedClaimWindowUsd: expected,
    refreshedClaimWindowUsd: result.claimWindowUsd,
    differenceUsd: difference,
    expectedTokensWasted: expectedTokens,
    refreshedTokensWasted: result.tokensWasted ?? null,
    differenceTokens:
      result.tokensWasted === undefined ? null : result.tokensWasted - expectedTokens,
    confidence: result.confidence,
    samples: result.samples,
    reason: result.reason,
    record: recordFor(
      input.finding,
      "plan",
      result.verdict,
      input.at,
      result.samples,
      result.reason,
    ),
  };
}

/** Persist a replay result through the same verification store the apply gate reads. */
export function recordReplayResult(store: VerificationStore, result: ReplayResult): void {
  recordVerification(store, result.record);
}
