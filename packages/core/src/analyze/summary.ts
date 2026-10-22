/**
 * Deterministic aggregates over priced events.
 *
 * Every bucket partitions the same event list, so bucket sums add back to the
 * totals without a remainder. Ordering is stable: spend descending, then key
 * ascending, then id ascending where ids exist.
 */
import { WARNING_CODES } from "../diagnostics.js";
import type { SpendBucket, SummarizeOptions, Summary, Totals } from "../domain/analysis.js";
import type { DayZone, ProjectLabelCollision } from "../domain/analysis.js";
import type { SourceWarning } from "../domain/source.js";
import type { UsageEvent } from "../domain/usage.js";
import { dayKey } from "./day.js";

interface Acc {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  observedUsd: number;
  estimatedUsd: number;
  headlineUsd: number;
  observedCalls: number;
  unpricedCalls: number;
  unpriced: boolean;
  models: Set<string>;
  providers: Set<string>;
}

function newAcc(): Acc {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    observedUsd: 0,
    estimatedUsd: 0,
    headlineUsd: 0,
    observedCalls: 0,
    unpricedCalls: 0,
    unpriced: false,
    models: new Set<string>(),
    providers: new Set<string>(),
  };
}

function addEvent(acc: Acc, event: UsageEvent): void {
  acc.calls += 1;
  acc.inputTokens += event.inputTokens;
  acc.outputTokens += event.outputTokens;
  acc.thinkingTokens += event.thinkingTokens;
  acc.cacheReadTokens += event.cacheReadTokens;
  acc.cacheWriteTokens += event.cacheWrite5mTokens + event.cacheWrite1hTokens;
  acc.observedUsd += event.cost.observedUsd ?? 0;
  if (event.cost.estimatedUsd !== null) acc.estimatedUsd += event.cost.estimatedUsd;
  acc.headlineUsd += event.cost.total;
  if (event.cost.observedUsd !== null) acc.observedCalls += 1;
  if (event.cost.unpriced) {
    acc.unpricedCalls += 1;
    acc.unpriced = true;
  }
  acc.models.add(event.model);
  acc.providers.add(event.provider);
}

function addTo(map: Map<string, Acc>, key: string, event: UsageEvent): void {
  const acc = map.get(key);
  if (acc === undefined) {
    const fresh = newAcc();
    addEvent(fresh, event);
    map.set(key, fresh);
    return;
  }
  addEvent(acc, event);
}

function cacheHitRate(acc: Acc): number | null {
  const inputSide = acc.inputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
  return inputSide === 0 ? null : acc.cacheReadTokens / inputSide;
}

/** Codepoint order, so results never depend on the runtime locale. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: Set<string>): string[] {
  return [...values].sort(asc);
}

function totalTokensOf(acc: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
}

function toBucket(
  key: string,
  acc: Acc,
  label: string | undefined,
  totalHeadline: number,
): SpendBucket {
  return {
    key,
    ...(label === undefined ? {} : { label }),
    calls: acc.calls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    thinkingTokens: acc.thinkingTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    totalTokens: totalTokensOf(acc),
    observedUsd: acc.observedUsd,
    estimatedUsd: acc.estimatedUsd,
    headlineUsd: acc.headlineUsd,
    spendShare: totalHeadline === 0 ? 0 : acc.headlineUsd / totalHeadline,
    cacheHitRate: cacheHitRate(acc),
    unpriced: acc.unpriced,
    models: sortedUnique(acc.models),
    providers: sortedUnique(acc.providers),
  };
}

function bySpendDescThenKey(a: SpendBucket, b: SpendBucket): number {
  if (a.headlineUsd !== b.headlineUsd) return b.headlineUsd - a.headlineUsd;
  return asc(a.key, b.key);
}

function eventTotalTokens(event: UsageEvent): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheWrite5mTokens +
    event.cacheWrite1hTokens
  );
}

/** Headline spend and token spend per event, with stable ties. */
export function topCalls(
  events: UsageEvent[],
  limit = 10,
): { byCost: UsageEvent[]; byTokens: UsageEvent[] } {
  const byCost = [...events]
    .sort((a, b) => (a.cost.total !== b.cost.total ? b.cost.total - a.cost.total : asc(a.id, b.id)))
    .slice(0, limit);

  const byTokens = [...events]
    .sort((a, b) => {
      const delta = eventTotalTokens(b) - eventTotalTokens(a);
      return delta !== 0 ? delta : asc(a.id, b.id);
    })
    .slice(0, limit);

  return { byCost, byTokens };
}

/**
 * Group projects by id. One label across several ids (basename collision) is
 * data health, not a reporting error.
 */
export function projectCollisions(events: UsageEvent[]): ProjectLabelCollision[] {
  const idsByLabel = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.projectId === undefined) continue;
    const ids = idsByLabel.get(event.project);
    if (ids === undefined) idsByLabel.set(event.project, new Set([event.projectId]));
    else ids.add(event.projectId);
  }

  const collisions: ProjectLabelCollision[] = [];
  for (const [label, ids] of idsByLabel) {
    if (ids.size < 2) continue;
    collisions.push({ label, projectIds: sortedUnique(ids) });
  }
  return collisions.sort((a, b) => asc(a.label, b.label));
}

/**
 * The same collisions as data-health warnings: one per colliding label, with
 * the ids named in the message.
 */
export function projectCollisionWarnings(events: UsageEvent[]): SourceWarning[] {
  return projectCollisions(events).map((collision) => ({
    code: WARNING_CODES.analysisProjectLabelCollision,
    message: `Project label "${collision.label}" maps to ${collision.projectIds.length} project ids: ${collision.projectIds.join(", ")}`,
  }));
}

/**
 * Totals and buckets over priced events. Events are consumed in the order
 * given; buildEvents() output is already in a stable order.
 */
export function summarize(events: UsageEvent[], options: SummarizeOptions = {}): Summary {
  const zone: DayZone = options.zone ?? "UTC";

  const totalsAcc = newAcc();
  const byModel = new Map<string, Acc>();
  const byProvider = new Map<string, Acc>();
  const byProject = new Map<string, Acc>();
  const byDay = new Map<string, Acc>();
  const bySession = new Map<string, Acc>();
  const byAgent = new Map<string, Acc>();

  const projectLabels = new Map<string, string>();
  const sessions = new Set<string>();
  const subagentSessions = new Set<string>();
  const turns = new Set<string>();
  const unpricedModels = new Set<string>();

  for (const event of events) {
    addEvent(totalsAcc, event);
    addTo(byModel, `${event.provider}/${event.model}`, event);
    addTo(byProvider, event.provider, event);
    addTo(byProject, event.projectId ?? "unknown", event);
    addTo(byDay, dayKey(event.ts, zone), event);
    addTo(bySession, event.sessionId, event);
    addTo(byAgent, event.agent ?? "unknown", event);

    if (event.projectId !== undefined && !projectLabels.has(event.projectId)) {
      projectLabels.set(event.projectId, event.project);
    }
    sessions.add(event.sessionId);
    if (event.isSubagent === true) subagentSessions.add(event.sessionId);
    if (event.turnId !== undefined) turns.add(`${event.sessionId}\u0000${event.turnId}`);
    if (event.cost.unpriced) unpricedModels.add(event.model);
  }

  const totals: Totals = {
    calls: totalsAcc.calls,
    sessions: sessions.size,
    turns: turns.size,
    subagentSessions: subagentSessions.size,

    inputTokens: totalsAcc.inputTokens,
    outputTokens: totalsAcc.outputTokens,
    thinkingTokens: totalsAcc.thinkingTokens,
    cacheReadTokens: totalsAcc.cacheReadTokens,
    cacheWriteTokens: totalsAcc.cacheWriteTokens,
    totalTokens: totalTokensOf(totalsAcc),

    headlineUsd: totalsAcc.headlineUsd,
    observedUsd: totalsAcc.observedUsd,
    estimatedUsd: totalsAcc.estimatedUsd,
    unpricedCalls: totalsAcc.unpricedCalls,
    unpricedModels: sortedUnique(unpricedModels),
    observedCoverage: totalsAcc.calls === 0 ? null : totalsAcc.observedCalls / totalsAcc.calls,

    cacheHitRate: cacheHitRate(totalsAcc),
    thinkingShare:
      totalsAcc.outputTokens === 0 ? null : totalsAcc.thinkingTokens / totalsAcc.outputTokens,
    avgTokensPerCall: totalsAcc.calls === 0 ? 0 : totalTokensOf(totalsAcc) / totalsAcc.calls,
    avgCostPerCall: totalsAcc.calls === 0 ? 0 : totalsAcc.headlineUsd / totalsAcc.calls,
  };

  const bucket = (map: Map<string, Acc>, labelled = false): SpendBucket[] => {
    const result: SpendBucket[] = [];
    for (const [key, acc] of map) {
      result.push(
        toBucket(key, acc, labelled ? projectLabels.get(key) : undefined, totals.headlineUsd),
      );
    }
    return result.sort(bySpendDescThenKey);
  };

  return {
    totals,
    byModel: bucket(byModel),
    byProvider: bucket(byProvider),
    byProject: bucket(byProject, true),
    byDay: bucket(byDay),
    bySession: bucket(bySession),
    byAgent: bucket(byAgent),
  };
}
