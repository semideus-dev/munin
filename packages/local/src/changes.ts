import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeManifestEntry, ChangeManifestStore } from "@munin/core";

/** File-backed append-only apply journal at Munin's `changes.jsonl` path. */
export function openChangesStore(path: string): ChangeManifestStore {
  return {
    load() {
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      return lines.map((line, index) => {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          throw new Error(`Invalid changes journal JSON on line ${index + 1}: ${path}`);
        }
        if (
          entry === null ||
          typeof entry !== "object" ||
          typeof (entry as ChangeManifestEntry).id !== "string" ||
          !["pending", "applied", "undo-pending", "undone"].includes(
            (entry as ChangeManifestEntry).status,
          )
        ) {
          throw new Error(`Invalid changes journal entry on line ${index + 1}: ${path}`);
        }
        return entry as ChangeManifestEntry;
      });
    },
    append(entry) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
  };
}
