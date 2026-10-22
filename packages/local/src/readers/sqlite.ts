import { DatabaseSync } from "node:sqlite";

/**
 * Open a read-only SQLite handle configured for local source reads.
 *
 * Callers must close the handle.
 */
export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA query_only = ON");
  return db;
}
