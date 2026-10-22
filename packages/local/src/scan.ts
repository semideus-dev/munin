import { statSync } from "node:fs";
import type {
  MuninReport,
  ScanCursor,
  SessionSlice,
  Snapshot,
  SnapshotDiff,
  SourceWarning,
  UsageEvent,
  AppliedChange,
  ResultsReport,
} from "@munin/core";
import {
  advanceCursor,
  appliedChangesFromJournal,
  assertNoBannedKeys,
  buildEvents,
  buildLedgerReport,
  diffSnapshots,
  measureResults,
  resultsDays,
} from "@munin/core";
import { acquireScanLock } from "./lock.js";
import { openLedgerStore } from "./ledger.js";
import { loadConfig, inspectSourceDatabase } from "./config.js";
import { readScanCursor, writeScanCursor } from "./cursors.js";
import { readDataset } from "./readers/index.js";
import { openChangesStore } from "./changes.js";

export interface ScanOptions {
  db?: string;
  stateDir?: string;
  zone?: string;
  full?: boolean;
  repair?: boolean;
  checkPrivacy?: boolean;
  now?: () => Date;
}

export interface SessionDrift {
  sessionId: string;
  storedEvents: number;
  freshEvents: number;
  kind: "missing-from-source" | "events-changed";
}

export interface ScanResult {
  mode: "full" | "incremental";
  sessionsRead: number;
  slicesReplaced: number;
  newSessionIds: string[];
  replacedSessionIds: string[];
  totals: MuninReport["totals"];
  findings: MuninReport["findings"];
  report: MuninReport;
  snapshot: Snapshot;
  snapshotDiff: SnapshotDiff | null;
  cursor: ScanCursor;
  warnings: SourceWarning[];
  reconciliation: SessionDrift[];
  repaired: boolean;
}

const FATAL_SOURCE_WARNINGS = new Set([
  "source.missing-db",
  "source.unreadable",
  "source.busy",
  "source.no-schema",
]);

/** Perform one locked scan. Source history is only ever opened read-only. */
export function runScan(options: ScanOptions = {}): ScanResult {
  if (options.repair && !options.full) throw new Error("--repair requires --full");
  const config = loadConfig({ db: options.db, stateDir: options.stateDir });
  const lock = acquireScanLock(config.paths.ledger.scanLock, options.full ? "full scan" : "scan");
  try {
    const now = options.now ?? (() => new Date());
    const store = openLedgerStore(config.paths.ledger);
    const cursorLoad = readScanCursor(config.paths.ledger.cursors);
    const previousCursor = cursorLoad.cursor;
    const previousSlices = store.readSlices();
    const previousSnapshots = store.readSnapshots();

    const rawTimeUpdates: Record<"v1" | "v2", number[]> = { v1: [], v2: [] };
    const dataset = readDataset({
      db: config.dbPath,
      stateDir: config.paths.stateDir,
      onSessionsRead(schema, timeUpdatedMs) {
        if (schema === "v1" || schema === "v2") rawTimeUpdates[schema].push(...timeUpdatedMs);
      },
      ...(previousCursor === null || options.full === true
        ? {}
        : {
            watermarks: { v1: previousCursor.v1, v2: previousCursor.v2 },
            previousSchema: previousCursor.sourceSchema,
          }),
    });
    const fatalWarning = dataset.warnings.find((warning) =>
      FATAL_SOURCE_WARNINGS.has(warning.code),
    );
    if (fatalWarning !== undefined)
      throw new Error(`[${fatalWarning.code}] ${fatalWarning.message}`);
    if (dataset.schema === "none")
      throw new Error("[source.no-schema] No readable OpenCode schema was found");

    const at = now().toISOString();
    const atMs = Date.parse(at);
    const fresh = buildEvents(dataset);
    const freshEventsBySession = groupEvents(fresh.events);
    const freshSlices = dataset.sessions.map((session): SessionSlice => {
      const watermarkMs = Date.parse(session.timeUpdated);
      if (!Number.isFinite(watermarkMs) || watermarkMs > atMs) {
        throw new Error(`Invalid or future session watermark for ${session.id}`);
      }
      return {
        schema: "munin.slice/1",
        sessionId: session.id,
        at,
        watermarkMs,
        events: freshEventsBySession.get(session.id) ?? [],
      };
    });

    const schemaChanged = dataset.warnings.some(
      (warning) => warning.code === "source.schema-changed",
    );
    const full = options.full === true || previousCursor === null || schemaChanged;
    const storedBySession = new Map(previousSlices.slices.map((slice) => [slice.sessionId, slice]));
    const freshBySession = new Map(freshSlices.map((slice) => [slice.sessionId, slice]));
    const reconciliation = full ? reconcileSlices(storedBySession, freshBySession) : [];
    const repaired =
      options.repair === true && (reconciliation.length > 0 || previousSlices.skippedLines > 0);

    const freshRows = {
      v1: { sessions: rawTimeUpdates.v1.map((time_updated) => ({ time_updated })) },
      v2: { sessions: rawTimeUpdates.v2.map((time_updated) => ({ time_updated })) },
    };
    const nextCursor = advanceCursor(full ? null : previousCursor, freshRows, dataset.schema, at);

    if (repaired) {
      store.rewriteSlices(freshSlices);
    } else {
      for (const slice of freshSlices) store.appendSlice(slice);
    }

    const merged = store.readSlices();
    const mergedEvents = merged.slices.flatMap((slice) => slice.events);
    const warnings: SourceWarning[] = [
      ...config.warnings,
      ...fresh.warnings.filter(
        (warning) => warning.code !== "analysis.no-events" || mergedEvents.length === 0,
      ),
      ...(cursorLoad.warning === undefined
        ? []
        : [{ code: "state.cursor-unreadable", message: cursorLoad.warning, count: 1 }]),
      ...(lock.warning === undefined
        ? []
        : [{ code: "state.lock-recovered", message: lock.warning, count: 1 }]),
      ...(previousSlices.skippedLines === 0
        ? []
        : [
            {
              code: "ledger.slice-lines-skipped",
              message: "Malformed slice journal lines were skipped",
              count: previousSlices.skippedLines,
            },
          ]),
      ...(previousSnapshots.skippedLines === 0
        ? []
        : [
            {
              code: "ledger.snapshot-lines-skipped",
              message: "Malformed snapshot journal lines were skipped",
              count: previousSnapshots.skippedLines,
            },
          ]),
      ...(reconciliation.length === 0
        ? []
        : [
            {
              code: "ledger.reconciliation-drift",
              message: `${reconciliation.length} session slice(s) differ from the full source read`,
              count: reconciliation.length,
            },
          ]),
    ];
    const report = buildLedgerReport(mergedEvents, {
      zone: options.zone ?? config.settings.tz,
      sourcePath: config.dbPath,
      sourceSchema: dataset.schema,
      sessionsTracked: merged.sessions,
      warnings,
      ledger: {
        skippedLines: merged.skippedLines + previousSnapshots.skippedLines,
        slicesReplaced: freshSlices.length,
        eventsTracked: mergedEvents.length,
      },
    });

    const snapshot = makeSnapshot({
      id: (previousSnapshots.snapshots.at(-1)?.id ?? 0) + 1,
      at,
      path: config.dbPath,
      origin: config.dbOrigin,
      mode: full ? "full" : "incremental",
      sessionsRead: dataset.sessions.length,
      slicesReplaced: freshSlices.length,
      sessionsTracked: merged.sessions,
      eventsTracked: mergedEvents.length,
      report,
    });
    const previousSnapshot = previousSnapshots.snapshots.at(-1);
    const snapshotDiff =
      previousSnapshot === undefined ? null : diffSnapshots(previousSnapshot, snapshot);
    if (options.checkPrivacy) {
      assertNoBannedKeys(nextCursor);
      assertNoBannedKeys(snapshot);
      store.auditPrivacy(atMs);
    }
    store.appendSnapshot(snapshot, atMs);
    if (options.checkPrivacy) {
      store.auditPrivacy(atMs);
    }
    // Cursor commit is intentionally last. A crash before here repeats the
    // read; the journal's last-slice-wins rule collapses that retry.
    writeScanCursor(config.paths.ledger.cursors, nextCursor, atMs);

    const previousIds = new Set(previousSlices.slices.map((slice) => slice.sessionId));
    return {
      mode: full ? "full" : "incremental",
      sessionsRead: dataset.sessions.length,
      slicesReplaced: freshSlices.length,
      newSessionIds: freshSlices
        .filter((slice) => !previousIds.has(slice.sessionId))
        .map((slice) => slice.sessionId),
      replacedSessionIds: freshSlices
        .filter((slice) => previousIds.has(slice.sessionId))
        .map((slice) => slice.sessionId),
      totals: report.totals,
      findings: report.findings,
      report,
      snapshot,
      snapshotDiff,
      cursor: nextCursor,
      warnings,
      reconciliation,
      repaired,
    };
  } finally {
    lock.release();
  }
}

export interface ScanSnapshotsState {
  snapshots: Snapshot[];
  diff: SnapshotDiff | null;
  skippedLines: number;
}

/** Read saved snapshots and their latest trend without touching OpenCode history. */
export function readScanSnapshots(
  options: Pick<ScanOptions, "db" | "stateDir"> = {},
): ScanSnapshotsState {
  const config = loadConfig(options);
  const read = openLedgerStore(config.paths.ledger).readSnapshots();
  const snapshots = read.snapshots;
  const diff = snapshots.length < 2 ? null : diffSnapshots(snapshots.at(-2)!, snapshots.at(-1)!);
  return { snapshots, diff, skippedLines: read.skippedLines };
}

export interface ScanResultsState {
  changes: AppliedChange[];
  daysRequired: number;
  report: ResultsReport;
  skippedLines: number;
}

/** Compare already-priced ledger events with periods in Munin's apply journal. */
export function readScanResults(
  options: Pick<ScanOptions, "db" | "stateDir"> & { now?: number } = {},
): ScanResultsState {
  const config = loadConfig(options);
  const slices = openLedgerStore(config.paths.ledger).readSlices();
  const entries = openChangesStore(config.paths.ledger.changes).load();
  const changes = appliedChangesFromJournal(entries);
  const now = options.now ?? Date.now();
  const events = slices.slices.flatMap((slice) => slice.events);
  return {
    changes,
    daysRequired: resultsDays(changes, now),
    report: measureResults({ events }, changes, { now }),
    skippedLines: slices.skippedLines,
  };
}

export type WatchPollResult =
  | { kind: "unchanged" | "busy" }
  | { kind: "warning"; message: string; warningCount: number }
  | {
      kind: "scan";
      result: ScanResult;
      fullRescan: boolean;
      changes?: {
        totalsDelta: { calls: number; avgTokensPerSession: number; headlineUsd: number };
      };
    };

/** Average ledger tokens per session, used for watch-cycle deltas. */
function averageTokensPerSession(report: MuninReport | null): number {
  if (report === null || report.totals.sessions === 0) return 0;
  return report.totals.totalTokens / report.totals.sessions;
}

/** Poll one database fingerprint per tick; a new watcher resumes from disk cursors. */
export function createScanWatcher(options: ScanOptions = {}) {
  const config = loadConfig({ db: options.db, stateDir: options.stateDir });
  let previousFingerprint: FileFingerprint | null = null;
  let previousReport: MuninReport | null = null;
  let firstTick = true;
  let warningCount = 0;
  let inFlight = false;

  return {
    poll(): WatchPollResult {
      if (inFlight) return { kind: "busy" };
      inFlight = true;
      try {
        const status = inspectSourceDatabase(config.dbPath);
        if (status.kind !== "ready") {
          warningCount += 1;
          const message =
            status.kind === "missing"
              ? `[source.missing-db] Database not found: ${status.path}`
              : `[source.unreadable] Could not stat ${status.path}: ${status.reason}`;
          return { kind: "warning", message, warningCount };
        }
        let current: FileFingerprint;
        try {
          current = fingerprint(config.dbPath);
        } catch (error) {
          warningCount += 1;
          return {
            kind: "warning",
            message: error instanceof Error ? error.message : String(error),
            warningCount,
          };
        }
        if (previousFingerprint !== null && sameFingerprint(previousFingerprint, current)) {
          return { kind: "unchanged" };
        }
        const replaced =
          previousFingerprint !== null &&
          (current.dev !== previousFingerprint.dev || current.ino !== previousFingerprint.ino);
        const shrunk = previousFingerprint !== null && current.size < previousFingerprint.size;
        const timeWentBack =
          previousFingerprint !== null && current.mtimeMs < previousFingerprint.mtimeMs;
        const fullRescan = replaced || shrunk || timeWentBack;
        try {
          const result = runScan({
            ...options,
            full: fullRescan || (firstTick && options.full === true),
            repair: firstTick ? options.repair : false,
          });
          // Save the pre-scan fingerprint. A source write during the scan then
          // changes the next tick's fingerprint and cannot be accidentally lost.
          previousFingerprint = current;
          firstTick = false;
          const previous = previousReport;
          const totalsDelta = {
            calls: result.totals.calls - (previous?.totals.calls ?? 0),
            avgTokensPerSession:
              averageTokensPerSession(result.report) - averageTokensPerSession(previous),
            headlineUsd: result.totals.headlineUsd - (previous?.totals.headlineUsd ?? 0),
          };
          previousReport = result.report;
          return {
            kind: "scan",
            result,
            fullRescan,
            ...(previous === null ? {} : { changes: { totalsDelta } }),
          };
        } catch (error) {
          warningCount += 1;
          return {
            kind: "warning",
            message: error instanceof Error ? error.message : String(error),
            warningCount,
          };
        }
      } finally {
        inFlight = false;
      }
    },
  };
}

interface FileFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function fingerprint(path: string): FileFingerprint {
  const stat = statSync(path);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function groupEvents(events: readonly UsageEvent[]): Map<string, UsageEvent[]> {
  const grouped = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const row = grouped.get(event.sessionId);
    if (row === undefined) grouped.set(event.sessionId, [event]);
    else row.push(event);
  }
  return grouped;
}

function reconcileSlices(
  stored: ReadonlyMap<string, SessionSlice>,
  fresh: ReadonlyMap<string, SessionSlice>,
): SessionDrift[] {
  const drift: SessionDrift[] = [];
  for (const [sessionId, previous] of stored) {
    const current = fresh.get(sessionId);
    if (current === undefined) {
      drift.push({
        sessionId,
        storedEvents: previous.events.length,
        freshEvents: 0,
        kind: "missing-from-source",
      });
    } else if (JSON.stringify(previous.events) !== JSON.stringify(current.events)) {
      drift.push({
        sessionId,
        storedEvents: previous.events.length,
        freshEvents: current.events.length,
        kind: "events-changed",
      });
    }
  }
  return drift;
}

function makeSnapshot(input: {
  id: number;
  at: string;
  path: string;
  origin: "flag" | "env" | "settings" | "default";
  mode: "full" | "incremental";
  sessionsRead: number;
  slicesReplaced: number;
  sessionsTracked: number;
  eventsTracked: number;
  report: MuninReport;
}): Snapshot {
  const findingCounts = new Map<string, { count: number; claimedWindowUsd: number }>();
  for (const finding of input.report.findings) {
    const row = findingCounts.get(finding.rule) ?? { count: 0, claimedWindowUsd: 0 };
    row.count += 1;
    row.claimedWindowUsd += finding.savings.windowUsd;
    findingCounts.set(finding.rule, row);
  }
  const warningCounts: Record<string, number> = {};
  for (const warning of input.report.dataHealth.warnings) {
    warningCounts[warning.code] = (warningCounts[warning.code] ?? 0) + (warning.count ?? 1);
  }
  const totals = input.report.totals;
  return {
    schema: "munin.snapshot/1",
    id: input.id,
    at: input.at,
    source: { path: input.path, origin: input.origin, schema: input.report.dataHealth.schema },
    scope: {
      mode: input.mode,
      sessionsRead: input.sessionsRead,
      slicesReplaced: input.slicesReplaced,
    },
    state: { sessionsTracked: input.sessionsTracked, eventsTracked: input.eventsTracked },
    window: input.report.window,
    totals: {
      calls: totals.calls,
      sessions: totals.sessions,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      thinkingTokens: totals.thinkingTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalTokens: totals.totalTokens,
      headlineUsd: totals.headlineUsd,
      observedUsd: totals.observedUsd,
      estimatedUsd: totals.estimatedUsd,
    },
    byModel: input.report.byModel.map((row) => ({
      provider: row.providers[0] ?? "unknown",
      model: row.models[0] ?? row.key,
      calls: row.calls,
      totalTokens: row.totalTokens,
      headlineUsd: row.headlineUsd,
      observedUsd: row.observedUsd,
      estimatedUsd: row.estimatedUsd,
    })),
    findings: [...findingCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, row]) => ({ rule, ...row })),
    dataClean: input.report.dataHealth.clean,
    warningCounts,
  };
}
