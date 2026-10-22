/**
 * The finding and savings contract.
 *
 * A finding never exists without an explanation a user could reproduce: the
 * affected calls, the modelled waste in tokens and dollars, the assumptions,
 * and a plain-language calculation. Shapes are ported from the reference
 * engine, with Munin additions for unpriced traffic: ADR-0007.
 *
 * `claimByEvent` splits the window saving across the affected calls by cost so
 * overlapping findings can be combined per call instead of summed.
 */
import type { Evidence, UsageEvent } from "./usage.js";

/**
 * What kind of move a finding asks for, which decides whether it counts in the
 * headline:
 * - `fix`: clear waste; removing it leaves the work as it was.
 * - `try`: likely fine, but it changes what the model does.
 * - `test`: a trade-off sized from your own usage. Shown as "up to", never
 *   added to anything.
 */
export type FindingTier = "fix" | "try" | "test";

export const TIER_RANK: Record<FindingTier, number> = { fix: 0, try: 1, test: 2 };

/**
 * How much to trust a finding's dollar figure. Ordinal on purpose: nothing
 * calibrates it, so a percentage would claim precision we don't have.
 */
export type ConfidenceLevel = "low" | "medium" | "high";

/** Ordering for `ConfidenceLevel`, so callers can compare without a percentage. */
export const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** What kind of inefficiency a finding is about, matching the rule registry. */
export type FindingCategory =
  | "model-selection"
  | "context-bloat"
  | "caching"
  | "reasoning"
  | "retries"
  | "concentration"
  | "anomaly"
  | "pricing";

/** How much a fix could change model behaviour. */
export type Impact = "none" | "low" | "medium" | "high";

/**
 * How a finding's effect on output quality can be established:
 * - `not-required`: the fix cannot change output, e.g. dropping a duplicate.
 * - `replay`: a request rewrite, provable on recorded traffic.
 * - `manual`: can change output but cannot be replayed; the user signs off.
 */
export type VerificationMode = "not-required" | "replay" | "manual";

/** What is known about a finding's quality question, before verification runs. */
export interface FindingCandidate {
  kind: "swap-model" | "trim-prompt" | "enable-cache" | "lower-effort";
  from?: string;
  to?: string;
  /** Plain language, in the candidate's own words. */
  description: string;
}

/**
 * A projected saving, with everything needed to check it. Never a guarantee.
 *
 * Munin additions over the reference: `tokensWasted` (the physical waste, so an
 * unpriced finding still reports it), `unpriced` (dollars withheld because no
 * card and no observed charge exists), and `pricingAsOf` (the catalogue date
 * every dollar estimate rests on).
 */
export interface SavingsEstimate {
  /** The headline cost of the affected calls over the window. */
  currentUsd: number;
  /**
   * The modelled waste over the window, clamped to what the affected calls
   * actually cost. Zero on unpriced traffic: token-only, never a fake $0.
   */
  windowUsd: number;
  /** `windowUsd` projected at the recent pace. */
  monthlyUsd: number;
  annualUsd: number;
  /** Days the window was observed over, so findings can be combined. */
  windowDays: number;
  /**
   * Days `windowUsd` is divided by for a daily rate: the whole window up to
   * 30 days, else the recent-pace equivalent (`projectionDays`).
   */
  projectionDays: number;
  /** Physical waste in tokens. Reported even when dollars cannot be. */
  tokensWasted: number;
  /** True when any affected call has no card and no observed cost. */
  unpriced: boolean;
  /** Catalogue date the list-price estimates rest on. */
  pricingAsOf: string;
  /** How far the dollar figure can be trusted. Ordinal, never a percentage. */
  confidence: ConfidenceLevel;
  /** Why the confidence is what it is. */
  confidenceBasis: string;
  /** Every assumption the estimate rests on, in plain language. */
  assumptions: string[];
  /** How the number was computed, so it can be checked by hand. */
  calculation: string;
  evidence: Evidence;
}

/** What traffic an opportunity touches. */
export interface AffectedTraffic {
  calls: number;
  /** Bare model ids present in the affected calls. */
  models: string[];
  /** Project labels present in the affected calls. */
  projects: string[];
  /** Agent names present in the affected calls, when the source records them. */
  agents: string[];
  /** Affected headline spend as a share of the window's headline spend. */
  share: number;
  /** Ids of the priciest affected calls, for drill-down. */
  sampleEventIds: string[];
}

/** A detected inefficiency. Pure data: JSON-safe apart from `claimByEvent` and `affects`. */
export interface Finding {
  rule: string;
  category: FindingCategory;
  title: string;
  /** What is happening and why it costs money. */
  detail: string;
  /** Why it matters, in one sentence. */
  why: string;
  tier: FindingTier;

  savings: SavingsEstimate;
  affected: AffectedTraffic;

  /** Expected effect on output quality if the fix is applied. */
  impact: Impact;
  severity: "high" | "medium" | "low";
  /** `safe` fixes are pure waste removal; others must clear the quality bar. */
  risk: "safe" | "needs-verification";
  /**
   * Derived once from `risk` and `candidate`. A rule cannot ask for
   * verification while offering nothing to verify.
   */
  verification: VerificationMode;
  /**
   * A real cost you absorb, not waste: advisories claim nothing and never
   * count in headline savings.
   */
  advisory: boolean;

  /** Concrete instances, most expensive first. */
  observations: string[];
  /** What to change. */
  fix: string;
  /** The exact events this finding counted. Every finding has one. */
  affects: (event: UsageEvent) => boolean;
  /**
   * `savings.windowUsd` split across the counted events by cost, keyed by
   * event id. Findings overlap, so totals are combined per event
   * (`recoverableWindow`) rather than summed.
   */
  claimByEvent: ReadonlyMap<string, number>;
  candidate?: FindingCandidate;
}

/**
 * What a detector hands to the shared assembly. The detectors measure waste;
 * the assembly derives the money: headline cost of the affected calls, the
 * clamp, the per-call claims, and the projection. `events` are the exact calls
 * the finding counted; nothing else defines `affected`.
 */
export interface FindingDraft {
  rule: string;
  category: FindingCategory;
  title: string;
  detail: string;
  why: string;
  /** Defaults from impact: a fix that cannot change output (or barely) is `fix`. */
  tier?: FindingTier;
  /** Modelled waste over the window, in dollars, before the clamp. */
  wastedUsd: number;
  /** Physical waste in tokens, reported even on unpriced traffic. */
  tokensWasted: number;
  /** The exact affected events, so affected spend and claims are derivable. */
  events: UsageEvent[];
  evidence: Evidence;
  confidence: { level: ConfidenceLevel; basis: string };
  impact: Impact;
  risk: "safe" | "needs-verification";
  /** Assumptions in plain language; required. The clamp adds its own when it fires. */
  assumptions: string[];
  /** Plain-language formula with units and the rate card date; required. */
  calculation: string;
  observations: string[];
  fix: string;
  /** Advisories carry a real cost figure but claim nothing. */
  advisory?: boolean;
  candidate?: FindingCandidate;
  /** Overrides the daily-waste severity rule. */
  severityOverride?: "high" | "medium" | "low";
}

/** One detector that ran and failed. Never silence: a crashed detector must not look like a clean $0. */
export interface AnalysisError {
  rule: string;
  message: string;
}

/** Everything detectors share, computed once from the event list. */
export interface DetectionContext {
  events: UsageEvent[];
  window: { start: string | null; end: string | null; days: number };
  /** Days `windowUsd` is divided by for a daily rate, the recent-pace equivalent. */
  projectionDays: number;
  /** Headline spend over the whole window, so `affected.share` stays a share. */
  totalUsd: number;
}

/**
 * One rule a report can run. Pure: given events, return drafts or throw.
 * A thrown error becomes an `AnalysisError` with the rule name, never silence.
 */
export interface FindingDetector {
  rule: string;
  run: (context: DetectionContext) => readonly FindingDraft[];
}

export interface DetectionResult {
  /** Sorted by projected monthly saving, then rule, then title. */
  findings: Finding[];
  errors: AnalysisError[];
}
