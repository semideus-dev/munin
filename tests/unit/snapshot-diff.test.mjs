import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots } from "@munin/core";

function snapshot(id, overrides = {}) {
  return {
    schema: "munin.snapshot/1",
    id,
    at: `2026-10-2${id}T10:00:00.000Z`,
    source: { path: "/tmp/opencode.db", origin: "default", schema: "v2" },
    scope: { mode: "incremental", sessionsRead: 1, slicesReplaced: 1 },
    state: { sessionsTracked: 2, eventsTracked: 3 },
    window: { start: null, end: null, days: 0 },
    totals: {
      calls: 3,
      sessions: 2,
      inputTokens: 10,
      outputTokens: 20,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      headlineUsd: 1,
      observedUsd: 0.5,
      estimatedUsd: 0.5,
    },
    byModel: [
      {
        provider: "p",
        model: "m",
        calls: 3,
        totalTokens: 30,
        headlineUsd: 1,
        observedUsd: 0.5,
        estimatedUsd: 0.5,
      },
    ],
    findings: [
      { rule: "growing", count: 1, claimedWindowUsd: 0.1 },
      { rule: "gone", count: 1, claimedWindowUsd: 0.2 },
    ],
    dataClean: true,
    warningCounts: {},
    ...overrides,
  };
}

test("snapshot diff reports totals, models, sessions, and finding lifecycle by rule", () => {
  const previous = snapshot(1);
  const current = snapshot(2, {
    state: { sessionsTracked: 3, eventsTracked: 5 },
    totals: { ...previous.totals, calls: 5, totalTokens: 50, headlineUsd: 1.25 },
    byModel: [
      { ...previous.byModel[0], calls: 5, totalTokens: 50, headlineUsd: 1.25 },
      {
        provider: "new",
        model: "model",
        calls: 1,
        totalTokens: 5,
        headlineUsd: 0.1,
        observedUsd: 0.1,
        estimatedUsd: 0,
      },
    ],
    findings: [
      { rule: "growing", count: 2, claimedWindowUsd: 0.3 },
      { rule: "appeared", count: 1, claimedWindowUsd: 0.05 },
    ],
  });
  const diff = diffSnapshots(previous, current);
  assert.deepEqual(diff.sessions, { before: 2, after: 3, delta: 1 });
  assert.deepEqual(diff.totals, {
    calls: 2,
    totalTokens: 20,
    headlineUsd: 0.25,
    observedUsd: 0,
    estimatedUsd: 0,
  });
  assert.deepEqual(diff.findings, {
    appeared: ["appeared"],
    disappeared: ["gone"],
    grew: ["growing"],
  });
  assert.equal(diff.byModel.length, 2);
});
