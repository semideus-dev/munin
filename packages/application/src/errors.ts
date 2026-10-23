/**
 * The service error convention.
 *
 * Everything that crosses the application/IPC boundary uses `ServiceErrorDTO`:
 * plain JSON, stable code, one human sentence, no stack and no cause. Unknown
 * failures collapse to a fixed message; the caller logs the real error in the
 * host process (CLI stderr, Electron main log).
 */
import { MuninError, type MuninErrorKind } from "@munin/core";

/** The only error shape a renderer or IPC caller may receive. */
export interface ServiceErrorDTO {
  code: string;
  kind: MuninErrorKind | "internal";
  message: string;
}

/**
 * Convert a thrown value into safe, structured data. Never includes a stack,
 * a cause, or an arbitrary error object.
 */
export function toServiceError(error: unknown): ServiceErrorDTO {
  if (error instanceof MuninError) {
    return { code: error.code, kind: error.kind, message: error.message };
  }
  return {
    code: "internal",
    kind: "internal",
    message: "Munin could not complete that request. Check the desktop log for details.",
  };
}

/**
 * Turn a scan or watch failure into an expected failure. This is the one scan
 * error mapping shared by the CLI and the desktop service: the scan engine
 * prefixes fatal source warnings with their stable code (`[source.missing-db]
 * ...`), and lock contention arrives as plain text.
 */
export function toScanError(error: unknown): MuninError {
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
