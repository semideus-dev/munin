/**
 * Runtime, health and privacy DTOs: scan state, snapshot history, results,
 * monitoring lifecycle, source/pricing health and the privacy audit.
 *
 * Everything is mapped from `@munin/local`'s existing store APIs and core's
 * report health fields. No history is invented: if the ledger has no snapshots,
 * the lists are empty and the latest difference is null.
 */
import type {
  AppliedChange,
  DataHealth,
  ResultsReport,
  Snapshot,
  SnapshotDiff,
  SourceWarning,
} from "@munin/core";
import type { SessionDrift } from "@munin/local";
import type { ServiceErrorDTO } from "../errors.js";
import type { SourceStatusDTO } from "./common.js";

export type ScanRuntimeState = "idle" | "scanning" | "success" | "warning" | "error";

export interface ScanTotalsDTO {
  calls: number;
  sessions: number;
  turns: number;
  subagentSessions: number;
  headlineUsd: number;
  observedUsd: number;
  estimatedUsd: number;
  totalTokens: number;
}

/** One explicit or watch-triggered scan, as the Activity tab shows it. */
export interface ScanDTO {
  at: string;
  mode: "full" | "incremental";
  /** `warning` when the scan completed with warnings, otherwise `success`. */
  status: "success" | "warning";
  /** Wall time for a manual scan; null for a watch tick, which cannot report it. */
  durationMs: number | null;
  sessionsRead: number;
  slicesReplaced: number;
  newSessionIds: string[];
  replacedSessionIds: string[];
  repaired: boolean;
  totals: ScanTotalsDTO;
  warnings: SourceWarning[];
  reconciliation: SessionDrift[];
  snapshotId: number;
  snapshotDiff: SnapshotDiff | null;
}

export interface MonitoringStateDTO {
  enabled: boolean;
  /** Poll interval in milliseconds. */
  intervalMs: number;
  startedAt: string | null;
  lastPollAt: string | null;
  lastTick: "unchanged" | "busy" | "scan" | "warning" | null;
  scanCount: number;
  warningCount: number;
  lastWarning: { message: string; at: string } | null;
  lastScan: ScanDTO | null;
}

export interface ResultsDTO {
  changes: AppliedChange[];
  daysRequired: number;
  report: ResultsReport;
  skippedLines: number;
}

export interface ActivityDTO {
  status: ScanRuntimeState;
  /** The last scan performed by this service instance, if any. */
  lastScan: ScanDTO | null;
  lastError: (ServiceErrorDTO & { at: string }) | null;
  monitoring: MonitoringStateDTO;
  /** Full snapshot history from the ledger, oldest first. */
  snapshots: Snapshot[];
  latestSnapshot: Snapshot | null;
  /** Difference between the two most recent snapshots, when both exist. */
  latestDiff: SnapshotDiff | null;
  snapshotSkippedLines: number;
  source: SourceStatusDTO;
  /** Config warnings plus ledger journal warnings. */
  warnings: SourceWarning[];
  /** Existing apply-journal comparison. Null when the ledger cannot be read. */
  results: ResultsDTO | null;
}

export interface HealthDTO {
  checkedAt: string;
  source: SourceStatusDTO;
  config: {
    dbPath: string;
    dbOrigin: SourceStatusDTO["origin"];
    stateDir: string;
    settingsPath: string;
    /** The configured reporting window, when settings define one. */
    reportingDays: number | null;
    timeZone: string | null;
    warnings: SourceWarning[];
  };
  pricing: { asOf: string; version: number };
  /** The report's data health for the current read; null when unreadable. */
  data: DataHealth | null;
  ledger: {
    snapshots: number;
    latestSnapshotAt: string | null;
    snapshotSkippedLines: number;
    appliedChanges: number;
    resultsSkippedLines: number;
  };
  privacy: {
    network: "none";
    bannedKeys: string[];
    neverReads: string[];
  };
}

export interface PrivacyDTO {
  checkedAt: string;
  network: "none";
  reads: string[];
  neverReads: string[];
  stores: string[];
  bannedKeys: string[];
  retention: string;
  ledger: {
    stateDir: string;
    eventsJournal: boolean;
    snapshotsJournal: boolean;
    /** The existing strict validator's result for the files above. */
    audit: "pass" | "fail" | "empty";
    auditMessage: string | null;
  };
}
