/**
 * Usage: the report's aggregates untouched, plus a session timeline built from
 * the existing priced dataset.
 *
 * The timeline deliberately projects events and attempts onto display fields.
 * It never passes through prompts, message bodies, tool inputs, tool results,
 * instruction text or arbitrary payloads: only the metadata the report and the
 * priced dataset already expose.
 */
import type {
  CallAttempt,
  CacheStats,
  MuninReport,
  PricedDataset,
  SessionSummary,
  SpendBucket,
  Totals,
  Window,
} from "@munin/core";

export interface UsageOverviewDTO {
  window: Window;
  timeZone: string;
  totals: Totals;
  byModel: SpendBucket[];
  byProvider: SpendBucket[];
  byProject: SpendBucket[];
  byAgent: SpendBucket[];
  byDay: SpendBucket[];
  bySession: SpendBucket[];
  cache: CacheStats;
  /** One row per session with usage-bearing calls; children not rolled up. */
  sessions: SessionSummary[];
}

export interface SessionEventCostDTO {
  total: number;
  basis: "observed" | "estimated";
  unpriced: boolean;
  observedUsd: number | null;
  estimatedUsd: number | null;
}

/** One billed model call in a session. No body content, ever. */
export interface SessionEventDTO {
  id: string;
  ts: string;
  type: "assistant" | "compaction";
  provider: string;
  model: string;
  variant: string | null;
  agent: string | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  contextEpoch: number | null;
  turnId: string | null;
  stopReason: string | null;
  speed: string | null;
  serviceTier: string | null;
  batch: boolean;
  isSubagent: boolean;
  latencyMs: number | null;
  /** Number of tool calls attached to this model call, never their contents. */
  toolCallCount: number;
  cost: SessionEventCostDTO;
}

/** One assistant/compaction attempt, including failures with no usage. */
export interface SessionAttemptDTO {
  id: string;
  ts: string;
  type: "assistant" | "compaction";
  provider: string | null;
  model: string | null;
  agent: string | null;
  /** False marks a failed attempt: it is not a free successful call. */
  hasUsage: boolean;
  observedUsd: number | null;
  stopReason: string | null;
  errorType: string | null;
}

export interface SessionDetailDTO {
  session: SessionSummary;
  parentSessionId: string | null;
  isSubagent: boolean;
  /** Billed usage events, chronological. */
  events: SessionEventDTO[];
  /** Every attempt in the session, chronological, failures included. */
  attempts: SessionAttemptDTO[];
}

export function usageOverviewDTO(report: MuninReport): UsageOverviewDTO {
  return {
    window: report.window,
    timeZone: report.timeZone,
    totals: report.totals,
    byModel: report.byModel,
    byProvider: report.byProvider,
    byProject: report.byProject,
    byAgent: report.byAgent,
    byDay: report.byDay,
    bySession: report.bySession,
    cache: report.cache,
    sessions: report.sessions,
  };
}

function eventTypeMap(attempts: readonly CallAttempt[]): Map<string, CallAttempt["type"]> {
  return new Map(attempts.map((attempt) => [attempt.id, attempt.type]));
}

function eventDTO(
  event: PricedDataset["events"][number],
  types: ReadonlyMap<string, CallAttempt["type"]>,
): SessionEventDTO {
  return {
    id: event.id,
    ts: event.ts,
    type: types.get(event.id) ?? "assistant",
    provider: event.provider,
    model: event.model,
    variant: event.variant ?? null,
    agent: event.agent ?? null,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    thinkingTokens: event.thinkingTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWrite5mTokens: event.cacheWrite5mTokens,
    cacheWrite1hTokens: event.cacheWrite1hTokens,
    contextEpoch: event.contextEpoch ?? null,
    turnId: event.turnId ?? null,
    stopReason: event.stopReason ?? null,
    speed: event.speed ?? null,
    serviceTier: event.serviceTier ?? null,
    batch: event.batch === true,
    isSubagent: event.isSubagent === true,
    latencyMs: event.latencyMs ?? null,
    toolCallCount: event.tools.length,
    cost: {
      total: event.cost.total,
      basis: event.cost.basis,
      unpriced: event.cost.unpriced,
      observedUsd: event.cost.observedUsd,
      estimatedUsd: event.cost.estimatedUsd,
    },
  };
}

function attemptDTO(attempt: CallAttempt): SessionAttemptDTO {
  return {
    id: attempt.id,
    ts: attempt.ts,
    type: attempt.type,
    provider: attempt.model?.provider ?? null,
    model: attempt.model?.model ?? null,
    agent: attempt.agent ?? null,
    hasUsage: attempt.usage !== undefined,
    observedUsd: attempt.observedUsd ?? null,
    stopReason: attempt.stopReason ?? null,
    errorType: attempt.errorType ?? null,
  };
}

export function sessionDetailDTO(
  report: MuninReport,
  priced: PricedDataset,
  sessionId: string,
): SessionDetailDTO | null {
  const summary = report.sessions.find((session) => session.id === sessionId);
  if (summary === undefined) return null;
  const types = eventTypeMap(priced.attempts);
  const events = priced.events
    .filter((event) => event.sessionId === sessionId)
    .map((event) => eventDTO(event, types));
  const attempts = priced.attempts
    .filter((attempt) => attempt.sessionId === sessionId)
    .map(attemptDTO);
  return {
    session: summary,
    parentSessionId: summary.parentSessionId ?? null,
    isSubagent: summary.isSubagent,
    events,
    attempts,
  };
}
