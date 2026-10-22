/**
 * Cache read/write analysis.
 *
 * Descriptive only: numbers here describe what happened, and nothing claims a
 * low hit rate is waste (that judgement is a detector in Phase 4). Cache costs
 * are always the list-price estimate; the observed total is never rebuilt from
 * cache categories.
 */
import type {
  CacheBreakdown,
  CacheStats,
  CacheStatsOptions,
  DayZone,
  InstructionContext,
  SharedPrefix,
} from "../domain/analysis.js";
import type { UsageEvent } from "../domain/usage.js";
import { dayKey } from "./day.js";

/** Codepoint order, so results never depend on the runtime locale. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Acc {
  calls: number;
  inputTokens: number;
  readTokens: number;
  writeTokens: number;
  write5mTokens: number;
  write1hTokens: number;
  estimatedReadUsd: number;
  estimatedWriteUsd: number;
}

function emptyAcc(): Acc {
  return {
    calls: 0,
    inputTokens: 0,
    readTokens: 0,
    writeTokens: 0,
    write5mTokens: 0,
    write1hTokens: 0,
    estimatedReadUsd: 0,
    estimatedWriteUsd: 0,
  };
}

function addEvent(acc: Acc, event: UsageEvent): void {
  acc.calls += 1;
  acc.inputTokens += event.inputTokens;
  acc.readTokens += event.cacheReadTokens;
  acc.write5mTokens += event.cacheWrite5mTokens;
  acc.write1hTokens += event.cacheWrite1hTokens;
  acc.writeTokens += event.cacheWrite5mTokens + event.cacheWrite1hTokens;
  acc.estimatedReadUsd += event.cost.cacheRead;
  acc.estimatedWriteUsd += event.cost.cacheWrite;
}

function hitRate(acc: {
  readTokens: number;
  inputTokens: number;
  writeTokens: number;
}): number | null {
  const inputSide = acc.inputTokens + acc.readTokens + acc.writeTokens;
  return inputSide === 0 ? null : acc.readTokens / inputSide;
}

function accumulate(events: UsageEvent[]): Acc {
  const acc = emptyAcc();
  for (const event of events) addEvent(acc, event);
  return acc;
}

function toBreakdown(key: string, events: UsageEvent[]): CacheBreakdown {
  const acc = accumulate(events);

  // Change over the window: the later half of the calls against the earlier
  // half, in event order. With an odd count the middle call is in neither.
  const mid = Math.floor(events.length / 2);
  let hitRateChange: number | null = null;
  if (mid > 0) {
    const earlier = accumulate(events.slice(0, mid));
    const later = accumulate(events.slice(events.length - mid));
    const earlierRate = hitRate(earlier);
    const laterRate = hitRate(later);
    if (earlierRate !== null && laterRate !== null) hitRateChange = laterRate - earlierRate;
  }

  return {
    key,
    calls: acc.calls,
    inputTokens: acc.inputTokens,
    readTokens: acc.readTokens,
    writeTokens: acc.writeTokens,
    write5mTokens: acc.write5mTokens,
    write1hTokens: acc.write1hTokens,
    hitRate: hitRate(acc),
    estimatedReadUsd: acc.estimatedReadUsd,
    estimatedWriteUsd: acc.estimatedWriteUsd,
    hitRateChange,
  };
}

function byCacheSpendDescThenKey(a: CacheBreakdown, b: CacheBreakdown): number {
  const aCache = a.estimatedReadUsd + a.estimatedWriteUsd;
  const bCache = b.estimatedReadUsd + b.estimatedWriteUsd;
  if (aCache !== bCache) return bCache - aCache;
  return asc(a.key, b.key);
}

function breakdown(map: Map<string, UsageEvent[]>): CacheBreakdown[] {
  const rows: CacheBreakdown[] = [];
  for (const [key, events] of map) rows.push(toBreakdown(key, events));
  return rows.sort(byCacheSpendDescThenKey);
}

/**
 * Cache read/write behaviour over priced events.
 *
 * Events are consumed in the order given; buildEvents() output is already in a
 * stable order.
 */
export function cacheStats(events: UsageEvent[], options: CacheStatsOptions = {}): CacheStats {
  const zone: DayZone = options.zone ?? "UTC";

  const totals = emptyAcc();
  const byModel = new Map<string, UsageEvent[]>();
  const byProvider = new Map<string, UsageEvent[]>();
  const bySession = new Map<string, UsageEvent[]>();
  const byDay = new Map<string, UsageEvent[]>();

  for (const event of events) {
    addEvent(totals, event);
    pushTo(byModel, `${event.provider}/${event.model}`, event);
    pushTo(byProvider, event.provider, event);
    pushTo(bySession, event.sessionId, event);
    pushTo(byDay, dayKey(event.ts, zone), event);
  }

  const estimatedTotal = events.reduce((sum, event) => sum + (event.cost.estimatedUsd ?? 0), 0);
  const cacheUsd = totals.estimatedReadUsd + totals.estimatedWriteUsd;

  return {
    inputTokens: totals.inputTokens,
    readTokens: totals.readTokens,
    writeTokens: totals.writeTokens,
    write5mTokens: totals.write5mTokens,
    write1hTokens: totals.write1hTokens,
    hitRate: hitRate(totals),
    estimatedReadUsd: totals.estimatedReadUsd,
    estimatedWriteUsd: totals.estimatedWriteUsd,
    shareOfEstimate: estimatedTotal === 0 ? 0 : cacheUsd / estimatedTotal,
    writesRecorded: totals.writeTokens > 0,
    byModel: breakdown(byModel),
    byProvider: breakdown(byProvider),
    bySession: breakdown(bySession),
    byDay: breakdown(byDay),
    instructionContext: instructionContextOf(events),
  };
}

function pushTo(map: Map<string, UsageEvent[]>, key: string, event: UsageEvent): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [event]);
  else list.push(event);
}

/**
 * Instruction context, grouped by the cache identity
 * `prefixHash + agent + model + variant`, never the prefix hash alone: two
 * agents on one model share nothing at request time.
 */
function instructionContextOf(events: UsageEvent[]): InstructionContext {
  const seenSessions = new Set<string>();
  const prefixHashes = new Set<string>();
  let totalChars = 0;

  interface Group {
    prefixHash: string;
    agent: string;
    model: string;
    variant: string | undefined;
    sessions: Set<string>;
    calls: number;
    uncachedInputTokens: number;
  }
  const groups = new Map<string, Group>();

  for (const event of events) {
    const hasInstructions = event.instructionChars !== undefined || event.prefixHash !== undefined;
    if (hasInstructions && !seenSessions.has(event.sessionId)) {
      // Instruction size and prefix are session properties; count them on the
      // first observed event of the session, never per call.
      seenSessions.add(event.sessionId);
      if (event.instructionChars !== undefined) totalChars += event.instructionChars;
      if (event.prefixHash !== undefined) prefixHashes.add(event.prefixHash);
    }

    if (event.prefixHash !== undefined) {
      const agent = event.agent ?? "unknown";
      const model = `${event.provider}/${event.model}`;
      const variant = event.variant ?? undefined;
      const key = `${event.prefixHash}\u0000${agent}\u0000${model}\u0000${variant ?? "-"}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          prefixHash: event.prefixHash,
          agent,
          model,
          variant,
          sessions: new Set([event.sessionId]),
          calls: 1,
          uncachedInputTokens: event.inputTokens,
        });
      } else {
        group.sessions.add(event.sessionId);
        group.calls += 1;
        group.uncachedInputTokens += event.inputTokens;
      }
    }
  }

  const sharedPrefixes: SharedPrefix[] = [];
  for (const group of groups.values()) {
    if (group.sessions.size < 2) continue;
    sharedPrefixes.push({
      prefixHash: group.prefixHash,
      agent: group.agent,
      model: group.model,
      ...(group.variant === undefined ? {} : { variant: group.variant }),
      sessions: group.sessions.size,
      calls: group.calls,
      uncachedInputTokens: group.uncachedInputTokens,
    });
  }
  sharedPrefixes.sort((a, b) => {
    if (a.uncachedInputTokens !== b.uncachedInputTokens) {
      return b.uncachedInputTokens - a.uncachedInputTokens;
    }
    return asc(a.prefixHash, b.prefixHash);
  });

  return {
    sessions: seenSessions.size,
    totalChars,
    distinctPrefixHashes: prefixHashes.size,
    sharedPrefixes,
  };
}
