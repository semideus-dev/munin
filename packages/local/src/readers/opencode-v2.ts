import type {
  RawMessageTextLengthRow,
  RawSessionMessageRow,
  RawSessionV2Row,
  RawToolProjectionRow,
} from "@munin/core";
import type { DatabaseSync } from "node:sqlite";

const SESSION_CHUNK_SIZE = 500;

export interface ReadV2RowsOptions {
  sinceDays?: number;
  limit?: number;
  offset?: number;
  watermarkMs?: number;
  overlapMs?: number;
}

export interface ReadV2RowsResult {
  sessions: RawSessionV2Row[];
  messages: RawSessionMessageRow[];
  messageTypeCounts: Record<string, number>;
  invalidJsonRows: number;
  tools: RawToolProjectionRow[];
  textLengths: RawMessageTextLengthRow[];
}

interface CountRow {
  count: number;
}

interface TypeCountRow {
  type: string;
  count: number;
}

function buildSessionSelection(options: ReadV2RowsOptions): {
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

function selectSessions(db: DatabaseSync, options: ReadV2RowsOptions): RawSessionV2Row[] {
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
        s.cost,
        s.tokens_input,
        s.tokens_output,
        s.tokens_reasoning,
        s.tokens_cache_read,
        s.tokens_cache_write,
        s.time_created,
        s.time_updated
      FROM session_v2 s
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

  return statement.all(queryParams) as unknown as RawSessionV2Row[];
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

function collectMessages(db: DatabaseSync, sessionIds: string[]): RawSessionMessageRow[] {
  const rows: RawSessionMessageRow[] = [];
  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT
          sm.id AS id,
          sm.session_id AS session_id,
          sm.seq AS seq,
          sm.type AS type,
          CASE
            WHEN json_valid(sm.data) = 1 THEN json_set(
              json_remove(sm.data, '$.text', '$.summary', '$.recent'),
              '$.content',
              COALESCE(
                (
                  SELECT json_group_array(json_remove(item.value, '$.text', '$.state.content'))
                  FROM json_each(sm.data, '$.content') AS item
                ),
                json('[]')
              )
            )
            ELSE NULL
          END AS data_json,
          sm.time_created AS time_created,
          sm.time_updated AS time_updated
        FROM session_message sm
        WHERE sm.session_id IN (${inClause})
        ORDER BY sm.time_created, sm.id`,
    );
    rows.push(...((statement.all(...chunk) as unknown) as RawSessionMessageRow[]));
  }
  return rows;
}

function collectTypeCounts(db: DatabaseSync, sessionIds: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT type, COUNT(*) AS count
        FROM session_message
        WHERE session_id IN (${inClause})
        GROUP BY type`,
    );
    const rows = statement.all(...chunk) as unknown as TypeCountRow[];
    for (const row of rows) {
      counts[row.type] = (counts[row.type] ?? 0) + row.count;
    }
  }
  return counts;
}

function collectInvalidJsonRows(db: DatabaseSync, sessionIds: string[]): number {
  let total = 0;
  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT COUNT(*) AS count
        FROM session_message
        WHERE session_id IN (${inClause})
          AND json_valid(data) = 0`,
    );
    const row = statement.get(...chunk) as CountRow | undefined;
    total += row?.count ?? 0;
  }
  return total;
}

function collectTools(db: DatabaseSync, sessionIds: string[]): RawToolProjectionRow[] {
  const rows: RawToolProjectionRow[] = [];
  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);
    const statement = db.prepare(
      `SELECT
          sm.id AS message_id,
          json_extract(item.value, '$.id') AS tool_id,
          json_extract(item.value, '$.name') AS tool_name,
          json_extract(item.value, '$.state.input') AS tool_input_json,
          json_extract(item.value, '$.state.status') AS tool_status,
          LENGTH(json_extract(item.value, '$.state.content')) AS tool_output_chars
        FROM session_message sm
        JOIN json_each(sm.data, '$.content') AS item
        WHERE sm.session_id IN (${inClause})
          AND json_valid(sm.data) = 1
          AND json_extract(item.value, '$.type') = 'tool'`,
    );
    rows.push(...((statement.all(...chunk) as unknown) as RawToolProjectionRow[]));
  }
  return rows;
}

function collectTextLengths(db: DatabaseSync, sessionIds: string[]): RawMessageTextLengthRow[] {
  const map = new Map<string, number>();

  for (const chunk of chunked(sessionIds, SESSION_CHUNK_SIZE)) {
    const inClause = placeholders(chunk.length);

    const topLevel = db.prepare(
      `SELECT
          id AS message_id,
          CASE
            WHEN json_valid(data) = 1 THEN COALESCE(LENGTH(json_extract(data, '$.text')), 0)
              + COALESCE(LENGTH(json_extract(data, '$.summary')), 0)
            ELSE 0
          END AS text_chars
        FROM session_message
        WHERE session_id IN (${inClause})`,
    );
    const topRows = topLevel.all(...chunk) as unknown as RawMessageTextLengthRow[];
    for (const row of topRows) {
      map.set(row.message_id, (map.get(row.message_id) ?? 0) + row.text_chars);
    }

    const nested = db.prepare(
      `SELECT
          sm.id AS message_id,
          COALESCE(SUM(LENGTH(json_extract(item.value, '$.text'))), 0) AS text_chars
        FROM session_message sm
        JOIN json_each(sm.data, '$.content') AS item
        WHERE sm.session_id IN (${inClause})
          AND json_valid(sm.data) = 1
          AND json_extract(item.value, '$.type') = 'text'
        GROUP BY sm.id`,
    );
    const nestedRows = nested.all(...chunk) as unknown as RawMessageTextLengthRow[];
    for (const row of nestedRows) {
      map.set(row.message_id, (map.get(row.message_id) ?? 0) + row.text_chars);
    }
  }

  return [...map.entries()].map(([message_id, text_chars]) => ({ message_id, text_chars }));
}

export function readV2Rows(db: DatabaseSync, options: ReadV2RowsOptions = {}): ReadV2RowsResult {
  const sessions = selectSessions(db, options);
  const sessionIds = sessions.map((row) => row.id);

  if (sessionIds.length === 0) {
    return {
      sessions,
      messages: [],
      messageTypeCounts: {},
      invalidJsonRows: 0,
      tools: [],
      textLengths: [],
    };
  }

  return {
    sessions,
    messages: collectMessages(db, sessionIds),
    messageTypeCounts: collectTypeCounts(db, sessionIds),
    invalidJsonRows: collectInvalidJsonRows(db, sessionIds),
    tools: collectTools(db, sessionIds),
    textLengths: collectTextLengths(db, sessionIds),
  };
}
