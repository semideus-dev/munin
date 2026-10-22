import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openChangesStore, openMuninConfigStore } from "@munin/local";

test("local apply stores are restricted to Munin config and append the changes journal", () => {
  const root = mkdtempSync(join(tmpdir(), "munin-apply-"));
  try {
    const settingsPath = join(root, "config.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ db: "/read-only/opencode.db", days: 7, custom: "keep" }),
    );
    const config = openMuninConfigStore(settingsPath);
    const previousBytes = config.snapshot();

    assert.deepEqual(config.read("days"), { exists: true, value: 7 });
    config.write("days", { exists: true, value: 30 });
    const savedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(savedSettings.days, 30);
    assert.equal(savedSettings.db, "/read-only/opencode.db");
    assert.equal(savedSettings.custom, "keep");
    assert.throws(
      () => config.write("days", { exists: true, value: -1 }),
      /positive finite number/,
    );
    assert.throws(
      () => config.write("db", { exists: true, value: "/another.db" }),
      /not an apply target/,
    );
    config.restoreSnapshot(previousBytes);
    assert.equal(
      config.snapshot(),
      previousBytes,
      "undo restore keeps original JSON bytes exactly",
    );

    const journalPath = join(root, "state", "changes.jsonl");
    const changes = openChangesStore(journalPath);
    const entry = {
      id: "one",
      rule: "fixture-rule",
      at: "2026-10-22T12:00:00.000Z",
      previousBytes,
      keys: ["days"],
      previous: { days: { exists: true, value: 7 } },
      values: { days: { exists: true, value: 30 } },
      status: "pending",
    };
    changes.append(entry);
    assert.deepEqual(changes.load(), [entry]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
