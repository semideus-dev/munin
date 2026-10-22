import type { ChangeManifestEntry } from "./rules/apply.js";
import type { UsageEvent } from "../domain/usage.js";

const DAY_MS = 86_400_000;
export const BASELINE_MIN_DAYS = 14;
export const BASELINE_MAX_DAYS = 30;
const READY_ACTIVE_DAYS = 3;
const READY_TURNS = 100;
const READY_CALLS = 300;
const EFFECT = 0.1;
const SHORT_BASELINES = [3, 5, 7];

export interface AppliedChange {
  id: string;
  rule: string;
  at: string;
  until?: string;
}

export type ResultVerdict = "too-early" | "no-baseline" | "working" | "no-change" | "worse";

export interface ResultPeriod {
  from: string;
  to: string;
  days: number;
  activeDays: number;
  calls: number;
  turns: number;
  sessions: number;
  costUsd: number;
}

export interface ResultRow {
  key: string;
  label: string;
  unit: "usd" | "count";
  before: number | null;
  after: number | null;
  change: number | null;
  better: "lower" | "higher";
  tradeOff?: boolean;
  worse?: boolean;
}

export interface ChangeResult {
  change: AppliedChange;
  verdict: ResultVerdict;
  measure: "turn" | "call";
  headline: ResultRow | null;
  before: ResultPeriod;
  after: ResultPeriod;
  rows: ResultRow[];
  range: { low: number; high: number; shortest: number; longest: number } | null;
  measuredSavingUsd: number | null;
  progress: { activeDays: number; count: number; needActiveDays: number; needCount: number };
}

export interface ResultsReport {
  schema: "munin.results/1";
  generatedAt: string;
  results: ChangeResult[];
}

export interface ResultsInput {
  events: readonly UsageEvent[];
}

/** Convert the append-only Phase 4 manifest into effective applied periods. */
export function appliedChangesFromJournal(
  entries: readonly ChangeManifestEntry[],
): AppliedChange[] {
  const firstById = new Map<string, ChangeManifestEntry>();
  const latestById = new Map<string, ChangeManifestEntry>();
  for (const entry of entries) {
    if (!firstById.has(entry.id)) firstById.set(entry.id, entry);
    latestById.set(entry.id, entry);
  }

  const changes: AppliedChange[] = [];
  for (const [id, initial] of firstById) {
    const latest = latestById.get(id)!;
    if (latest.status !== "applied" && latest.status !== "undone") continue;
    if (!Number.isFinite(Date.parse(initial.at))) continue;
    const change: AppliedChange = { id, rule: initial.rule, at: initial.at };
    if (
      latest.status === "undone" &&
      latest.restoredAt &&
      Number.isFinite(Date.parse(latest.restoredAt))
    ) {
      change.until = latest.restoredAt;
    }
    changes.push(change);
  }

  changes.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    const next = changes.slice(index + 1).find((candidate) => candidate.rule === change.rule);
    if (next && (!change.until || next.at < change.until)) change.until = next.at;
  }
  return changes;
}

/** Days needed to include the oldest change and a full maximum baseline. */
export function resultsDays(changes: readonly AppliedChange[], now = Date.now()): number {
  const timestamps = changes.map((change) => Date.parse(change.at)).filter(Number.isFinite);
  const earliest = timestamps.length === 0 ? now : Math.min(...timestamps);
  return Math.ceil(Math.max(0, now - earliest) / DAY_MS) + BASELINE_MAX_DAYS + 1;
}

export function measureResults(
  input: ResultsInput,
  changes: readonly AppliedChange[],
  options: { now?: number } = {},
): ResultsReport {
  const now = options.now ?? Date.now();
  const { events } = input;
  const results = [...changes]
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .map((change) => measureChange(events, change, now, changes));
  return {
    schema: "munin.results/1",
    generatedAt: new Date(now).toISOString(),
    results,
  };
}

function measureChange(
  events: readonly UsageEvent[],
  change: AppliedChange,
  now: number,
  others: readonly AppliedChange[],
): ChangeResult {
  const at = Date.parse(change.at);
  const end = Math.min(now, change.until === undefined ? now : Date.parse(change.until));
  const afterDays = Math.max(0, (end - at) / DAY_MS);
  const baselineDays = Math.min(BASELINE_MAX_DAYS, Math.max(BASELINE_MIN_DAYS, afterDays));
  const priorRuleChanges = others
    .filter((other) => other.rule === change.rule && Date.parse(other.at) < at)
    .map((other) => Date.parse(other.at));
  const from = Math.max(at - baselineDays * DAY_MS, ...priorRuleChanges);
  const inBefore = events.filter((event) => {
    const time = Date.parse(event.ts);
    return time >= from && time < at;
  });
  const inAfter = events.filter((event) => {
    const time = Date.parse(event.ts);
    return time >= at && time < end;
  });
  const before = periodOf(inBefore, from, at);
  const after = periodOf(inAfter, at, end);
  const measure: "turn" | "call" = before.turns + after.turns > 0 ? "turn" : "call";
  const countOf = (period: ResultPeriod) => (measure === "turn" ? period.turns : period.calls);
  const needCount = measure === "turn" ? READY_TURNS : READY_CALLS;
  const ready = after.activeDays >= READY_ACTIVE_DAYS && countOf(after) >= needCount;
  const baselineReady = before.activeDays >= READY_ACTIVE_DAYS && countOf(before) >= needCount / 2;
  const beforeRate = countOf(before) > 0 ? before.costUsd / countOf(before) : null;
  const afterRate = countOf(after) > 0 ? after.costUsd / countOf(after) : null;
  const changeRatio =
    beforeRate !== null && beforeRate > 0 && afterRate !== null ? afterRate / beforeRate - 1 : null;
  const headline = makeRow(measure, beforeRate, afterRate, changeRatio);
  const tradeOff = measure === "turn" ? callsPerTurnRow(before, after) : null;
  let verdict: ResultVerdict;
  if (!ready) verdict = "too-early";
  else if (!baselineReady) verdict = "no-baseline";
  else if (changeRatio === null || Math.abs(changeRatio) < EFFECT) verdict = "no-change";
  else verdict = changeRatio <= -EFFECT ? "working" : "worse";

  const sensitivity = sensitivityRange(events, after, from, at, end, measure);
  return {
    change,
    verdict,
    measure,
    headline,
    before,
    after,
    rows: [headline, tradeOff].filter((row): row is ResultRow => row !== null),
    range:
      ready && baselineReady && sensitivity.length > 1
        ? {
            low: Math.min(...sensitivity.map((row) => row.change)),
            high: Math.max(...sensitivity.map((row) => row.change)),
            shortest: Math.min(...sensitivity.map((row) => row.days)),
            longest: Math.max(...sensitivity.map((row) => row.days)),
          }
        : null,
    measuredSavingUsd:
      ready && baselineReady && beforeRate !== null && afterRate !== null
        ? (beforeRate - afterRate) * countOf(after)
        : null,
    progress: {
      activeDays: after.activeDays,
      count: countOf(after),
      needActiveDays: READY_ACTIVE_DAYS,
      needCount,
    },
  };
}

function periodOf(events: readonly UsageEvent[], fromMs: number, toMs: number): ResultPeriod {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    days: Math.max(0, (toMs - fromMs) / DAY_MS),
    activeDays: new Set(events.map((event) => event.ts.slice(0, 10))).size,
    calls: events.length,
    turns: new Set(
      events.filter((event) => !event.isSubagent && event.turnId).map((event) => event.turnId),
    ).size,
    sessions: new Set(events.map((event) => event.sessionId)).size,
    costUsd: events.reduce((sum, event) => sum + event.cost.total, 0),
  };
}

function makeRow(
  measure: "turn" | "call",
  before: number | null,
  after: number | null,
  change: number | null,
): ResultRow | null {
  if (before === null || after === null) return null;
  return {
    key: measure === "turn" ? "costPerTurn" : "costPerCall",
    label: measure === "turn" ? "cost per turn" : "cost per call",
    unit: "usd",
    before,
    after,
    change,
    better: "lower",
  };
}

function callsPerTurnRow(before: ResultPeriod, after: ResultPeriod): ResultRow | null {
  if (before.turns === 0 || after.turns === 0) return null;
  const beforeRate = before.calls / before.turns;
  const afterRate = after.calls / after.turns;
  const change = beforeRate > 0 ? afterRate / beforeRate - 1 : null;
  return {
    key: "callsPerTurn",
    label: "calls per turn",
    unit: "count",
    before: beforeRate,
    after: afterRate,
    change,
    better: "lower",
    tradeOff: true,
    ...(change !== null && change >= 0.25 ? { worse: true } : {}),
  };
}

function sensitivityRange(
  events: readonly UsageEvent[],
  after: ResultPeriod,
  from: number,
  at: number,
  end: number,
  measure: "turn" | "call",
): Array<{ days: number; change: number }> {
  const countOf = (period: ResultPeriod) => (measure === "turn" ? period.turns : period.calls);
  const afterRate = countOf(after) > 0 ? after.costUsd / countOf(after) : null;
  const rows: Array<{ days: number; change: number }> = [];
  for (const days of [Math.min(BASELINE_MAX_DAYS, (at - from) / DAY_MS), ...SHORT_BASELINES]) {
    if (days <= 0 || rows.some((row) => row.days === days)) continue;
    const start = Math.max(from, at - days * DAY_MS);
    const beforeEvents = events.filter((event) => {
      const time = Date.parse(event.ts);
      return time >= start && time < at;
    });
    const period = periodOf(beforeEvents, start, at);
    const beforeRate = countOf(period) > 0 ? period.costUsd / countOf(period) : null;
    if (beforeRate !== null && beforeRate > 0 && afterRate !== null) {
      rows.push({ days: (at - start) / DAY_MS, change: afterRate / beforeRate - 1 });
    }
  }
  return rows;
}
