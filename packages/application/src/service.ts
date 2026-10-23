/**
 * The application service: one typed, host-neutral facade over the existing
 * engines, usable from the Electron main process and testable without it.
 *
 * Rules this file keeps:
 * - Reads never write Munin state and never rescan. Navigation is free.
 * - The only scan entry points are an explicit `runScan` and the opt-in
 *   watcher started by `startMonitoring`; both reuse `@munin/local`'s engine.
 * - One watcher instance, created and owned here, restarted idempotently.
 * - DTOs are plain JSON. Errors cross the boundary as `ServiceErrorDTO`; stacks
 *   and causes stay in the host process.
 */
import { existsSync, statSync } from "node:fs";
import {
  BANNED_KEYS,
  MuninError,
  PRICING_AS_OF,
  PRICING_VERSION,
  WARNING_CODES,
  type DataHealth,
  type MuninReport,
  type SessionSummary,
  type Snapshot,
  type SourceSchema,
  type SourceWarning,
} from "@munin/core";
import {
  createScanWatcher,
  inspectSourceDatabase,
  loadConfig,
  openLedgerStore,
  readScanResults,
  readScanSnapshots,
  runScan as runLocalScan,
  type ResolvedConfig,
  type ScanOptions,
  type ScanResult,
  type WatchPollResult,
} from "@munin/local";
import {
  loadReadContext,
  normalizeReadOptions,
  type ReadContext,
  type ReadOptions,
} from "./context.js";
import { toScanError, toServiceError, type ServiceErrorDTO } from "./errors.js";
import { sourceStatusDTO, type SourceStatusDTO } from "./dto/common.js";
import {
  findingDetailDTO,
  findingListDTO,
  type FindingDetailDTO,
  type FindingListDTO,
} from "./dto/findings.js";
import { overviewDTO, type OverviewDTO } from "./dto/overview.js";
import {
  sessionDetailDTO,
  usageOverviewDTO,
  type SessionDetailDTO,
  type UsageOverviewDTO,
} from "./dto/usage.js";
import type {
  ActivityDTO,
  HealthDTO,
  MonitoringStateDTO,
  PrivacyDTO,
  ScanDTO,
} from "./dto/runtime.js";

/** An explicit scan is exactly the existing `ScanOptions` contract. */
export type ExplicitScanOptions = ScanOptions;

export interface MonitoringOptions extends ReadOptions {
  /** Poll interval in milliseconds; minimum 500, default 2000 (the CLI default). */
  intervalMs?: number;
  /** Make the first poll a full re-read. */
  full?: boolean;
}

/** Events the host forwards to its UI. Nothing here focuses a window. */
export type ServiceEvent =
  | { kind: "monitoring-scan"; at: string; scan: ScanDTO }
  | { kind: "monitoring-warning"; at: string; message: string };

export interface ServiceOptions {
  /** Injectable clock; every DTO timestamp comes from here. */
  now?: () => Date;
  /** Called for background watcher activity. Must not throw; failures are ignored. */
  onEvent?: (event: ServiceEvent) => void;
}

/**
 * The target contract from the desktop plan. Reads are async for IPC, but the
 * engine work is synchronous and never interleaves with itself.
 */
export interface MuninService {
  getSourceStatus(options?: ReadOptions): Promise<SourceStatusDTO>;
  getOverview(options?: ReadOptions): Promise<OverviewDTO>;
  getFullReport(options?: ReadOptions): Promise<MuninReport>;
  getFindings(options?: ReadOptions): Promise<FindingListDTO>;
  getFinding(rule: string, options?: ReadOptions): Promise<FindingDetailDTO | null>;
  getUsage(options?: ReadOptions): Promise<UsageOverviewDTO>;
  getSessions(options?: ReadOptions): Promise<SessionSummary[]>;
  getSessionDetail(sessionId: string, options?: ReadOptions): Promise<SessionDetailDTO | null>;
  getActivity(options?: ReadOptions): Promise<ActivityDTO>;
  getHealth(options?: ReadOptions): Promise<HealthDTO>;
  runScan(options?: ExplicitScanOptions): Promise<ScanDTO>;
  startMonitoring(options?: MonitoringOptions): Promise<MonitoringStateDTO>;
  stopMonitoring(): Promise<MonitoringStateDTO>;
  getPrivacyStatus(options?: ReadOptions): Promise<PrivacyDTO>;
}

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;

const NEVER_READS = ["prompt text", "completions", "tool output", "file contents"] as const;

function configOptions(options: ReadOptions): { db?: string; stateDir?: string } {
  return {
    ...(options.db === undefined ? {} : { db: options.db }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  };
}

function fingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "unknown";
    return `missing:${code}`;
  }
}

function scanOptionsOf(options: MonitoringOptions): ScanOptions {
  const normalized = normalizeReadOptions(options);
  return {
    ...(normalized.db === undefined ? {} : { db: normalized.db }),
    ...(normalized.stateDir === undefined ? {} : { stateDir: normalized.stateDir }),
    ...(normalized.days === undefined ? {} : { sinceDays: normalized.days }),
    ...(normalized.project === undefined ? {} : { project: normalized.project }),
    ...(normalized.tz === undefined ? {} : { zone: normalized.tz }),
    ...(options.full === true ? { full: true } : {}),
  };
}

function intervalOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INTERVAL_MS;
  if (!Number.isInteger(value)) {
    throw new MuninError({
      code: "request.invalid",
      kind: "usage",
      message: `intervalMs must be a whole number of milliseconds: ${value}`,
    });
  }
  return Math.max(MIN_INTERVAL_MS, value);
}

function emptyMonitoring(intervalMs: number): MonitoringStateDTO {
  return {
    enabled: false,
    intervalMs,
    startedAt: null,
    lastPollAt: null,
    lastTick: null,
    scanCount: 0,
    warningCount: 0,
    lastWarning: null,
    lastScan: null,
  };
}

function scanDTO(result: ScanResult, at: string, durationMs: number | null): ScanDTO {
  const report = result.report;
  const warnings = report.dataHealth.warnings;
  return {
    at,
    mode: result.mode,
    status: warnings.length === 0 ? "success" : "warning",
    durationMs,
    sessionsRead: result.sessionsRead,
    slicesReplaced: result.slicesReplaced,
    newSessionIds: [...result.newSessionIds],
    replacedSessionIds: [...result.replacedSessionIds],
    repaired: result.repaired,
    totals: {
      calls: report.totals.calls,
      sessions: report.totals.sessions,
      turns: report.totals.turns,
      subagentSessions: report.totals.subagentSessions,
      headlineUsd: report.totals.headlineUsd,
      observedUsd: report.totals.observedUsd,
      estimatedUsd: report.totals.estimatedUsd,
      totalTokens: report.totals.totalTokens,
    },
    warnings,
    reconciliation: result.reconciliation,
    snapshotId: result.snapshot.id,
    snapshotDiff: result.snapshotDiff,
  };
}

export function createMuninService(options: ServiceOptions = {}): MuninService {
  const clock = options.now ?? (() => new Date());
  const iso = (): string => clock().toISOString();

  /** Read contexts are memoised until the source file or options change. */
  let cache: { key: string; context: ReadContext } | null = null;
  let scanning = false;
  let lastScan: ScanDTO | null = null;
  let lastError: (ServiceErrorDTO & { at: string }) | null = null;
  let lastWarning: { message: string; at: string } | null = null;
  let watcher: ReturnType<typeof createScanWatcher> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let monitoring: MonitoringStateDTO = emptyMonitoring(DEFAULT_INTERVAL_MS);

  function emit(event: ServiceEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken host callback must not stop the watcher.
    }
  }

  function contextFor(readOptions: ReadOptions): ReadContext {
    const normalized = normalizeReadOptions(readOptions);
    const config = loadConfig(configOptions(normalized));
    const key = `${JSON.stringify(normalized)}|${fingerprint(config.dbPath)}`;
    if (cache !== null && cache.key === key) return cache.context;
    const context = loadReadContext(normalized);
    cache = { key, context };
    return context;
  }

  function sourceOf(config: ResolvedConfig, schema: SourceSchema | null): SourceStatusDTO {
    return sourceStatusDTO(inspectSourceDatabase(config.dbPath), config.dbOrigin, schema);
  }

  /** Ledger snapshots are display data; a broken journal must not hide the report. */
  function ledgerSummary(readOptions: ReadOptions): {
    snapshots: Snapshot[];
    latestAt: string | null;
  } {
    try {
      const state = readScanSnapshots(configOptions(readOptions));
      return { snapshots: state.snapshots, latestAt: state.snapshots.at(-1)?.at ?? null };
    } catch {
      return { snapshots: [], latestAt: null };
    }
  }

  function activityState(snapshots: readonly Snapshot[]): ActivityDTO["status"] {
    if (scanning) return "scanning";
    if (lastError !== null) return "error";
    const scanAt = lastScan === null ? Number.NEGATIVE_INFINITY : Date.parse(lastScan.at);
    const warningAt = lastWarning === null ? Number.NEGATIVE_INFINITY : Date.parse(lastWarning.at);
    if (warningAt > scanAt) return "warning";
    if (lastScan !== null) return lastScan.status;
    const latest = snapshots.at(-1);
    if (latest === undefined) return "idle";
    return latest.dataClean ? "success" : "warning";
  }

  function monitoringState(): MonitoringStateDTO {
    return { ...monitoring };
  }

  function pollOnce(): void {
    const active = watcher;
    if (active === null) return;
    const at = iso();
    monitoring.lastPollAt = at;

    let poll: WatchPollResult | null = null;
    try {
      poll = active.poll();
    } catch (error) {
      const message = toServiceError(error).message;
      monitoring.lastTick = "warning";
      monitoring.warningCount += 1;
      lastWarning = { message, at };
      monitoring.lastWarning = lastWarning;
      emit({ kind: "monitoring-warning", at, message });
      return;
    }
    if (poll === null) return;

    monitoring.lastTick = poll.kind;
    if (poll.kind === "scan") {
      const scan = scanDTO(poll.result, iso(), null);
      lastScan = scan;
      lastError = null;
      monitoring.lastScan = scan;
      monitoring.scanCount += 1;
      lastWarning = null;
      monitoring.lastWarning = null;
      emit({ kind: "monitoring-scan", at: scan.at, scan });
      return;
    }
    if (poll.kind === "warning") {
      monitoring.warningCount += 1;
      lastWarning = { message: poll.message, at };
      monitoring.lastWarning = lastWarning;
      emit({ kind: "monitoring-warning", at, message: poll.message });
    }
  }

  return {
    async getSourceStatus(readOptions = {}) {
      const config = loadConfig(configOptions(readOptions));
      return sourceOf(config, null);
    },

    async getOverview(readOptions = {}) {
      const context = contextFor(readOptions);
      const ledger = ledgerSummary(readOptions);
      return overviewDTO(
        context.report,
        sourceOf(context.config, context.report.dataHealth.schema),
        iso(),
        {
          status: activityState(ledger.snapshots),
          lastScanAt: lastScan?.at ?? ledger.latestAt,
        },
      );
    },

    async getFullReport(readOptions = {}) {
      return contextFor(readOptions).report;
    },

    async getFindings(readOptions = {}) {
      return findingListDTO(contextFor(readOptions).report);
    },

    async getFinding(rule, readOptions = {}) {
      if (rule.trim() === "") {
        throw new MuninError({
          code: "request.invalid",
          kind: "usage",
          message: "A rule id is required.",
        });
      }
      const context = contextFor(readOptions);
      return findingDetailDTO(context.report, context.priced, rule);
    },

    async getUsage(readOptions = {}) {
      return usageOverviewDTO(contextFor(readOptions).report);
    },

    async getSessions(readOptions = {}) {
      return contextFor(readOptions).report.sessions;
    },

    async getSessionDetail(sessionId, readOptions = {}) {
      if (sessionId.trim() === "") {
        throw new MuninError({
          code: "request.invalid",
          kind: "usage",
          message: "A session id is required.",
        });
      }
      const context = contextFor(readOptions);
      return sessionDetailDTO(context.report, context.priced, sessionId);
    },

    async getActivity(readOptions = {}) {
      const config = loadConfig(configOptions(readOptions));
      let snapshots: Snapshot[] = [];
      let diff: ActivityDTO["latestDiff"] = null;
      let skippedLines = 0;
      let results: ActivityDTO["results"] = null;
      try {
        const snapshotState = readScanSnapshots(configOptions(readOptions));
        snapshots = snapshotState.snapshots;
        diff = snapshotState.diff;
        skippedLines = snapshotState.skippedLines;
        results = readScanResults({
          ...configOptions(readOptions),
          now: clock().getTime(),
        });
      } catch {
        // A ledger that cannot be read is an empty history here; getHealth and
        // getPrivacyStatus report the same state in detail.
      }
      const latest = snapshots.at(-1) ?? null;
      const warnings: SourceWarning[] = [
        ...config.warnings,
        ...(skippedLines === 0
          ? []
          : [
              {
                code: WARNING_CODES.ledgerSnapshotLinesSkipped,
                message: "Malformed snapshot journal lines were skipped",
                count: skippedLines,
              },
            ]),
        ...(results === null || results.skippedLines === 0
          ? []
          : [
              {
                code: WARNING_CODES.ledgerSliceLinesSkipped,
                message: "Malformed slice journal lines were skipped",
                count: results.skippedLines,
              },
            ]),
      ];
      return {
        status: activityState(snapshots),
        lastScan,
        lastError,
        monitoring: monitoringState(),
        snapshots,
        latestSnapshot: latest,
        latestDiff: diff,
        snapshotSkippedLines: skippedLines,
        source: sourceOf(config, latest?.source.schema ?? null),
        warnings,
        results,
      };
    },

    async getHealth(readOptions = {}) {
      const config = loadConfig(configOptions(readOptions));
      let data: DataHealth | null = null;
      let schema: SourceSchema | null = null;
      try {
        const context = contextFor(readOptions);
        data = context.report.dataHealth;
        schema = data.schema;
      } catch (error) {
        if (!(error instanceof MuninError && error.code === WARNING_CODES.sourceMissingDb)) {
          throw error;
        }
      }

      let snapshots = 0;
      let latestSnapshotAt: string | null = null;
      let snapshotSkippedLines = 0;
      let appliedChanges = 0;
      let resultsSkippedLines = 0;
      try {
        const snapshotState = readScanSnapshots(configOptions(readOptions));
        snapshots = snapshotState.snapshots.length;
        latestSnapshotAt = snapshotState.snapshots.at(-1)?.at ?? null;
        snapshotSkippedLines = snapshotState.skippedLines;
        const resultsState = readScanResults({
          ...configOptions(readOptions),
          now: clock().getTime(),
        });
        appliedChanges = resultsState.changes.length;
        resultsSkippedLines = resultsState.skippedLines;
      } catch {
        // Empty ledger state; the source and config sections still render.
      }

      return {
        checkedAt: iso(),
        source: sourceOf(config, schema),
        config: {
          dbPath: config.dbPath,
          dbOrigin: config.dbOrigin,
          stateDir: config.paths.stateDir,
          settingsPath: config.paths.settingsPath,
          reportingDays: config.settings.days ?? null,
          timeZone: config.settings.tz ?? null,
          warnings: config.warnings,
        },
        pricing: { asOf: PRICING_AS_OF, version: PRICING_VERSION },
        data,
        ledger: {
          snapshots,
          latestSnapshotAt,
          snapshotSkippedLines,
          appliedChanges,
          resultsSkippedLines,
        },
        privacy: {
          network: "none",
          bannedKeys: [...BANNED_KEYS].sort(),
          neverReads: [...NEVER_READS],
        },
      };
    },

    async runScan(scanOptions = {}) {
      if (scanning) {
        throw new MuninError({
          code: "state.lock-held",
          kind: "ledger",
          message: "A Munin scan is already running.",
        });
      }
      scanning = true;
      const started = clock().getTime();
      try {
        let result: ScanResult;
        try {
          result = runLocalScan(scanOptions);
        } catch (error) {
          throw toScanError(error);
        }
        const scan = scanDTO(result, iso(), Math.max(0, clock().getTime() - started));
        lastScan = scan;
        lastError = null;
        return scan;
      } catch (error) {
        lastError = { ...toServiceError(error), at: iso() };
        throw error;
      } finally {
        scanning = false;
      }
    },

    async startMonitoring(monitoringOptions = {}) {
      const intervalMs = intervalOf(monitoringOptions.intervalMs);
      if (timer !== null) return monitoringState();
      watcher = createScanWatcher(scanOptionsOf(monitoringOptions));
      monitoring = { ...emptyMonitoring(intervalMs), enabled: true, startedAt: iso() };
      timer = setInterval(pollOnce, intervalMs);
      timer.unref();
      return monitoringState();
    },

    async stopMonitoring() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      watcher = null;
      monitoring = { ...monitoring, enabled: false };
      return monitoringState();
    },

    async getPrivacyStatus(readOptions = {}) {
      const config = loadConfig(configOptions(readOptions));
      const paths = config.paths.ledger;
      const eventsJournal = existsSync(paths.events);
      const snapshotsJournal = existsSync(paths.snapshots);
      let audit: "pass" | "fail" | "empty" = "empty";
      let auditMessage: string | null = null;
      if (eventsJournal || snapshotsJournal) {
        try {
          openLedgerStore({
            events: paths.events,
            snapshots: paths.snapshots,
          }).auditPrivacy(clock().getTime());
          audit = "pass";
        } catch (error) {
          audit = "fail";
          auditMessage = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        checkedAt: iso(),
        network: "none",
        reads: [
          "OpenCode database (read-only): sessions, messages, tool metadata, instruction-prefix shape",
        ],
        neverReads: [...NEVER_READS],
        stores: [
          `${config.paths.stateDir} - Munin's derived ledger, snapshots, cursors and settings`,
          `${config.paths.settingsPath} - days and time zone, written only by apply/undo`,
        ],
        bannedKeys: [...BANNED_KEYS].sort(),
        retention: `Until you delete ${config.paths.stateDir}`,
        ledger: {
          stateDir: config.paths.stateDir,
          eventsJournal,
          snapshotsJournal,
          audit,
          auditMessage,
        },
      };
    },
  };
}
