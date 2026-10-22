import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  deserializeSessionSlice,
  serializeSnapshot,
  serializeSessionSlice,
  validateSnapshot,
  type SessionSlice,
  type Snapshot,
} from "@munin/core";
import type { LedgerPaths } from "./paths.js";

export interface SessionSliceRead {
  slices: SessionSlice[];
  skippedLines: number;
  sessions: number;
  /** Valid journal entries superseded by a later slice for that session. */
  slicesReplaced: number;
}

export interface SnapshotRead {
  snapshots: Snapshot[];
  skippedLines: number;
}

/** File-backed append-only journals. Every path is supplied by the caller. */
export function openLedgerStore(paths: Pick<LedgerPaths, "events" | "snapshots">) {
  return {
    readSlices(): SessionSliceRead {
      const latest = new Map<string, SessionSlice>();
      let skippedLines = 0;
      let validLines = 0;
      for (const line of readJournal(paths.events)) {
        try {
          const slice = deserializeSessionSlice(line);
          validLines += 1;
          latest.set(slice.sessionId, slice);
        } catch {
          skippedLines += 1;
        }
      }
      return {
        slices: [...latest.values()],
        skippedLines,
        sessions: latest.size,
        slicesReplaced: validLines - latest.size,
      };
    },

    appendSlice(slice: SessionSlice): void {
      appendLine(paths.events, serializeSessionSlice(slice));
    },

    /** Explicit repair path: atomically replace the journal with a full source read. */
    rewriteSlices(slices: readonly SessionSlice[]): void {
      const serialized = slices.map((slice) => serializeSessionSlice(slice));
      mkdirSync(dirname(paths.events), { recursive: true });
      const temporaryPath = `${paths.events}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, serialized.length === 0 ? "" : `${serialized.join("\n")}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        renameSync(temporaryPath, paths.events);
      } finally {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      }
    },

    readSnapshots(nowMs = Date.now()): SnapshotRead {
      const snapshots: Snapshot[] = [];
      let skippedLines = 0;
      for (const line of readJournal(paths.snapshots)) {
        try {
          const value: unknown = JSON.parse(line);
          validateSnapshot(value, { previousId: snapshots.at(-1)?.id, nowMs });
          snapshots.push(value);
        } catch {
          skippedLines += 1;
        }
      }
      return { snapshots, skippedLines };
    },

    appendSnapshot(snapshot: Snapshot, nowMs = Date.now()): void {
      const previous = this.readSnapshots(nowMs).snapshots.at(-1);
      validateSnapshot(snapshot, { previousId: previous?.id, nowMs });
      appendLine(paths.snapshots, serializeSnapshot(snapshot, nowMs));
    },

    /** Strict post-write privacy audit: unlike ordinary reads, no bad line is skipped. */
    auditPrivacy(nowMs = Date.now()): void {
      let lineNumber = 0;
      for (const line of readJournal(paths.events)) {
        lineNumber += 1;
        try {
          deserializeSessionSlice(line);
        } catch (error) {
          throw new Error(
            `Privacy check rejected events.jsonl line ${lineNumber}: ${reasonOf(error)}`,
          );
        }
      }
      let previousId: number | undefined;
      lineNumber = 0;
      for (const line of readJournal(paths.snapshots)) {
        lineNumber += 1;
        try {
          const snapshot: unknown = JSON.parse(line);
          validateSnapshot(snapshot, { previousId, nowMs });
          previousId = (snapshot as Snapshot).id;
        } catch (error) {
          throw new Error(
            `Privacy check rejected snapshots.jsonl line ${lineNumber}: ${reasonOf(error)}`,
          );
        }
      }
    },
  };
}

function readJournal(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, "utf8");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
