/**
 * The read path shared by every report command.
 *
 * Flag parsing stays in the CLI; the orchestration itself lives in
 * `@munin/application`, so the CLI and the desktop service resolve
 * configuration, read the dataset, filter it, price it once, and build the
 * shared report through one implementation. No command reimplements analysis.
 */
import { MuninError } from "@munin/core";
import { loadConfig, type LoadConfigOptions } from "@munin/local";
import { loadReadContext, type ReadContext, type ReadOptions } from "@munin/application";
import { flagValue, type ParsedArgs } from "./args.js";

export type CliData = ReadContext;

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

function zoneOf(flags: ParsedArgs["flags"]): string {
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

/** Translate parsed flags into the shared read contract. Defaults are unchanged. */
export function readOptionsOf(args: ParsedArgs): ReadOptions {
  const days = positiveInteger(args.flags, "days");
  const project = projectOf(args.flags);
  return {
    ...configOptions(args),
    ...(days === undefined ? {} : { days }),
    ...(project === undefined ? {} : { project }),
    tz: zoneOf(args.flags),
  };
}

/** Read, filter, price and report. Throws `source.missing-db` when unreadable. */
export function loadData(args: ParsedArgs): CliData {
  return loadReadContext(readOptionsOf(args));
}

export function isJson(args: ParsedArgs): boolean {
  return args.flags.json !== undefined;
}
