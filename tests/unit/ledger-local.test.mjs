import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openLedgerStore } from "@munin/local";

const dir = mkdtempSync(join(tmpdir(), "munin-ledger-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("slice journal skips torn lines and last slice per session wins", () => {
  const store = openLedgerStore({ events: join(dir, "events.jsonl"), snapshots: join(dir, "snapshots.jsonl") });
  const first = { schema: "munin.slice/1", sessionId: "s1", at: "2026-10-23T10:00:00.000Z", watermarkMs: 100, events: [] };
  store.appendSlice(first);
  store.appendSlice({ ...first, at: "2026-10-23T10:01:00.000Z", watermarkMs: 200 });
  store.appendSlice({ ...first, sessionId: "s2" });
  appendFileSync(join(dir, "events.jsonl"), '{"schema":"torn"\n', "utf8");

  const result = store.readSlices();
  assert.equal(result.skippedLines, 1);
  assert.equal(result.sessions, 2);
  assert.equal(result.slicesReplaced, 1);
  assert.equal(result.slices.find((slice) => slice.sessionId === "s1").watermarkMs, 200);
});

test("snapshot journal appends and reads validated snapshots", () => {
  const store = openLedgerStore({ events: join(dir, "snapshot-events.jsonl"), snapshots: join(dir, "snapshots.jsonl") });
  const nowMs = Date.parse("2026-10-23T12:00:00.000Z");
  const snapshot = {
    schema: "munin.snapshot/1", id: 1, at: "2026-10-23T11:00:00.000Z",
    source: { path: "/tmp/opencode.db", origin: "default", schema: "v2" },
    scope: { mode: "full", sessionsRead: 1, slicesReplaced: 1 },
    state: { sessionsTracked: 1, eventsTracked: 0 },
    window: { start: null, end: null, days: 0 },
    totals: {
      calls: 0, sessions: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
      headlineUsd: 0, observedUsd: 0, estimatedUsd: 0,
    },
    byModel: [], findings: [], dataClean: true, warningCounts: {},
  };
  store.appendSnapshot(snapshot, nowMs);
  assert.deepEqual(store.readSnapshots(nowMs), { snapshots: [snapshot], skippedLines: 0 });
});
