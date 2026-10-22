import assert from "node:assert/strict";
import { test } from "node:test";
import { validateScanCursor, validateSnapshot } from "@munin/core";

const nowMs = Date.parse("2026-10-23T12:00:00.000Z");

function snapshot(overrides = {}) {
  return {
    schema: "munin.snapshot/1",
    id: 2,
    at: "2026-10-23T11:00:00.000Z",
    source: { path: "/tmp/opencode.db", origin: "default", schema: "v2" },
    scope: { mode: "incremental", sessionsRead: 1, slicesReplaced: 1 },
    state: { sessionsTracked: 1, eventsTracked: 3 },
    window: { start: "2026-10-20T00:00:00.000Z", end: "2026-10-23T11:00:00.000Z", days: 4 },
    totals: {
      calls: 3,
      sessions: 1,
      inputTokens: 10,
      outputTokens: 20,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      headlineUsd: 0.01,
      observedUsd: 0.01,
      estimatedUsd: 0,
    },
    byModel: [
      {
        provider: "example",
        model: "model-a",
        calls: 3,
        totalTokens: 30,
        headlineUsd: 0.01,
        observedUsd: 0.01,
        estimatedUsd: 0,
      },
    ],
    findings: [{ rule: "repeat-call", count: 1, claimedWindowUsd: 0.001 }],
    dataClean: true,
    warningCounts: {},
    ...overrides,
  };
}

test("snapshot validation checks required shape, ISO time, and increasing ids", () => {
  assert.doesNotThrow(() => validateSnapshot(snapshot(), { nowMs, previousId: 1 }));
  assert.throws(() => validateSnapshot(snapshot({ at: "yesterday" }), { nowMs }), /ISO 8601/);
  assert.throws(
    () => validateSnapshot(snapshot({ id: 1 }), { nowMs, previousId: 1 }),
    /greater than/,
  );
  assert.throws(
    () => validateSnapshot(snapshot({ id: 3, at: "2026-10-24T00:00:00.000Z" }), { nowMs }),
    /future/,
  );
  assert.throws(
    () =>
      validateSnapshot(snapshot({ state: { sessionsTracked: -1, eventsTracked: 0 } }), { nowMs }),
    /state counters/,
  );
  assert.throws(
    () => validateSnapshot(snapshot({ prompt: "private" }), { nowMs }),
    /Privacy-sensitive/,
  );
  assert.throws(
    () => validateSnapshot(snapshot({ futureField: true }), { nowMs }),
    /missing or unexpected fields/,
  );
});

test("cursor validation rejects malformed and future watermarks", () => {
  const cursor = {
    schema: "munin.cursor/1",
    sourceSchema: "mixed",
    v1: null,
    v2: nowMs - 1,
    at: "2026-10-23T11:00:00.000Z",
  };
  assert.doesNotThrow(() => validateScanCursor(cursor, nowMs));
  assert.throws(
    () => validateScanCursor({ ...cursor, v2: nowMs + 1 }, nowMs),
    /watermark cannot be in the future/,
  );
  assert.throws(() => validateScanCursor({ ...cursor, at: "not-a-date" }, nowMs), /ISO 8601/);
});
