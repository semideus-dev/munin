import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvents, buildReport, detectFindings, DETECTORS, RULES } from "@munin/core";

function fixture() {
  return {
    schema: "v2",
    sources: ["opencode.db"],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: "2026-01-01T00:00:00.000Z",
        timeUpdated: "2026-01-01T00:01:00.000Z",
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: "2026-01-01T00:00:30.000Z",
        usage: { tokens: { input: 1000, output: 120, thinking: 20, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
      },
    ],
    warnings: [],
  };
}

function draftFor(rule, wastedUsd) {
  return {
    rule,
    category: "context-bloat",
    title: `${rule} title`,
    detail: `${rule} detail`,
    why: `${rule} why`,
    tier: "fix",
    wastedUsd,
    tokensWasted: 250,
    evidence: { kind: "measured", basis: "fixture" },
    confidence: { level: "high", basis: "fixture" },
    impact: "none",
    risk: "safe",
    assumptions: ["fixture assumption"],
    calculation: "fixture calculation",
    observations: [],
    fix: `${rule} fix`,
  };
}

function detector(rule, wastedUsd) {
  return {
    rule,
    run(context) {
      const event = context.events[0];
      return event === undefined ? [] : [{ ...draftFor(rule, wastedUsd), events: [event] }];
    },
  };
}

test("registry exposes stable ids and fully-filled rule metadata", () => {
  assert.deepEqual(
    RULES.map((rule) => rule.id),
    [
      "pricing-change",
      "cost-spike",
      "spend-concentration",
      "cache-churn",
      "repeat-tool-calls",
      "repeated-context",
      "prompt-bloat",
      "oversized-input",
      "oversized-output",
      "oversized-tool-output",
      "error-loops",
      "model-fit",
      "reasoning-effort",
      "context-compaction",
      "cold-resume",
      "heavy-start",
      "model-default",
    ],
  );

  for (const rule of RULES) {
    assert.ok(rule.description.length > 0, `${rule.id} description`);
    assert.ok(rule.rationale.length > 0, `${rule.id} rationale`);
    assert.ok(rule.action.length > 0, `${rule.id} action`);
    assert.ok(rule.category.length > 0, `${rule.id} category`);
    assert.ok(rule.tier.length > 0, `${rule.id} tier`);
    assert.ok(rule.verificationMode.length > 0, `${rule.id} verificationMode`);
    if (rule.verificationMode === "replay") {
      assert.ok(["token", "plan"].includes(rule.replayKind), `${rule.id} replay strategy`);
    } else {
      assert.equal(rule.replayKind, null, `${rule.id} must not declare replay`);
    }
    assert.equal(rule.claudeSafe, "Yes", `${rule.id} claudeSafe`);
    assert.equal(typeof rule.run, "function", `${rule.id} detector`);
  }
});

test("DETECTORS are derived from the named rule registry", () => {
  assert.deepEqual(
    DETECTORS.map((detector_) => detector_.rule),
    RULES.map((rule) => rule.id),
  );
});

test("report findings are sorted by rule id, not detector insertion order", () => {
  const dataset = fixture();
  const a = detector("a-rule", 0.000001);
  const z = detector("z-rule", 0.000002);

  const events = buildEvents(dataset).events;
  const detection = detectFindings(events, [a, z]);
  assert.deepEqual(
    detection.findings.map((finding) => finding.rule),
    ["z-rule", "a-rule"],
    "raw detection order is monthly-savings order",
  );

  const reportAz = buildReport(dataset, { detectors: [a, z] });
  const reportZa = buildReport(dataset, { detectors: [z, a] });

  assert.deepEqual(
    reportAz.findings.map((finding) => finding.rule),
    ["a-rule", "z-rule"],
  );
  assert.deepEqual(
    reportZa.findings.map((finding) => finding.rule),
    ["a-rule", "z-rule"],
  );
});
