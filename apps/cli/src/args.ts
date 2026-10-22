/**
 * Argument parsing shared by every command.
 *
 * Long flags accept `--name value` and `--name=value`. Short `-h` and `-v`
 * are the only short flags; anything else is positional so the command table
 * can report it as an unknown command.
 */
import { MuninError } from "@munin/core";

export interface ParsedArgs {
  /** First positional, or `profile` when there is none. */
  command: string;
  /** True when the command word came from argv rather than the default. */
  commandGiven: boolean;
  /** Everything after the command. */
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "agent",
  "at",
  "backfill",
  "budget",
  "db",
  "depth",
  "days",
  "interval",
  "min-usd",
  "org",
  "out",
  "plan",
  "project",
  "requests",
  "service",
  "source",
  "state-dir",
  "to",
  "top",
  "tz",
  "window",
]);

function missingValue(flag: string): MuninError {
  return new MuninError({
    code: "cli.missing-value",
    kind: "usage",
    message: `${flag} requires a value`,
  });
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "-v") {
      flags.version = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const key = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (key.length === 0) {
      positional.push(arg);
      continue;
    }
    if (equals !== -1) {
      flags[key] = arg.slice(equals + 1);
      continue;
    }

    const next = argv[index + 1];
    if (VALUE_FLAGS.has(key)) {
      if (next === undefined || next.startsWith("-")) throw missingValue(`--${key}`);
      flags[key] = next;
      index += 1;
      continue;
    }
    flags[key] = true;
  }

  return {
    command: positional[0] ?? "profile",
    commandGiven: positional.length > 0,
    positional: positional.slice(1),
    flags,
  };
}

/** A flag value, or undefined when the flag was not supplied as a value. */
export function flagValue(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** True when `--json` appeared, including `--json=true`. */
export function wantsJson(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}
