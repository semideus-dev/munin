/**
 * Shared option and failure plumbing for the Phase 5 runtime commands.
 *
 * `@munin/local` owns the scan and watch engine; the CLI only translates flags
 * into `ScanOptions` and runtime failures into the documented `MuninError`
 * codes so exit status stays consistent with the rest of the product.
 */
import { MuninError } from "@munin/core";
import { toScanError } from "@munin/application";
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
 * Turn a runtime failure into an expected failure. The mapping is shared with
 * the desktop service; the CLI keeps this wrapper so its call sites and docs
 * are unchanged.
 */
export function scanFailure(error: unknown): MuninError {
  return toScanError(error);
}
