import type { RawMessageV1Row, RawPartV1Row, RawSessionV1Row } from "@munin/core";
import type { DatabaseSync } from "node:sqlite";

const SESSION_CHUNK_SIZE = 500;

export interface ReadV1RowsOptions {
  sinceDays?: number;
  limit?: number;
  offset?: number;
  watermarkMs?: number;
  overlapMs?: number;
}

export interface ReadV1RowsResult {
  sessions: RawSessionV1Row[];
  messages: RawMessageV1Row[];
  parts: RawPartV1Row[];
}

function buildSessionSelection(options: ReadV1RowsOptions): {
  whereClause: string;
  params: Record<string, number>;
} {
  const conditions: string[] = [];
  const params: Record<string, number> = {};

  if (options.sinceDays !== undefined && options.sinceDays > 0) {
    const cutoffMs = Date.now() - Math.floor(options.sinceDays * 86_400_000);
    conditions.push("s.time_updated >= :cutoffMs");
    params.cutoffMs = cutoffMs;
  }

  if (options.watermarkMs !== undefined) {
    if (!Number.isFinite(options.watermarkMs) || options.watermarkMs < 0) {
      throw new TypeError("watermarkMs must be a non-negative finite number");
    }
    const overlapMs = options.overlapMs ?? 30_000;
    if (!Number.isFinite(overlapMs) || overlapMs < 0) {
      throw new TypeError("overlapMs must be a non-negative finite number");
    }
    conditions.push("s.time_updated >= :watermarkCutoffMs");
    params.watermarkCutoffMs = Math.max(0, options.watermarkMs - overlapMs);
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
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

function selectSessions(db: DatabaseSync, options: ReadV1RowsOptions): RawSessionV1Row[] {
  const { whereClause, params } = buildSessionSelection(options);
  const limitClause = options.limit !== undefined ? "LIMIT :limit" : "";
  const offsetClause = options.offset !== undefined ? "OFFSET :offset" : "";

  const statement = db.prepare(
    `SELECT
        s.id,
        s.project_id,
        p.worktree AS project_worktree,
        s.parent_id,
        s.title,
        s.directory,
        s.agent,
        s.model,
        s.time_created,
        s.time_updated
      FROM session s
      LEFT JOIN project p ON p.id = s.project_id
      ${whereClause}
      ORDER BY s.time_updated DESC
      ${limitClause}
      ${offsetClause}`,
  );

  const queryParams: Record<string, number> = { ...params };
  if (options.limit !== undefined) {
    queryParams.limit = options.limit;
  }
  if (options.offset !== undefined) {
    queryParams.offset = options.offset;
  }

  return statement.all(queryParams) as unknown as RawSessionV1Row[];
}

function selectMessages(db: DatabaseSync, sessionIds: string[]): RawMessageV1Row[] {
  const rows: RawMessageV1Row[] = [];

  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT
          id,
          session_id,
          seq,
          type,
          time_created,
          time_updated
        FROM message
        WHERE session_id IN (${inClause})
        ORDER BY time_created, seq, id`,
    );
    rows.push(...((statement.all(...chunk) as unknown) as RawMessageV1Row[]));
  }

  return rows;
}

function selectParts(db: DatabaseSync, messageIds: string[]): RawPartV1Row[] {
  const rows: RawPartV1Row[] = [];

  for (const chunk of chunked(messageIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT
          p.id,
          p.message_id,
          p.seq,
          p.type,
          CASE
            WHEN json_valid(p.data) = 1 THEN json_remove(p.data, '$.text', '$.summary', '$.state.content')
            ELSE NULL
          END AS data_json,
          p.cost,
          CASE
            WHEN json_valid(p.data) = 1 THEN LENGTH(json_extract(p.data, '$.state.content'))
            ELSE NULL
          END AS tool_output_chars
        FROM part p
        WHERE p.message_id IN (${inClause})
        ORDER BY p.message_id, p.seq, p.id`,
    );
    rows.push(...((statement.all(...chunk) as unknown) as RawPartV1Row[]));
  }

  return rows;
}

export function readV1Rows(db: DatabaseSync, options: ReadV1RowsOptions = {}): ReadV1RowsResult {
  const sessions = selectSessions(db, options);
  const sessionIds = sessions.map((session) => session.id);

  if (sessionIds.length === 0) {
    return { sessions, messages: [], parts: [] };
  }

  const messages = selectMessages(db, sessionIds);
  const messageIds = messages.map((message) => message.id);

  if (messageIds.length === 0) {
    return { sessions, messages, parts: [] };
  }

  return {
    sessions,
    messages,
    parts: selectParts(db, messageIds),
  };
}
