import type { ScanCursor } from "../domain/ledger.js";
import type { SourceSchema } from "../domain/source.js";
import { validateScanCursor } from "./schemas.js";

export interface CursorReadRows {
  sessions: readonly { time_updated: number }[];
  /** Selected sessions whose complete rows could not be read. */
  failedSessionIds?: readonly string[];
}

export interface CursorSchemaReads {
  v1?: CursorReadRows;
  v2?: CursorReadRows;
}

/** Advance only from complete schema reads; failed selected sessions fail closed. */
export function advanceCursor(
  current: ScanCursor | null,
  reads: CursorSchemaReads,
  sourceSchema: SourceSchema,
  at: string,
): ScanCursor {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(at)) {
    throw new TypeError("Cursor at must be an ISO 8601 UTC timestamp");
  }

  const next: ScanCursor = {
    schema: "munin.cursor/1",
    sourceSchema,
    v1: current?.v1 ?? null,
    v2: current?.v2 ?? null,
    at,
  };

  if (sourceSchema === "v1" || sourceSchema === "mixed") {
    if (!reads.v1) throw new Error("Cannot advance cursor without a complete v1 read");
    next.v1 = advanceWatermark(current?.v1 ?? null, reads.v1, atMs, "v1");
  }
  if (sourceSchema === "v2" || sourceSchema === "mixed") {
    if (!reads.v2) throw new Error("Cannot advance cursor without a complete v2 read");
    next.v2 = advanceWatermark(current?.v2 ?? null, reads.v2, atMs, "v2");
  }

  validateScanCursor(next, atMs);
  return next;
}

function advanceWatermark(
  current: number | null,
  read: CursorReadRows,
  atMs: number,
  schema: "v1" | "v2",
): number | null {
  if ((read.failedSessionIds?.length ?? 0) > 0) {
    throw new Error(`Cannot advance ${schema} cursor after a selected session read failed`);
  }
  let maximum = current;
  for (const session of read.sessions) {
    if (!Number.isFinite(session.time_updated) || session.time_updated < 0) {
      throw new TypeError(`Invalid ${schema} session time_updated`);
    }
    if (session.time_updated > atMs) throw new Error(`Cannot advance ${schema} cursor into the future`);
    maximum = maximum === null ? session.time_updated : Math.max(maximum, session.time_updated);
  }
  return maximum;
}
