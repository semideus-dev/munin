import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvents, buildReport, detectFindings, recoverableByEvent, recoverableWindow } from "@munin/core";

function fixture() {
  return {
    schema: "v2",
    sources: ["fixture"],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
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
        usage: {
          tokens: { input: 1_000_000, output: 100, thinking: 0, cacheRead: 0, cacheWrite: 0 },
        },
        stopReason: "stop",
      },
    ],
    warnings: [],
  };
}

function detector(rule, wastedUsd) {
  return {
    rule,
    run(context) {
      const event = context.events[0];
      if (event === undefined) return [];
      return [
        {
          rule,
          category: "context-bloat",
          title: `${rule} title`,
          detail: `${rule} detail`,
          why: `${rule} why`,
          tier: "fix",
          wastedUsd,
          tokensWasted: 100,
          events: [event],
          evidence: { kind: "measured", basis: "fixture" },
          confidence: { level: "high", basis: "fixture" },
          impact: "none",
          risk: "safe",
          assumptions: ["fixture"],
          calculation: "fixture",
          observations: [],
          fix: `${rule} fix`,
        },
      ];
    },
  };
}

test("recoverableWindow de-overlaps contention and is order-invariant", () => {
  const events = buildEvents(fixture()).events;
  const a = detector("rule-a", 0.09);
  const b = detector("rule-b", 0.06);

  const first = detectFindings(events, [a, b]).findings;
  const second = detectFindings(events, [b, a]).findings;

  const sum = first.reduce((s, f) => s + f.savings.windowUsd, 0);
  assert.equal(sum, 0.15);

  const byEvent = recoverableByEvent(first, ["fix"]).byEvent;
  assert.equal(byEvent.size, 1);
  assert.equal([...byEvent.values()][0], 0.09);

  assert.equal(recoverableWindow(first, ["fix"]), 0.09);
  assert.equal(recoverableWindow(second, ["fix"]), 0.09);
});

test("report adds overlap note when rules contend for the same claimed call", () => {
  const dataset = fixture();
  const a = detector("rule-a", 0.09);
  const b = detector("rule-b", 0.06);

  const report = buildReport(dataset, { detectors: [a, b] });
  const rowA = report.findings.find((f) => f.rule === "rule-a");
  const rowB = report.findings.find((f) => f.rule === "rule-b");
  assert.ok(rowA);
  assert.ok(rowB);
  assert.deepEqual(rowA.overlapWith, ["rule-b"]);
  assert.deepEqual(rowB.overlapWith, ["rule-a"]);
});
