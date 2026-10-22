import type { Totals, Window } from "./analysis.js";
import type { SourceSchema } from "./source.js";
import type { UsageEvent } from "./usage.js";

export interface SessionSlice {
  schema: "munin.slice/1";
  sessionId: string;
  at: string;
  watermarkMs: number;
  events: UsageEvent[];
}

export type SnapshotTotals = Pick<
  Totals,
  | "calls"
  | "sessions"
  | "inputTokens"
  | "outputTokens"
  | "thinkingTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "totalTokens"
  | "headlineUsd"
  | "observedUsd"
  | "estimatedUsd"
>;

export interface SnapshotModelRow {
  provider: string;
  model: string;
  calls: number;
  totalTokens: number;
  headlineUsd: number;
  observedUsd: number;
  estimatedUsd: number;
}

export interface SnapshotFinding {
  rule: string;
  count: number;
  claimedWindowUsd: number;
}

export interface Snapshot {
  schema: "munin.snapshot/1";
  /** Monotonically increasing scan sequence. */
  id: number;
  at: string;
  source: {
    path: string;
    origin: "flag" | "env" | "settings" | "default";
    schema: SourceSchema;
  };
  scope: { mode: "full" | "incremental"; sessionsRead: number; slicesReplaced: number };
  state: { sessionsTracked: number; eventsTracked: number };
  window: Window;
  totals: SnapshotTotals;
  byModel: SnapshotModelRow[];
  findings: SnapshotFinding[];
  dataClean: boolean;
  warningCounts: Record<string, number>;
}

export interface SnapshotDiff {
  fromId: number;
  toId: number;
  sessions: { before: number; after: number; delta: number };
  totals: {
    calls: number;
    totalTokens: number;
    headlineUsd: number;
    observedUsd: number;
    estimatedUsd: number;
  };
  byModel: Array<{
    provider: string;
    model: string;
    calls: number;
    totalTokens: number;
    headlineUsd: number;
  }>;
  findings: {
    appeared: string[];
    disappeared: string[];
    grew: string[];
  };
}

export interface ScanCursor {
  schema: "munin.cursor/1";
  sourceSchema: SourceSchema;
  v1: number | null;
  v2: number | null;
  at: string;
}
