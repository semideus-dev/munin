/**
 * The read path shared by every report command.
 *
 * This is the product front end's single seam onto the engine: it resolves the
 * same configuration the harness uses, reads the dataset, filters it by the
 * command flags, prices it once, and builds the shared report. No command
 * reimplements analysis; each one renders fields the report already carries.
 */
import {
  buildEvents,
  buildReport,
  MuninError,
  type Dataset,
  type DayZone,
  type MuninReport,
  type PricedDataset,
  type SourceWarning,
} from "@munin/core";
import { loadConfig, readDataset, type LoadConfigOptions } from "@munin/local";
import { flagValue, type ParsedArgs } from "./args.js";

export interface CliData {
  config: ReturnType<typeof loadConfig>;
  dataset: Dataset;
  priced: PricedDataset;
  report: MuninReport;
  /** Phase 2 plus pricing/analysis warnings, in report order. */
  warnings: SourceWarning[];
  tz: DayZone;
}

function invalidValue(flag: string, value: string): MuninError {
  return new MuninError({
    code: "cli.invalid-value",
    kind: "usage",
    message: `${flag} has an invalid value: ${value}`,
  });
}

export function positiveInteger(flags: ParsedArgs["flags"], name: string): number | undefined {
  const raw = flagValue(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw invalidValue(`--${name}`, raw);
  return value;
}

function zoneOf(flags: ParsedArgs["flags"]): DayZone {
  const raw = flagValue(flags, "tz");
  if (raw === undefined) return "UTC";
  if (raw.trim() === "") throw invalidValue("--tz", raw);
  return raw;
}

function projectOf(flags: ParsedArgs["flags"]): string | undefined {
  const raw = flagValue(flags, "project");
  if (raw === undefined) return undefined;
  if (raw.trim() === "") throw invalidValue("--project", raw);
  return raw;
}

function configOptions(args: ParsedArgs): LoadConfigOptions {
  const db = flagValue(args.flags, "db");
  const stateDir = flagValue(args.flags, "state-dir");
  return {
    ...(db === undefined ? {} : { db }),
    ...(stateDir === undefined ? {} : { stateDir }),
  };
}

/** Configuration only, for commands that describe capabilities without reading data. */
export function loadEnvironment(args: ParsedArgs): ReturnType<typeof loadConfig> {
  return loadConfig(configOptions(args));
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

/** Read, filter, price and report. Throws `source.missing-db` when unreadable. */
export function loadData(args: ParsedArgs): CliData {
  const options = configOptions(args);
  const days = positiveInteger(args.flags, "days");
  const project = projectOf(args.flags);
  const tz = zoneOf(args.flags);

  const config = loadConfig(options);
  const raw = readDataset({
    ...options,
    ...(days === undefined ? {} : { sinceDays: days }),
  });
  const missing = raw.warnings.find((warning) => warning.code === "source.missing-db");
  if (missing !== undefined) {
    throw new MuninError({
      code: "source.missing-db",
      kind: "source",
      message: missing.message,
    });
  }

  const dataset = project === undefined ? raw : filterByProject(raw, project);
  const priced = buildEvents(dataset);
  const report = buildReport(dataset, { zone: tz });
  return { config, dataset, priced, report, warnings: priced.warnings, tz };
}

export function isJson(args: ParsedArgs): boolean {
  return args.flags.json !== undefined;
}
