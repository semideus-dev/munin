import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvents,
  detectFindings,
  recordReplayResult,
  resolveVerification,
  RULES,
  runPlanReplay,
  runTokenReplay,
} from "@munin/core";

function repeatedContextDataset() {
  const sessions = [];
  const messages = [];
  for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
    const sessionId = `s${sessionIndex + 1}`;
    sessions.push({
      id: sessionId,
      projectId: `p${sessionIndex + 1}`,
      project: "munin",
      agent: "build",
      model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
      schema: "v2",
      instructions: { keys: ["system"], chars: 400, prefixHash: "shared-prefix" },
      timeCreated: "2026-01-01T00:00:00.000Z",
      timeUpdated: "2026-01-01T00:10:00.000Z",
    });
    for (let call = 0; call < 4; call += 1) {
      messages.push({
        id: `${sessionId}-m${call}`,
        sessionId,
        seq: call,
        type: "assistant",
        timeCreated: `2026-01-01T00:0${sessionIndex}:${String(call + 1).padStart(2, "0")}.000Z`,
        usage: {
          tokens: { input: 2000, output: 100, thinking: 0, cacheRead: 0, cacheWrite: 0 },
        },
        stopReason: "stop",
      });
    }
  }
  return { schema: "v2", sources: ["fixture"], sessions, messages, warnings: [] };
}

function findRepeatedContext(events) {
  const definition = RULES.find((rule) => rule.id === "repeated-context");
  const detected = detectFindings(events, [{ rule: definition.id, run: definition.run }]);
  assert.deepEqual(detected.errors, []);
  const finding = detected.findings[0];
  assert.ok(finding, "fixture should produce a repeated-context finding");
  return finding;
}

test("token replay re-runs a detector and passes on the unchanged evidence", () => {
  const events = buildEvents(repeatedContextDataset()).events;
  const finding = findRepeatedContext(events);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args);
    throw new Error("network must remain unused");
  };
  let result;
  try {
    result = runTokenReplay({
      finding,
      events,
      at: "2026-10-22T12:00:00.000Z",
    });
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result.kind, "token");
  assert.equal(result.verdict, "PASS");
  assert.equal(result.differenceUsd, 0);
  assert.equal(result.samples, 12);
  assert.match(result.reason, /match the saved finding/);

  let persisted = {};
  const store = { load: () => persisted, save: (next) => (persisted = { ...next }) };
  recordReplayResult(store, result);
  const resolved = resolveVerification(finding, persisted[finding.rule]);
  assert.equal(resolved.canApply, true);
  assert.equal(resolved.record.samples, 12);
});

test("token replay reports a stale claim window with the recomputed difference", () => {
  const events = buildEvents(repeatedContextDataset()).events;
  const finding = findRepeatedContext(events);
  const changed = events.map((event, index) =>
    index === 0 ? { ...event, inputTokens: event.inputTokens + 2000 } : event,
  );
  const result = runTokenReplay({
    finding,
    events: changed,
    at: "2026-10-22T12:00:00.000Z",
  });

  assert.equal(result.verdict, "FAIL");
  assert.notEqual(result.refreshedClaimWindowUsd, result.expectedClaimWindowUsd);
  assert.notEqual(result.differenceUsd, 0);
  assert.notEqual(result.refreshedTokensWasted, result.expectedTokensWasted);
  assert.notEqual(result.differenceTokens, 0);
  assert.match(result.reason, /stale/);
  assert.equal(result.record.state, "failed");
});

test("plan replay runs a canned local driver and never calls fetch", () => {
  const finding = {
    rule: "context-compaction",
    verification: "replay",
    risk: "needs-verification",
    savings: { confidence: "medium" },
    claimByEvent: new Map([["event-1", 0.02]]),
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args);
    throw new Error("network must remain unused");
  };
  try {
    const result = runPlanReplay({
      finding,
      events: [{ id: "event-1" }],
      at: "2026-10-22T12:00:00.000Z",
      driver: {
        execute(_finding, events) {
          assert.equal(events.length, 1);
          return {
            verdict: "PASS",
            claimWindowUsd: 0.02,
            confidence: "high",
            samples: 1,
            reason: "Canned plan preserved the expected disposition.",
          };
        },
      },
    });
    assert.equal(result.verdict, "PASS");
    assert.equal(result.confidence, "high");
    assert.equal(result.samples, 1);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
