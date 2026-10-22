import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvents, detectFindings, RULES } from "@munin/core";

function mkMessage(id, sessionId, seq, timeCreated, overrides = {}) {
  return {
    id,
    sessionId,
    seq,
    type: "assistant",
    timeCreated,
    usage: {
      tokens: {
        input: 16_000,
        output: 4_000,
        thinking: 2_500,
        cacheRead: 0,
        cacheWrite: 0,
      },
      observedUsd: 0.002,
    },
    stopReason: "stop",
    ...overrides,
  };
}

function fixture() {
  const sessions = [
    {
      id: "s1",
      projectId: "p1",
      project: "munin",
      agent: "build",
      model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
      schema: "v2",
      instructions: { keys: ["sys"], chars: 80_000, prefixHash: "ph-1" },
      timeCreated: "2026-01-01T00:00:00.000Z",
      timeUpdated: "2026-01-01T01:00:00.000Z",
    },
    {
      id: "s2",
      projectId: "p2",
      project: "munin",
      agent: "build",
      model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
      schema: "v2",
      instructions: { keys: ["sys"], chars: 80_000, prefixHash: "ph-1" },
      timeCreated: "2026-01-01T00:00:00.000Z",
      timeUpdated: "2026-01-01T01:00:00.000Z",
    },
    {
      id: "s3",
      projectId: "p3",
      project: "munin",
      agent: "build",
      model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
      schema: "v2",
      instructions: { keys: ["sys"], chars: 80_000, prefixHash: "ph-1" },
      timeCreated: "2026-01-01T00:00:00.000Z",
      timeUpdated: "2026-01-01T01:00:00.000Z",
    },
  ];

  const messages = [
    mkMessage("m1", "s1", 1, "2026-01-01T00:01:00.000Z", {
      toolCalls: [{ id: "t1", name: "Read", signature: "Read:/a.ts#0:0", resultChars: 30_000 }],
    }),
    mkMessage("m2", "s1", 2, "2026-01-01T00:02:00.000Z", {
      toolCalls: [{ id: "t2", name: "Read", signature: "Read:/a.ts#0:0", resultChars: 30_000 }],
    }),
    mkMessage("m3", "s1", 3, "2026-01-01T00:03:00.000Z"),
    mkMessage("m4", "s1", 4, "2026-01-01T00:04:00.000Z", { stopReason: "error" }),
    mkMessage("m5", "s1", 5, "2026-01-01T00:05:00.000Z", { stopReason: "error" }),
    mkMessage("m6", "s1", 6, "2026-01-01T00:06:00.000Z"),

    mkMessage("m7", "s2", 1, "2026-01-02T00:01:00.000Z"),
    mkMessage("m8", "s2", 2, "2026-01-02T00:02:00.000Z"),
    mkMessage("m9", "s2", 3, "2026-01-02T00:03:00.000Z"),
    mkMessage("m10", "s2", 4, "2026-01-02T00:04:00.000Z"),

    mkMessage("m11", "s3", 1, "2026-01-03T00:01:00.000Z"),
    mkMessage("m12", "s3", 2, "2026-01-03T00:02:00.000Z"),
    mkMessage("m13", "s3", 3, "2026-01-03T00:03:00.000Z"),
    mkMessage("m14", "s3", 4, "2026-01-03T00:04:00.000Z"),
  ];

  return { schema: "v2", sources: ["fixture"], sessions, messages, warnings: [] };
}

test("ported rules run and key rules produce findings on synthetic traffic", () => {
  const dataset = fixture();
  const events = buildEvents(dataset).events;
  const { findings, errors } = detectFindings(events, RULES.map((rule) => ({ rule: rule.id, run: rule.run })));

  assert.deepEqual(errors, []);
  const ids = new Set(findings.map((finding) => finding.rule));
  assert.equal(ids.has("repeat-tool-calls"), true);
  assert.equal(ids.has("oversized-input"), true);
  assert.equal(ids.has("oversized-output"), true);
  assert.equal(ids.has("prompt-bloat"), true);
});
