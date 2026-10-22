import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { validateScanCursor, type ScanCursor } from "@munin/core";

export interface CursorLoadResult {
  cursor: ScanCursor | null;
  warning?: string;
}

/** A missing cursor is an ordinary first run; an invalid one is never guessed. */
export function readScanCursor(path: string, nowMs = Date.now()): CursorLoadResult {
  if (!existsSync(path)) return { cursor: null };
  try {
    const cursor: unknown = JSON.parse(readFileSync(path, "utf8"));
    validateScanCursor(cursor, nowMs);
    return { cursor };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { cursor: null, warning: `Could not load scan cursor ${path}: ${reason}` };
  }
}

/** Persist a cursor with a same-directory temporary file and atomic rename. */
export function writeScanCursor(path: string, cursor: ScanCursor, nowMs = Date.now()): void {
  validateScanCursor(cursor, nowMs);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(cursor, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
