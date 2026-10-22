/**
 * The report builder: composes the Phase 3 aggregates into one serialisable
 * object. Everything here is deterministic — no clock, filesystem, network,
 * or locale — and nothing mutates the dataset.
 *
 * Findings are serialised the same moment they are sorted, so `claimByEvent`
 * maps become sorted claim arrays and the `affects` functions drop out: the
 * exact claims are carried instead, and every consumer reads the list.
 */
import type {
  AggregateMismatch,
  BuildReportOptions,
  DataHealth,
  FindingClaim,
  MuninReport,
  ReportFinding,
  ReportSavings,
  ReconciliationHealth,
  TierSavings,
  UnpricedModelHealth,
} from "../domain/report.js";
import type { Finding, FindingTier } from "../domain/finding.js";
import type { UsageEvent } from "../domain/usage.js";
import { buildEvents } from "../analyze/build.js";
import { cacheStats } from "../analyze/cache.js";
import { detectFindings, recoverableByEvent } from "../analyze/findings.js";
import { DETECTORS } from "../analyze/findings/index.js";
import { projectionDays } from "../analyze/projection.js";
import { summarize, projectCollisions } from "../analyze/summary.js";
import { sessionSummaries } from "../analyze/sessions.js";
import { reconcileAggregates } from "../normalize/reconcile.js";
import { PRICING_AS_OF, PRICING_VERSION } from "../pricing/providers.js";

/** Codepoint order, so results never depend on the runtime locale. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `usd` first (most expensive claim first), then event id for stability. */
function byClaim(a: FindingClaim, b: FindingClaim): number {
  if (a.usd !== b.usd) return b.usd - a.usd;
  return asc(a.eventId, b.eventId);
}

/** The accounting rules a reader needs to trust every number. */
function methodParagraph(zone: string): string {
  return (
    "Calls are accounted per message; session aggregates are never billed. Each call's " +
    `cost basis is the provider-reported charge when the source records one, otherwise the ` +
    `list-price estimate on the ${PRICING_AS_OF} catalogue (pricing version ${PRICING_VERSION}); ` +
    "a call with neither reports tokens only, never a rounded $0. Day buckets use the " +
    `${zone} time zone. Bucket, cache and finding dollar figures are estimates; a finding's ` +
    "dollars are modelled waste, not observed charges."
  );
}

function serialiseFinding(finding: Finding): ReportFinding {
  const claimByEvent = [...finding.claimByEvent]
    .map(([eventId, usd]) => ({ eventId, usd }))
    .sort(byClaim);
  const { affects: _matched, claimByEvent: _claims, ...serialisable } = finding;
  void _matched;
  void _claims;
  return { ...serialisable, claimByEvent };
}

/** De-overlapped saving for one tier set, projected at the recent pace. */
function tierSavings(
  findings: readonly Finding[],
  tiers: FindingTier[],
  projectionDaysCount: number,
): TierSavings {
  const { byEvent } = recoverableByEvent(findings, tiers);
  let windowUsd = 0;
  for (const claim of byEvent.values()) windowUsd += claim;
  const pace = Math.max(1, projectionDaysCount);
  return {
    tiers,
    claimedCalls: byEvent.size,
    windowUsd,
    monthlyUsd: windowUsd * (30 / pace),
    annualUsd: windowUsd * (365 / pace),
  };
}

function reportSavings(
  findings: readonly Finding[],
  windowDays: number,
  pace: number,
): ReportSavings {
  const nonAdvisory = findings.filter((f) => !f.advisory);
  let tokensWasted = 0;
  let pricedTokensWasted = 0;
  let unpricedTokensWasted = 0;
  let unpricedFindings = 0;
  for (const f of nonAdvisory) {
    tokensWasted += f.savings.tokensWasted;
    if (f.savings.unpriced) {
      unpricedTokensWasted += f.savings.tokensWasted;
      unpricedFindings += 1;
    } else {
      pricedTokensWasted += f.savings.tokensWasted;
    }
  }
  return {
    windowDays,
    projectionDays: pace,
    fix: tierSavings(findings, ["fix"], pace),
    try: tierSavings(findings, ["try"], pace),
    test: tierSavings(findings, ["test"], pace),
    all: tierSavings(findings, ["fix", "try", "test"], pace),
    tokensWasted,
    pricedTokensWasted,
    unpricedTokensWasted,
    unpricedFindings,
  };
}

/** Models with unpriced calls, with the observed spend the source did record. */
function unpricedModelHealth(events: UsageEvent[]): UnpricedModelHealth[] {
  const rows = new Map<string, UnpricedModelHealth>();
  for (const event of events) {
    // No card: the estimate is null, whether or not the source charged.
    if (event.cost.estimatedUsd !== null) continue;
    const key = `${event.provider}/${event.model}`;
    const row = rows.get(key) ?? { model: key, calls: 0, unpricedCalls: 0, observedUsd: 0 };
    row.calls += 1;
    if (event.cost.unpriced) row.unpricedCalls += 1;
    if (event.cost.observedUsd !== null) row.observedUsd += event.cost.observedUsd;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => asc(a.model, b.model));
}

function reconciliationOf(
  dataset: Parameters<typeof reconcileAggregates>[0],
): ReconciliationHealth {
  const reconciliation = reconcileAggregates(dataset);
  // The row shape is already serialisable; quote it so the report never
  // depends on the reader having attached the warning.
  const mismatches: AggregateMismatch[] = reconciliation.mismatches.map((row) => ({
    sessionId: row.sessionId,
    category: row.category,
    expected: row.expected,
    actual: row.actual,
    delta: row.delta,
    threshold: row.threshold,
  }));
  return {
    checkedSessions: reconciliation.checkedSessions,
    mismatchSessions: reconciliation.mismatchSessions,
    largestDelta: reconciliation.largestDelta,
    mismatches,
  };
}

/**
 * Build the report. `dataset` is the normalized Phase 2 dataset; events are
 * priced, aggregated and screened inside. Pure: same input, byte-identical
 * output.
 */
export function buildReport(
  dataset: Parameters<typeof buildEvents>[0],
  options: BuildReportOptions = {},
): MuninReport {
  const zone = options.zone ?? "UTC";
  const priced = buildEvents(dataset);
  const events = priced.events;
  const windowDays = priced.window.days;
  const pace = projectionDays(events);

  const summary = summarize(events, { zone });
  const cache = cacheStats(events, { zone });
  const sessions = sessionSummaries(events, dataset.sessions, priced.attempts);
  const detection = detectFindings(events, options.detectors ?? DETECTORS);

  let withPrefix = 0;
  const prefixSessions = new Set<string>();
  for (const event of events) {
    if (event.prefixHash !== undefined) {
      withPrefix += 1;
      prefixSessions.add(event.sessionId);
    }
  }

  const dataHealth: DataHealth = {
    schema: dataset.schema,
    sources: [...dataset.sources].sort(asc),
    sessions: dataset.sessions.length,
    subagentSessions: summary.totals.subagentSessions,
    messages: dataset.messages.length,
    modelCalls: priced.attempts.length,
    failedCalls: priced.attempts.filter((attempt) => attempt.usage === undefined).length,
    compactions: priced.attempts.filter((attempt) => attempt.type === "compaction").length,
    warnings: priced.warnings,
    unpricedModels: unpricedModelHealth(events),
    observedCoverage: summary.totals.observedCoverage,
    reconciliation: reconciliationOf(dataset),
    projectLabelCollisions: projectCollisions(events),
    detectorErrors: detection.errors,
    instruction: {
      sessions: summary.totals.sessions,
      sessionsWithInstructions: prefixSessions.size,
      calls: events.length,
      callsWithPrefix: withPrefix,
    },
  };

  return {
    formatVersion: 1,
    method: methodParagraph(zone),
    pricingAsOf: PRICING_AS_OF,
    pricingVersion: PRICING_VERSION,
    timeZone: zone,
    window: priced.window,
    totals: summary.totals,
    byModel: summary.byModel,
    byProvider: summary.byProvider,
    byProject: summary.byProject,
    byDay: summary.byDay,
    bySession: summary.bySession,
    byAgent: summary.byAgent,
    cache,
    sessions,
    findings: detection.findings.map(serialiseFinding),
    savings: reportSavings(detection.findings, windowDays, pace),
    dataHealth,
  };
}
