/**
 * Exit codes and machine-readable error payloads.
 *
 * The mapping lives in the CLI, not in core: core names the failure, the
 * process decides what a shell should see. Documented in docs/diagnostics.md.
 */
import { MuninError, type SourceWarning } from "@munin/core";

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  unsupported: 2,
  usage: 64,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface SuccessPayload<T> {
  ok: true;
  data: T;
  warnings: SourceWarning[];
}

export interface ErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

/** The `--json` success shape. Warnings are always present, even when empty. */
export function successPayload<T>(
  data: T,
  warnings: readonly SourceWarning[] = [],
): SuccessPayload<T> {
  return { ok: true, data, warnings: [...warnings] };
}

/** Map an expected failure to its documented exit code. */
export function exitCodeFor(error: unknown): ExitCode {
  if (!(error instanceof MuninError)) return EXIT_CODES.error;

  switch (error.kind) {
    case "usage":
      return EXIT_CODES.usage;
    case "action":
      return EXIT_CODES.unsupported;
    default:
      return EXIT_CODES.error;
  }
}

/** The `--json` error shape. Never includes a stack or a cause. */
export function errorPayload(error: unknown): ErrorPayload {
  if (error instanceof MuninError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: "internal", message } };
}
