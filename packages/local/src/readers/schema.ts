import type { DatabaseSync } from "node:sqlite";

export type SourceSchema = "v1" | "v2" | "mixed" | "none";

export interface SchemaSessionCounts {
  session: number;
  session_v2: number;
}

export interface SchemaDetection {
  schema: SourceSchema;
  tables: string[];
  sessionCounts: SchemaSessionCounts;
}

interface TableRow {
  name: string;
}

interface CountRow {
  count: number;
}

function countRows(db: DatabaseSync, tableName: "session" | "session_v2"): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as CountRow | undefined;
  return row?.count ?? 0;
}

export function detectSchema(db: DatabaseSync): SchemaDetection {
  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as unknown as TableRow[];

  const tables = tableRows.map((row) => row.name);
  const tableSet = new Set(tables);

  const hasSession = tableSet.has("session");
  const hasSessionV2 = tableSet.has("session_v2");

  const session = hasSession ? countRows(db, "session") : 0;
  const sessionV2 = hasSessionV2 ? countRows(db, "session_v2") : 0;

  let schema: SourceSchema = "none";
  if (hasSession && hasSessionV2) {
    schema = "mixed";
  } else if (hasSessionV2) {
    schema = "v2";
  } else if (hasSession) {
    schema = "v1";
  }

  return {
    schema,
    tables,
    sessionCounts: {
      session,
      session_v2: sessionV2,
    },
  };
}
