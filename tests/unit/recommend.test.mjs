import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecommendations, buildReport, recordDecision } from "@munin/core";

function finding(rule, options = {}) {
  const {
    claims = [[`${rule}-event`, 0.01]],
    confidence = "medium",
    tier = "try",
    verification = "replay",
    advisory = false,
  } = options;
  return {
    rule,
    category: "context-bloat",
    title: `${rule} title`,
    detail: `${rule} detail`,
    why: `${rule} traffic rationale`,
    fix: `${rule} fix`,
    tier,
    savings: { confidence, monthlyUsd: 1 },
    affected: { calls: 2, models: ["model-b", "model-a"] },
    verification,
    advisory,
    claimByEvent: new Map(claims),
  };
}

test("recommendations sort by claimed window, confidence, then rule id", () => {
  const recommendations = buildRecommendations(
    [
      finding("z-rule", { claims: [["e", 0.1]], confidence: "high" }),
      finding("b-rule", { claims: [["e", 0.2]], confidence: "low" }),
      finding("a-rule", { claims: [["e", 0.1]], confidence: "high" }),
      finding("advisory", { advisory: true }),
    ],
    10,
  );

  assert.deepEqual(
    recommendations.map((r) => r.rule),
    ["b-rule", "a-rule", "z-rule"],
  );
  assert.equal(recommendations[0].windowUsd, 0.2);
  assert.equal(
    recommendations[1].rationale,
    "In this window, 2 of 10 calls (20%) on model-a, model-b: a-rule traffic rationale",
  );
  assert.deepEqual(recommendations[0].actions, ["view-affected", "simulate", "verify", "apply"]);
  assert.deepEqual(
    buildRecommendations([finding("manual", { verification: "manual" })], 2)[0].actions,
    ["view-affected", "simulate", "apply"],
  );
});

test("decision store is injected; recordDecision persists a dated choice", () => {
  let stored = {};
  const store = {
    load: () => stored,
    save: (next) => {
      stored = { ...next };
    },
  };

  recordDecision(store, "repeat-tool-calls", "viewed", "2026-10-22T12:00:00.000Z");
  const [recommendation] = buildRecommendations([finding("repeat-tool-calls")], 10, store.load());

  assert.equal(recommendation.status, "viewed");
  assert.equal(recommendation.decisionAt, "2026-10-22T12:00:00.000Z");
});

test("report carries recommendations and injected decision state", () => {
  const dataset = {
    schema: "v2",
    sources: ["fixture"],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: "2026-01-01T00:00:00.000Z",
        timeUpdated: "2026-01-01T00:02:00.000Z",
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: "2026-01-01T00:01:00.000Z",
        usage: { tokens: { input: 1000, output: 100, thinking: 0, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
        toolCalls: [{ id: "t1", name: "Read", signature: "Read:/a.ts#0:0", resultChars: 240 }],
      },
      {
        id: "m2",
        sessionId: "s1",
        seq: 1,
        type: "assistant",
        timeCreated: "2026-01-01T00:02:00.000Z",
        usage: { tokens: { input: 1000, output: 100, thinking: 0, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
        toolCalls: [{ id: "t2", name: "Read", signature: "Read:/a.ts#0:0", resultChars: 240 }],
      },
    ],
    warnings: [],
  };
  const report = buildReport(dataset, {
    decisions: {
      "repeat-tool-calls": {
        rule: "repeat-tool-calls",
        status: "done",
        at: "2026-10-22T12:00:00.000Z",
      },
    },
  });

  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0].rule, "repeat-tool-calls");
  assert.equal(report.recommendations[0].status, "done");
  assert.equal(report.recommendations[0].decisionAt, "2026-10-22T12:00:00.000Z");
});
