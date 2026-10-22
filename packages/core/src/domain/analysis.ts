/**
 * Analysis contracts built on top of the Phase 2 dataset.
 *
 * `CallAttempt` keeps every model call, including failures. `UsageEvent` keeps
 * only the calls that reported usage, so call counts and cost averages stay
 * honest and a failed attempt is never billed as a free call.
 */
import type { ModelRef, SchemaVersion, UsageEvent } from "./usage.js";
import type { SourceSchema, SourceUsage, SourceWarning } from "./source.js";

export type CallAttemptType = "assistant" | "compaction";

/** One assistant or compaction message, with or without usage. */
export interface CallAttempt {
  /** The source message id. */
  id: string;
  sessionId: string;
  /** ISO 8601, when the call started. */
  ts: string;
  type: CallAttemptType;
  /** Message model, then session model; absent when neither records one. */
  model?: ModelRef;
  agent?: string;
  /** Present only when the source reported token usage. Observed cost rides here. */
  usage?: SourceUsage;
  /** Provider-reported charge, when present. Mirrors `usage.observedUsd`. */
  observedUsd?: number;
  stopReason?: string | null;
  /** Provider error class, e.g. `provider.quota`. */
  errorType?: string;
  turnId?: string;
  turnStartedAt?: string;
}

/**
 * The observed span of a priced dataset. Empty input has no start or end and
 * zero elapsed days; a non-empty span never reports less than one day.
 */
export interface Window {
  start: string | null;
  end: string | null;
  days: number;
}

/** What `buildEvents()` produces. Pure: no clock, filesystem, or network. */
export interface PricedDataset {
  schema: SourceSchema;
  events: UsageEvent[];
  /** Every assistant/compaction attempt, including ones with no usage. */
  attempts: CallAttempt[];
  window: Window;
  /** Phase 2 warnings unchanged, plus Phase 3 `price.*` and `analysis.*`. */
  warnings: SourceWarning[];
}

/**
 * Which zone day buckets use. `"UTC"` is the default, `"local"` follows the
 * machine's zone, and any IANA zone id is accepted.
 */
export type DayZone = "UTC" | "local" | (string & {});

/**
 * One group of events behind a report row: a model, a provider, a project, a
 * day, a session, or an agent.
 *
 * `totalTokens` is input + priced output + cache read + cache write. Thinking
 * is part of priced output, so it is not added again.
 */
export interface SpendBucket {
  key: string;
  /** Display label when it differs from the key, e.g. a project name. */
  label?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  observedUsd: number;
  /** Dated list-price estimate; unpriced calls contribute nothing here. */
  estimatedUsd: number;
  headlineUsd: number;
  /** Share of the total headline spend. `0` when that total is `0`. */
  spendShare: number;
  /** `read / (input + read + write)`; `null` when there is no input side. */
  cacheHitRate: number | null;
  /** True when at least one call in the bucket could not be priced. */
  unpriced: boolean;
  /** Bare model ids present in the bucket. */
  models: string[];
  /** Source provider strings present in the bucket. */
  providers: string[];
}

export interface Totals {
  calls: number;
  /** Sessions with at least one billable event. */
  sessions: number;
  /** Distinct `(sessionId, turnId)` pairs. */
  turns: number;
  /** Sessions with `isSubagent`, counted once. */
  subagentSessions: number;

  inputTokens: number;
  /** Priced output, i.e. source output plus reasoning. */
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Input + priced output + cache read + cache write. */
  totalTokens: number;

  /** The headline: observed where reported, else the list-price estimate. */
  headlineUsd: number;
  observedUsd: number;
  /** API-equivalent list-price estimate, excluding unpriced calls. */
  estimatedUsd: number;
  unpricedCalls: number;
  /** Bare model ids with at least one unpriced call. */
  unpricedModels: string[];
  /** Share of calls whose headline basis is `observed`. */
  observedCoverage: number | null;

  cacheHitRate: number | null;
  /** Thinking as a share of priced output. */
  thinkingShare: number | null;
  avgTokensPerCall: number;
  avgCostPerCall: number;
}

export interface Summary {
  totals: Totals;
  byModel: SpendBucket[];
  byProvider: SpendBucket[];
  byProject: SpendBucket[];
  byDay: SpendBucket[];
  bySession: SpendBucket[];
  byAgent: SpendBucket[];
}

export interface SummarizeOptions {
  /** Day bucketing zone; `"UTC"` by default. */
  zone?: DayZone;
}

/** One session, summarised from its events. */
export interface SessionSummary {
  id: string;
  /** The source session title, when read. */
  title?: string;
  projectId?: string;
  project: string;
  parentSessionId?: string;
  isSubagent: boolean;
  agents: string[];
  /** `provider/model` strings that made calls in this session. */
  models: string[];
  schema: SchemaVersion;
  firstTs: string | null;
  lastTs: string | null;
  calls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  observedUsd: number;
  estimatedUsd: number;
  headlineUsd: number;
  cacheHitRate: number | null;
  /** True when at least one call in the session could not be priced. */
  unpriced: boolean;
  /** Compaction messages in the session, counted exactly when attempts are given. */
  compactions: number;
  observedCoverage: number | null;
}

/** One human project label that maps to more than one project id. */
export interface ProjectLabelCollision {
  label: string;
  projectIds: string[];
}

/**
 * Cache traffic for one group of events.
 *
 * Costs are always the list-price estimate, even when a call's headline basis
 * is `observed`: the source reports one observed number, never a cache invoice.
 */
export interface CacheBreakdown {
  key: string;
  calls: number;
  inputTokens: number;
  readTokens: number;
  writeTokens: number;
  write5mTokens: number;
  write1hTokens: number;
  /** `read / (input + read + write)`; `null` when there is no input side. */
  hitRate: number | null;
  estimatedReadUsd: number;
  estimatedWriteUsd: number;
  /**
   * Hit rate of the later half of the group's calls minus the earlier half, by
   * event order. `null` when a half is empty or has no input side.
   */
  hitRateChange: number | null;
}

export interface CacheStatsOptions {
  /** Day bucketing zone; `"UTC"` by default. */
  zone?: DayZone;
}

export interface CacheStats {
  inputTokens: number;
  readTokens: number;
  writeTokens: number;
  /** Hits are billed at the cached rate; writes go out in two TTL buckets. */
  write5mTokens: number;
  write1hTokens: number;
  /** `read / (input + read + write)`; `null` when there is no input side. */
  hitRate: number | null;
  estimatedReadUsd: number;
  estimatedWriteUsd: number;
  /** Cache cost as a share of the total list-price estimate. */
  shareOfEstimate: number;
  /** False when no call recorded a cache write. */
  writesRecorded: boolean;

  byModel: CacheBreakdown[];
  byProvider: CacheBreakdown[];
  bySession: CacheBreakdown[];
  byDay: CacheBreakdown[];

  instructionContext: InstructionContext;
}

/** One cache-identity group: a prefix shared by one agent, model and variant. */
export interface SharedPrefix {
  prefixHash: string;
  /** `"unknown"` when the source records no agent. */
  agent: string;
  /** `provider/model`. */
  model: string;
  variant?: string;
  sessions: number;
  calls: number;
  /** Uncached input tokens across the group, the base a longer TTL could reuse. */
  uncachedInputTokens: number;
}

export interface InstructionContext {
  /** Sessions whose events carry instruction metadata. */
  sessions: number;
  /** Instruction characters across those sessions, counted once per session. */
  totalChars: number;
  distinctPrefixHashes: number;
  /** Identity groups with at least two sessions. */
  sharedPrefixes: SharedPrefix[];
}
