/**
 * Shared option and failure plumbing for the Phase 5 runtime commands.
 *
 * `@munin/local` owns the scan and watch engine; the CLI only translates flags
 * into `ScanOptions` and runtime failures into the documented `MuninError`
 * codes so exit status stays consistent with the rest of the product.
 */
import { MuninError } from "@munin/core";
import type { ScanOptions } from "@munin/local";
import { flagValue, type ParsedArgs } from "./args.js";
import { positiveInteger } from "./data.js";

/** Flags shared by `scan` and `live`, resolved against the same environment. */
export function scanOptions(args: ParsedArgs): ScanOptions {
  if (args.flags.repair === true && args.flags.full !== true) {
    throw new MuninError({
      code: "cli.invalid-value",
      kind: "usage",
      message: "--repair requires --full",
    });
  }
  const db = flagValue(args.flags, "db");
  const stateDir = flagValue(args.flags, "state-dir");
  const tz = flagValue(args.flags, "tz");
  const project = flagValue(args.flags, "project");
  const days = positiveInteger(args.flags, "days");
  return {
    ...(db === undefined ? {} : { db }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(tz === undefined || tz.trim() === "" ? {} : { zone: tz }),
    ...(project === undefined || project.trim() === "" ? {} : { project }),
    ...(days === undefined ? {} : { sinceDays: days }),
    full: args.flags.full === true,
    repair: args.flags.repair === true,
  };
}

/**
 * Turn a runtime failure into an expected failure. The scan engine prefixes
 * fatal source warnings with their stable code (`[source.missing-db] ...`);
 * lock contention has no code yet, so give it one here.
 */
export function scanFailure(error: unknown): MuninError {
  if (error instanceof MuninError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const bracketed = /^\[([a-z][a-z0-9.-]*)\]\s*([\s\S]*)$/.exec(message);
  if (bracketed !== null) {
    const code = bracketed[1]!;
    return new MuninError({
      code,
      kind: code.startsWith("source.") ? "source" : "ledger",
      message: bracketed[2]!.trim(),
      cause: error,
    });
  }
  if (/holds the lock|Cannot verify existing Munin scan lock/.test(message)) {
    return new MuninError({
      code: "state.lock-held",
      kind: "ledger",
      message,
      cause: error,
    });
  }
  if (/Could not remove stale Munin scan lock/.test(message)) {
    return new MuninError({
      code: "state.lock-unremovable",
      kind: "ledger",
      message,
      cause: error,
    });
  }
  return new MuninError({
    code: "ledger.scan-failed",
    kind: "ledger",
    message,
    cause: error,
  });
}
