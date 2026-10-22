/**
 * The analysis model: what the engine consumes and what every report reads.
 *
 * Readers know provider formats; analysis must not. Everything downstream of
 * normalization speaks these types. Optional fields stay optional: a missing
 * provider field is a fact about the source, not something to invent.
 */

/**
 * How a number came to exist, shown on every figure.
 * - `measured`: read directly from provider-reported usage.
 * - `inferred`: derived from measured data by a stated rule.
 * - `estimated`: a projection that rests on assumptions.
 */
export type EvidenceClass = "measured" | "inferred" | "estimated";

export interface Evidence {
  kind: EvidenceClass;
  /** One line on where the number came from. */
  basis: string;
}

/** Which OpenCode schema generation a record came from. */
export type SchemaVersion = "v1" | "v2";

/** A provider/model identifier exactly as the source reported it. */
export interface ModelRef {
  provider: string;
  model: string;
  /** The provider's reasoning-effort label, e.g. `low`, `medium`, `high`. */
  variant?: string;
}

/**
 * Token categories. They stay separate because every provider prices them
 * separately, and a total alone cannot be re-priced.
 */
export interface TokenCounts {
  input: number;
  output: number;
  /** Reasoning tokens, when the provider reports them separately. */
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What a task was doing, from its shape: calls, files edited, failures,
 * output, reasoning. Never from prompt text.
 */
export type TaskKind =
  | "quick-edit"
  | "lookup"
  | "conversation"
  | "multi-step"
  | "debugging"
  | "reasoning";

/** What a call was doing, inferred from token counts and tool use (not intent). */
export type WorkloadCategory =
  | "reasoning"
  | "tool-orchestration"
  | "generation"
  | "mechanical"
  | "unknown";

export interface ToolCall {
  id: string;
  name: string;
  /** Normalised signature used to detect repeats, e.g. `Read:/path/to/file`. */
  signature: string;
  /** Characters returned by the tool, when the result was captured. */
  resultChars?: number;
  /** Estimated tokens in the result: length for text, pixel area for images. */
  resultTokens?: number;
  /** The file a file tool read or changed, so an edit can retire earlier reads. */
  target?: string;
  isError?: boolean;
}

/** Which number the headline uses for a call (docs/adr/0003-observed-cost-headlines.md). */
export type CostBasis = "observed" | "estimated";

/**
 * The money a call cost.
 *
 * `total` is the headline number and follows `basis`: observed when the source
 * reported a charge, otherwise our dated list price. The per-category fields
 * always describe the estimated breakdown, because sources report a single
 * number rather than a token-level invoice.
 */
export interface CostCalculation {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Per-request server-tool charges. No token count includes them. */
  serverTools: number;
  /** The headline: observed when present, otherwise estimated. */
  total: number;
  /** True when the model has no card and the source reported no cost. */
  unpriced: boolean;
  /** Provider-reported charge, when the source records one. */
  observedUsd: number | null;
  /** What the same tokens cost at Munin's list prices, when a card exists. */
  estimatedUsd: number | null;
  basis: CostBasis;
}

/** One model call, normalised. The unit of analysis. */
export interface UsageEvent {
  /** Stable id. The source message id, so a call can be traced back. */
  id: string;
  source: "opencode";
  /** Which schema the call was read from, for data-health reporting. */
  schema: SchemaVersion;
  provider: string;
  model: string;
  /** The provider's reasoning-effort setting, reported as `variant` by OpenCode. */
  variant?: string | null;
  /** The agent that made the call, when the source records one. */
  agent?: string;

  /** ISO 8601. */
  ts: string;
  sessionId: string;
  parentSessionId?: string;
  /** Stable project id, and the human label used in reports. */
  projectId?: string;
  project: string;

  category?: WorkloadCategory;
  turnId?: string;
  turnStartedAt?: string;
  endTs?: string;
  /** Increments at each compaction, so calls on either side are comparable. */
  contextEpoch?: number;
  taskKind?: TaskKind;

  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;

  latencyMs?: number;
  /** Completion reason (`stop`, `tool-calls`, `error`, ...). */
  stopReason?: string | null;
  speed?: string | null;
  serviceTier?: string | null;
  batch?: boolean;
  isSubagent?: boolean;
  headless?: boolean;

  tools: ToolCall[];

  /**
   * The instruction set attached to the session: keys and total characters.
   * Sizes come from the source's instruction blobs, never from prompt text.
   */
  instructionKeys?: string[];
  instructionChars?: number;
  toolDefCount?: number;
  /** Hash of the instruction set plus agent and model, for cache analysis. */
  prefixHash?: string;

  cost: CostCalculation;
}
