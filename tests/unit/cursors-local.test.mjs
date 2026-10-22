import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readScanCursor, writeScanCursor } from "@munin/local";

const dir = mkdtempSync(join(tmpdir(), "munin-cursor-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("cursor load distinguishes first run from corrupt state and writes atomically", () => {
  const path = join(dir, "nested", "cursors.json");
  const nowMs = Date.parse("2026-10-23T12:00:00.000Z");
  const cursor = {
    schema: "munin.cursor/1", sourceSchema: "mixed", v1: 100, v2: null,
    at: "2026-10-23T11:00:00.000Z",
  };
  assert.deepEqual(readScanCursor(path, nowMs), { cursor: null });
  writeScanCursor(path, cursor, nowMs);
  assert.deepEqual(readScanCursor(path, nowMs), { cursor });

  writeFileSync(path, "{torn", "utf8");
  const invalid = readScanCursor(path, nowMs);
  assert.equal(invalid.cursor, null);
  assert.match(invalid.warning, /Could not load scan cursor/);
});
