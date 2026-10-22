import assert from "node:assert/strict";
import { test } from "node:test";
import { deserializeSessionSlice, serializeSessionSlice } from "@munin/core";

const event = {
  id: "message-1",
  source: "opencode",
  schema: "v2",
  provider: "example",
  model: "model-a",
  ts: "2026-10-23T10:00:00.000Z",
  sessionId: "session-1",
  project: "munin",
  inputTokens: 10,
  outputTokens: 4,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  tools: [{ id: "tool-1", name: "Read", signature: "Read:/src/file.ts" }],
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0,
    cacheWrite: 0,
    serverTools: 0,
    total: 0.003,
    unpriced: false,
    observedUsd: null,
    estimatedUsd: 0.003,
    basis: "estimated",
  },
};

const slice = {
  schema: "munin.slice/1",
  sessionId: "session-1",
  at: "2026-10-23T10:01:00.000Z",
  watermarkMs: 1792750000000,
  events: [event],
};

test("session slice serialization round-trips without dropping event fields", () => {
  const serialized = serializeSessionSlice(slice);
  assert.deepEqual(deserializeSessionSlice(serialized), slice);
});

test("session slice serialization refuses prompt-bearing and unknown fields", () => {
  assert.throws(() => serializeSessionSlice({ ...slice, prompt: "private" }), /Privacy-sensitive/);
  assert.throws(
    () => serializeSessionSlice({ ...slice, events: [{ ...event, text: "private" }] }),
    /Privacy-sensitive/,
  );
  assert.throws(
    () => serializeSessionSlice({ ...slice, events: [{ ...event, futureField: true }] }),
    /Unexpected field/,
  );
  assert.throws(
    () =>
      serializeSessionSlice({
        ...slice,
        events: [{ ...event, tools: [{ ...event.tools[0], output: "private" }] }],
      }),
    /Privacy-sensitive/,
  );
  assert.throws(
    () =>
      serializeSessionSlice({
        ...slice,
        events: [{ ...event, tools: [{ ...event.tools[0], content: "tool result" }] }],
      }),
    /Privacy-sensitive/,
  );
  assert.throws(
    () => serializeSessionSlice({ ...slice, events: [{ ...event, message: { text: "prompt" } }] }),
    /Privacy-sensitive/,
  );
});
