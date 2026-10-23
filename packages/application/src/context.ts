/**
 * The shared read path.
 *
 * This is the orchestration the CLI's `data.ts` used to own, extracted so the
 * CLI and the desktop service resolve configuration, read the dataset, filter
 * it, price it once, and build the one shared report in exactly the same way.
 * No analysis lives here: every number comes from `@munin/core`.
 *
 * Reads are side-effect free. They open the source database read-only through
 * `@munin/local` and never write config, cursors, ledger, snapshots or the
 * change journal.
 */
import {
  buildEvents,
  buildReport,
  MuninError,
  WARNING_CODES,
  type Dataset,
  type DayZone,
  type MuninReport,
  type PricedDataset,
  type RecommendationDecision,
  type SourceWarning,
} from "@munin/core";
import { loadConfig, readDataset, type ResolvedConfig } from "@munin/local";

/**
 * Read options shared by every read use case.
 *
 * Defaults mirror the CLI report path exactly: no `days` filter unless asked,
 * `project` matched as a case-insensitive substring, and `UTC` day buckets
 * unless a zone is supplied. `db` and `stateDir` follow the same precedence as
 * every other entry point (flag > MUNIN_DB > settings > platform default).
 */
export interface ReadOptions {
  db?: string;
  stateDir?: string;
  /** Only source sessions updated in the last N days; no implicit default. */
  days?: number;
  /** Case-insensitive substring over project label, id, or directory. */
  project?: string;
  /** Day-bucket zone. `UTC` when omitted, matching the CLI read path. */
  tz?: DayZone;
}

/** Everything one read produced, before any presentation mapping. */
export interface ReadContext {
  config: ResolvedConfig;
  dataset: Dataset;
  priced: PricedDataset;
  report: MuninReport;
  warnings: SourceWarning[];
  tz: DayZone;
}

export interface ReadExtras {
  /**
   * Previously recorded recommendation choices. The host supplies them; core
   * stays pure. Omitted by the CLI, which keeps its JSON output unchanged.
   */
  decisions?: Readonly<Record<string, RecommendationDecision>>;
}

function invalid(field: string, value: string): MuninError {
  return new MuninError({
    code: "request.invalid",
    kind: "usage",
    message: `${field} has an invalid value: ${value}`,
  });
}

/**
 * Validate and canonicalise read options. The GUI receives values from its own
 * controls, so this repeats the CLI's flag checks at the shared boundary.
 */
export function normalizeReadOptions(options: ReadOptions = {}): ReadOptions {
  if (options.days !== undefined) {
    if (!Number.isInteger(options.days) || options.days <= 0) {
      throw invalid("days", String(options.days));
    }
  }
  if (options.project !== undefined && options.project.trim() === "") {
    throw invalid("project", options.project);
  }
  if (options.tz !== undefined && options.tz.trim() === "") {
    throw invalid("tz", options.tz);
  }
  return { ...options };
}

/** Match a project by label, id, or directory, case-insensitively. */
function filterByProject(dataset: Dataset, project: string): Dataset {
  const needle = project.toLowerCase();
  const matches = (value: string | undefined): boolean =>
    value === undefined ? false : value.toLowerCase().includes(needle);
  const sessions = dataset.sessions.filter(
    (session) =>
      matches(session.project) || matches(session.projectId) || matches(session.directory),
  );
  const ids = new Set(sessions.map((session) => session.id));
  return {
    ...dataset,
    sessions,
    messages: dataset.messages.filter((message) => ids.has(message.sessionId)),
  };
}

/**
 * Read, filter, price and report. Throws `source.missing-db` when the source
 * database does not exist, exactly like the CLI read commands; an unreadable
 * or unsupported database degrades to warnings and an empty dataset instead.
 */
export function loadReadContext(options: ReadOptions = {}, extras: ReadExtras = {}): ReadContext {
  const normalized = normalizeReadOptions(options);
  const loadOptions = {
    ...(normalized.db === undefined ? {} : { db: normalized.db }),
    ...(normalized.stateDir === undefined ? {} : { stateDir: normalized.stateDir }),
  };
  const config = loadConfig(loadOptions);
  const raw = readDataset({
    ...loadOptions,
    ...(normalized.days === undefined ? {} : { sinceDays: normalized.days }),
  });
  const missing = raw.warnings.find((warning) => warning.code === WARNING_CODES.sourceMissingDb);
  if (missing !== undefined) {
    throw new MuninError({
      code: "source.missing-db",
      kind: "source",
      message: missing.message,
    });
  }

  const dataset = normalized.project === undefined ? raw : filterByProject(raw, normalized.project);
  const tz = normalized.tz ?? "UTC";
  const priced = buildEvents(dataset);
  const report = buildReport(dataset, {
    zone: tz,
    ...(extras.decisions === undefined ? {} : { decisions: extras.decisions }),
  });
  return { config, dataset, priced, report, warnings: priced.warnings, tz };
}
