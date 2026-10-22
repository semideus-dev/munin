/**
 * Finding assembly, detection, and de-overlap.
 *
 * Detectors measure waste; this file turns a measurement into a finding that
 * never exists without an explanation a user could reproduce. Every finding
 * carries the affected calls, the clamp, a per-call claim, assumptions in plain
 * language, and a calculation with units and the rate card date.
 *
 * Detector failures become `AnalysisError`s with the rule name. A crashed
 * detector must not look like a clean $0.
 */
import { PRICING_AS_OF } from "../pricing/providers.js";
import { ratesFor } from "../pricing/cost.js";
import { priceFor } from "../pricing/resolve.js";
import type {
  AffectedTraffic,
  AnalysisError,
  DetectionContext,
  DetectionResult,
  Finding,
  FindingCandidate,
  FindingDraft,
  FindingTier,
  SavingsEstimate,
} from "../domain/finding.js";
import type { UsageEvent } from "../domain/usage.js";
import { windowOf } from "./build.js";
import { projectionDays } from "./projection.js";

const MONTH_DAYS = 30;
const YEAR_DAYS = 365;
const SAMPLE_SIZE = 20;

/**
 * A dollar amount for prose: six decimals with trailing zeros trimmed, so a
 * small window like $0.00165 does not render as $0.00 and lie about the clamp.
 */
function usdStr(amount: number): string {
  if (amount === 0) return "$0";
  let text = amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (Number(text) === 0) text = amount.toPrecision(3);
  return `$${text}`;
}

/** The daily waste above which a finding reads high and medium. */
const SEVERITY_HIGH_PER_DAY = 0.5;
const SEVERITY_MEDIUM_PER_DAY = 0.05;

/** Codepoint order, so results never depend on the runtime locale. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Resolved rates for one event's own model at its own timestamp, or null when unpriced. */
export interface EventRates {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number;
  cacheWrite5mPerM: number;
  cacheWrite1hPerM: number;
  /** The dated card the rates came from, so a calculation can name it. */
  cardFrom: string;
}

/**
 * The rate card in force for the call, exactly as cost math used it. Detectors
 * price waste from these rates — never from a source provider's idea of cache
 * (docs/plans/phase-3-analysis.md, Step 6).
 */
export function eventRates(event: UsageEvent): EventRates | null {
  const price = priceFor(event.model);
  if (price === null) return null;
  const rates = ratesFor(price, { at: event.ts, speed: event.speed, batch: event.batch });
  return {
    inputPerM: rates.inputPerM,
    outputPerM: rates.outputPerM,
    cachedInputPerM: rates.cachedInputPerM,
    cacheWrite5mPerM: rates.cacheWrite5mPerM,
    cacheWrite1hPerM: rates.cacheWrite1hPerM,
    cardFrom: rates.card.from,
  };
}

/**
 * Confidence for a finding built from directly counted duplicates, scaled by
 * sample size. Ordinal on purpose; see domain/finding.ts.
 */
export function countedConfidence(sample: number): {
  level: "low" | "medium" | "high";
  basis: string;
} {
  if (sample < 10) {
    return { level: "low", basis: `low because ${sample} duplicate(s) is too thin to average` };
  }
  if (sample < 50) {
    return {
      level: "medium",
      basis: `medium because the sample is under 50 calls (currently ${sample})`,
    };
  }
  return { level: "high", basis: "high because only future traffic is assumed" };
}

/**
 * Everything a finding must carry besides the measurement. A finding without
 * a calculation or assumptions is a number without a story, which the contract
 * does not allow.
 */
export function findingValidationProblems(draft: FindingDraft): string[] {
  const problems: string[] = [];
  if (draft.rule.trim() === "") problems.push("rule is empty");
  if (draft.title.trim() === "") problems.push("title is empty");
  if (draft.detail.trim() === "") problems.push("detail is empty");
  if (draft.why.trim() === "") problems.push("why is empty");
  if (draft.fix.trim() === "") problems.push("fix is empty");
  if (draft.calculation.trim() === "") {
    problems.push("calculation is empty: every finding needs a reproducible formula");
  }
  if (!Array.isArray(draft.assumptions) || draft.assumptions.length === 0) {
    problems.push("assumptions is empty: every finding names what it assumes");
  } else if (draft.assumptions.some((line) => line.trim() === "")) {
    problems.push("assumptions contains a blank line");
  }
  if (draft.events.length === 0) problems.push("events is empty: affected calls define a finding");
  if (!Number.isFinite(draft.wastedUsd) || draft.wastedUsd < 0) {
    problems.push(`wastedUsd is not a finite non-negative number: ${draft.wastedUsd}`);
  }
  if (!Number.isFinite(draft.tokensWasted) || draft.tokensWasted < 0) {
    problems.push(`tokensWasted is not a finite non-negative number: ${draft.tokensWasted}`);
  }
  if (draft.evidence === undefined || draft.evidence.basis.trim() === "") {
    problems.push("evidence is missing its basis");
  }
  if (draft.confidence?.basis.trim() === "") problems.push("confidenceBasis is empty");
  for (const line of draft.observations) {
    if (typeof line !== "string") problems.push("observations contains a non-string entry");
  }
  return problems;
}

/**
 * Turn a detector's measurement into a full finding. Throws when the draft
 * fails validation, so `detectFindings` can name the rule that broke the
 * contract instead of shipping an unexplainable number.
 */
export function buildFinding(draft: FindingDraft, context: DetectionContext): Finding {
  const problems = findingValidationProblems(draft);
  if (problems.length > 0) {
    throw new Error(
      `finding validation failed for rule "${draft.rule}" - ${draft.events.length} affected call(s): ${problems.join("; ")}`,
    );
  }

  // Deterministic event order: downstream maps and samples read better.
  const events = [...draft.events];
  const currentUsd = events.reduce((sum, event) => sum + event.cost.total, 0);

  // Unpriced traffic is reported in tokens only, never as a zero-dollar saving
  // (ADR-0007). An advisory claims nothing either: it describes a cost you
  // absorb, not waste you can recover.
  const unpriced = events.some((event) => event.cost.unpriced);
  const claimedUsd = draft.advisory === true ? 0 : Math.max(0, draft.wastedUsd);
  const windowUsd = draft.advisory === true || unpriced ? 0 : Math.min(claimedUsd, currentUsd);

  // You cannot recover more than the affected calls cost. Detectors that model
  // waste forward (a duplicate is re-read by every later call) can overshoot,
  // so every finding is clamped here, and the clamp says so.
  const assumptions = [...draft.assumptions];
  if (draft.advisory !== true && !unpriced && claimedUsd > windowUsd + 1e-9) {
    assumptions.push(
      `This detector modelled ${usdStr(claimedUsd)} of waste over the window, which is more than the affected calls cost (${usdStr(currentUsd)}). The figure has been capped at what was actually spent.`,
    );
  }
  if (unpriced) {
    assumptions.push(
      "The affected calls have no price card and no reported charge, so the waste is reported in tokens only; the dollar figure is withheld rather than shown as a saving.",
    );
  }

  // Split the window saving across its calls, weighted by headline cost, so
  // overlapping findings can be combined per call without billing the same
  // dollar twice. When the affected calls cost nothing, split evenly; that
  // case claims nothing today, because the window figure is clamped to the
  // affected spend, but the choice is pinned by the contract.
  const claimByEvent = new Map<string, number>();
  if (windowUsd > 0 && events.length > 0) {
    for (const event of events) {
      const share = currentUsd > 0 ? event.cost.total / currentUsd : 1 / events.length;
      claimByEvent.set(event.id, windowUsd * share);
    }
  }

  const affected: AffectedTraffic = {
    calls: events.length,
    models: [...new Set(events.map((e) => e.model))].sort(asc),
    projects: [...new Set(events.map((e) => e.project))].sort(asc),
    agents: [...new Set(events.map((e) => e.agent ?? "").filter((agent) => agent !== ""))].sort(
      asc,
    ),
    share: context.totalUsd > 0 ? currentUsd / context.totalUsd : 0,
    sampleEventIds: [...events]
      .sort(byHeadlineDescThenTimeThenId)
      .slice(0, SAMPLE_SIZE)
      .map((event) => event.id),
  };

  const dailyWaste = windowUsd / Math.max(1, context.projectionDays);
  const tier: FindingTier =
    draft.tier ?? (draft.impact === "none" || draft.impact === "low" ? "fix" : "try");

  const saved: SavingsEstimate = {
    currentUsd,
    windowUsd,
    monthlyUsd: (windowUsd / Math.max(1, context.projectionDays)) * MONTH_DAYS,
    annualUsd: (windowUsd / Math.max(1, context.projectionDays)) * YEAR_DAYS,
    windowDays: Math.max(1, context.window.days || 1),
    projectionDays: context.projectionDays,
    tokensWasted: draft.tokensWasted,
    unpriced,
    pricingAsOf: PRICING_AS_OF,
    confidence: draft.confidence.level,
    confidenceBasis: draft.confidence.basis,
    assumptions,
    calculation: draft.calculation,
    evidence: draft.evidence,
  };

  const affectedIds = new Set(events.map((event) => event.id));
  const verification: Finding["verification"] =
    draft.risk === "safe" ? "not-required" : draft.candidate ? "replay" : "manual";

  return {
    rule: draft.rule,
    category: draft.category,
    title: draft.title,
    detail: draft.detail,
    why: draft.why,
    tier,
    savings: saved,
    affected,
    impact: draft.impact,
    severity: draft.severityOverride ?? severityOf(dailyWaste),
    risk: draft.risk,
    verification,
    advisory: draft.advisory === true,
    observations: draft.observations,
    fix: draft.fix,
    affects: (event: UsageEvent) => affectedIds.has(event.id),
    claimByEvent,
    ...(draft.candidate === undefined ? {} : { candidate: draft.candidate }),
  };
}

function severityOf(dailyWaste: number): "high" | "medium" | "low" {
  if (dailyWaste > SEVERITY_HIGH_PER_DAY) return "high";
  if (dailyWaste > SEVERITY_MEDIUM_PER_DAY) return "medium";
  return "low";
}

function byHeadlineDescThenTimeThenId(a: UsageEvent, b: UsageEvent): number {
  if (a.cost.total !== b.cost.total) return b.cost.total - a.cost.total;
  if (a.ts !== b.ts) return asc(a.ts, b.ts);
  return asc(a.id, b.id);
}

function byMonthlyThenRuleThenTitle(a: Finding, b: Finding): number {
  if (a.savings.monthlyUsd !== b.savings.monthlyUsd) {
    return b.savings.monthlyUsd - a.savings.monthlyUsd;
  }
  if (a.rule !== b.rule) return asc(a.rule, b.rule);
  return asc(a.title, b.title);
}

/**
 * Run detectors over priced events. Failures are data: a detector that throws
 * becomes an `AnalysisError` with its rule name and the other detectors still
 * run. Nothing here reads a clock or the filesystem.
 */
export function detectFindings(
  events: UsageEvent[],
  detectors: readonly {
    rule: string;
    run: (context: DetectionContext) => readonly FindingDraft[];
  }[],
): DetectionResult {
  const context: DetectionContext = {
    events,
    window: windowOf(events),
    projectionDays: projectionDays(events),
    totalUsd: events.reduce((sum, event) => sum + event.cost.total, 0),
  };

  const findings: Finding[] = [];
  const errors: AnalysisError[] = [];
  for (const detector of detectors) {
    try {
      for (const draft of detector.run(context)) findings.push(buildFinding(draft, context));
    } catch (error) {
      errors.push({
        rule: detector.rule,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { findings: findings.sort(byMonthlyThenRuleThenTitle), errors };
}

/**
 * The de-overlapped recoverable amount on each call, keyed by event id. Two
 * findings often claim the same call, so each call counts once, at its largest
 * claim. `unattributed` is what findings without per-call claims would carry;
 * Munin claims per call whenever the window figure is above zero.
 */
export function recoverableByEvent(
  findings: readonly Finding[],
  tiers: FindingTier | readonly FindingTier[] = "fix",
): { byEvent: Map<string, number>; unattributed: number } {
  const byEvent = new Map<string, number>();
  let unattributed = 0;

  const wanted = new Set<FindingTier>(Array.isArray(tiers) ? tiers : [tiers]);
  for (const finding of findings) {
    if (finding.advisory || !wanted.has(finding.tier)) continue;
    if (finding.claimByEvent.size === 0) continue;
    for (const [id, claim] of finding.claimByEvent) {
      if (claim > (byEvent.get(id) ?? 0)) byEvent.set(id, claim);
    }
  }
  return { byEvent, unattributed };
}

/**
 * The total saving once overlapping findings stop double-counting, one tier at
 * a time. The headline is `fix`; `try` and `test` are separate. Fixing every
 * finding could save a little more than this, so it is a floor.
 */
export function recoverableWindow(
  findings: readonly Finding[],
  tiers: FindingTier | readonly FindingTier[] = "fix",
): number {
  const { byEvent, unattributed } = recoverableByEvent(findings, tiers);
  let total = unattributed;
  for (const claim of byEvent.values()) total += claim;
  return total;
}
