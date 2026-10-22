import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileAggregates } from "@munin/core";

function baseDataset() {
  return {
    schema: "v2",
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        schema: "v2",
        timeCreated: "2024-01-01T00:00:00.000Z",
        timeUpdated: "2024-01-01T00:00:00.000Z",
        aggregateUsage: { input: 100, output: 50, thinking: 10, cacheRead: 20, cacheWrite: 0 },
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        seq: 1,
        type: "assistant",
        timeCreated: "2024-01-01T00:00:00.000Z",
        usage: { tokens: { input: 100, output: 50, thinking: 10, cacheRead: 20, cacheWrite: 0 } },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
}

test("reconcile emits no warning when aggregates match", () => {
  const result = reconcileAggregates(baseDataset());
  assert.equal(result.mismatchSessions, 0);
  assert.equal(result.warning, undefined);
});

test("reconcile emits one warning for >1% mismatch", () => {
  const dataset = baseDataset();
  dataset.messages[0].usage.tokens.input = 98;

  const result = reconcileAggregates(dataset);
  assert.equal(result.mismatchSessions, 1);
  assert.equal(result.warning?.code, "source.aggregate-mismatch");
  assert.equal(result.warning?.count, 1);
  assert.equal(result.largestDelta, 2);
});
