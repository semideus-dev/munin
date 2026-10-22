/**
 * The source model: what a reader produces before normalization.
 *
 * It mirrors the shape of local history closely enough to keep provenance
 * (which message, which session, which schema) without leaking provider JSON
 * upward. Message text never enters this model: only its shape, so the
 * ledger and the dashboard cannot accidentally persist prompts.
 */
import type { ModelRef, SchemaVersion, TokenCounts, ToolCall } from "./usage.js";

/** What the source database contained. `none` means it had no usable tables. */
export type SourceSchema = SchemaVersion | "mixed" | "none";

/**
 * Message kinds Munin recognises. Anything else is kept as `unknown` with its
 * raw type, so a new OpenCode release degrades instead of failing.
 */
export type SourceMessageType =
  | "assistant"
  | "user"
  | "compaction"
  | "idle"
  | "model-switched"
  | "agent-switched"
  | "system"
  | "synthetic"
  | "unknown";

/** Usage attached to one source message, when it is a model call. */
export interface SourceUsage {
  tokens: TokenCounts;
  /** The provider-reported charge, when the source records one. */
  observedUsd?: number;
}

/** One OpenCode conversation, before analysis. */
export interface SourceSession {
  id: string;
  /** Set when this session was created by another one. */
  parentId?: string;
  projectId: string;
  /** Human label for the project, e.g. its worktree name. */
  project?: string;
  title?: string;
  directory?: string;
  agent?: string;
  model?: ModelRef;
  schema: SchemaVersion;
  /** ISO 8601. */
  timeCreated: string;
  timeUpdated: string;
  /**
   * The source's own session aggregate. Kept only to reconcile against the sum
   * of its messages (docs/adr/0002-message-level-accounting.md), never billed.
   */
  aggregateUsage?: TokenCounts;
  aggregateCost?: number;
}

/** One stored record inside a session. */
export interface SourceMessage {
  id: string;
  sessionId: string;
  /** Monotonic position within the session, as the source orders it. */
  seq: number;
  type: SourceMessageType;
  /** The source's own type string when `type` is `unknown`. */
  rawType?: string;
  /** ISO 8601. */
  timeCreated: string;
  timeUpdated?: string;
  /** When the model call finished, when the source distinguishes the two. */
  completedAt?: string;
  agent?: string;
  model?: ModelRef;
  usage?: SourceUsage;
  toolCalls?: ToolCall[];
  /** Completion reason (`stop`, `tool-calls`, `error`, ...). */
  stopReason?: string;
  /** Provider error class, e.g. `provider.quota`. */
  errorType?: string;
  /** Characters of text the message carried. Never the text itself. */
  textChars?: number;
}

/**
 * A non-fatal problem found while reading. `code` is stable so callers and
 * tests can match on it; `message` is for humans.
 */
export interface SourceWarning {
  code: string;
  message: string;
  /** How many records the warning covers, when it aggregates. */
  count?: number;
}

/** Everything one read produced, normalized but not yet analysed. */
export interface Dataset {
  schema: SourceSchema;
  sessions: SourceSession[];
  messages: SourceMessage[];
  warnings: SourceWarning[];
  /** Files or stores actually read, for provenance in reports. */
  sources: string[];
}
