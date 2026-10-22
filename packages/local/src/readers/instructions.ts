import type { RawInstructionEntryRow } from "@munin/core";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const SESSION_CHUNK_SIZE = 500;

export interface SessionInstructionSummary {
  sessionId: string;
  keys: string[];
  chars: number;
  prefixHash: string;
}

export interface ReadInstructionsResult {
  entries: RawInstructionEntryRow[];
  bySession: SessionInstructionSummary[];
}

function placeholders(size: number): string {
  return Array.from({ length: size }, (_, index) => `?${index + 1}`).join(", ");
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function hashInstructionSet(values: Array<{ key: string; hash: string }>): string {
  const normalized = [...values].sort((a, b) => a.key.localeCompare(b.key));
  const digestInput = normalized.map((item) => `${item.key}:${item.hash}`).join("\n");
  return createHash("sha256").update(digestInput).digest("hex");
}

export function readInstructions(db: DatabaseSync, sessionIds: string[]): ReadInstructionsResult {
  if (sessionIds.length === 0) {
    return { entries: [], bySession: [] };
  }

  const entries: RawInstructionEntryRow[] = [];

  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT
          st.session_id AS session_id,
          kv.key AS instruction_key,
          kv.value AS blob_hash,
          LENGTH(bl.value) AS char_count
        FROM instruction_state st
        JOIN json_each(st.current_values) AS kv
        LEFT JOIN instruction_blob bl ON bl.hash = kv.value
        WHERE st.session_id IN (${inClause})
          AND json_valid(st.current_values) = 1`,
    );

    entries.push(...((statement.all(...chunk) as unknown) as RawInstructionEntryRow[]));
  }

  const grouped = new Map<string, RawInstructionEntryRow[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.session_id);
    if (current === undefined) {
      grouped.set(entry.session_id, [entry]);
      continue;
    }
    current.push(entry);
  }

  const bySession: SessionInstructionSummary[] = [];
  for (const [sessionId, group] of grouped.entries()) {
    const keys = group.map((row) => row.instruction_key).sort((a, b) => a.localeCompare(b));
    const chars = group.reduce((sum, row) => sum + (row.char_count ?? 0), 0);
    const prefixHash = hashInstructionSet(
      group.map((row) => ({ key: row.instruction_key, hash: row.blob_hash })),
    );

    bySession.push({ sessionId, keys, chars, prefixHash });
  }

  bySession.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  return { entries, bySession };
}
