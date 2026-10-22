import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvents } from "@munin/core";

const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T10:01:00.000Z";
const T1_END = "2026-10-20T10:01:02.000Z";
const T2 = "2026-10-20T10:02:00.000Z";
const T3 = "2026-10-20T10:03:00.000Z";
const T4 = "2026-10-20T10:04:00.000Z";
const T5 = "2026-10-20T10:05:00.000Z";
const T6 = "2026-10-20T10:06:00.000Z";
const T7 = "2026-10-20T10:07:00.000Z";
const T8 = "2026-10-20T10:08:00.000Z";

function counts(overrides = {}) {
  return {
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  };
}

function fixture() {
  return {
    schema: "v2",
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b", variant: "high" },
        schema: "v2",
        timeCreated: T0,
        timeUpdated: T5,
        instructions: { keys: ["sys", "tool"], chars: 1234, prefixHash: "ph-1" },
      },
      {
        id: "s2",
        parentId: "s1",
        projectId: "p1",
        project: "munin",
        agent: "explore",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: T4,
        timeUpdated: T6,
      },
    ],
    messages: [
      { id: "u1", sessionId: "s1", seq: 0, type: "user", timeCreated: T0 },
      {
        id: "a1",
        sessionId: "s1",
        seq: 1,
        type: "assistant",
        timeCreated: T1,
        completedAt: T1_END,
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        agent: "build",
        usage: {
          tokens: counts({ input: 100, output: 20, thinking: 5, cacheRead: 50, cacheWrite: 10 }),
          observedUsd: 0.001,
        },
        stopReason: "stop",
        toolCalls: [
          {
            id: "t1",
            name: "Read",
            signature: "Read:/a.ts#0:0",
            resultChars: 40,
            target: "/a.ts",
          },
        ],
      },
      {
        id: "c1",
        sessionId: "s1",
        seq: 2,
        type: "compaction",
        timeCreated: T2,
        usage: { tokens: counts({ input: 10, output: 2, thinking: 1 }) },
      },
      { id: "u2", sessionId: "s1", seq: 3, type: "user", timeCreated: T3 },
      {
        id: "a2",
        sessionId: "s1",
        seq: 4,
        type: "assistant",
        timeCreated: T4,
        usage: {
          tokens: counts({ input: 200, output: 40, thinking: 10, cacheRead: 100 }),
          observedUsd: 0,
        },
        stopReason: "stop",
      },
      {
        id: "f1",
        sessionId: "s1",
        seq: 5,
        type: "assistant",
        timeCreated: T5,
        stopReason: "error",
        errorType: "provider.quota",
      },
      {
        id: "s2a1",
        sessionId: "s2",
        seq: 0,
        type: "assistant",
        timeCreated: T6,
        usage: { tokens: counts({ input: 5, output: 1 }) },
      },
    ],
    warnings: [{ code: "source.example", message: "kept unchanged", count: 2 }],
    sources: ["fixture"],
  };
}

function byId(events, id) {
  const event = events.find((candidate) => candidate.id === id);
  assert.ok(event, `expected event ${id}`);
  return event;
}

function usd(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected $${expected}, got $${actual} (difference ${actual - expected})`,
  );
}

test("turns, context epochs, subagent flags and parent links", () => {
  const { events } = buildEvents(fixture());

  const a1 = byId(events, "a1");
  const c1 = byId(events, "c1");
  const a2 = byId(events, "a2");
  const sub = byId(events, "s2a1");

  assert.equal(a1.contextEpoch, 0);
  // The compaction belongs to the epoch it summarises.
  assert.equal(c1.contextEpoch, 0);
  assert.equal(a2.contextEpoch, 1);
  // A subagent starts empty; its reads are not repeats of the parent.
  assert.equal(sub.contextEpoch, 0);

  assert.equal(a1.turnId, "u1");
  assert.equal(a1.turnStartedAt, T0);
  assert.equal(a2.turnId, "u2");
  assert.equal(a2.turnStartedAt, T3);
  assert.equal(sub.turnId, undefined);

  assert.equal(a1.isSubagent, false);
  assert.equal(sub.isSubagent, true);
  assert.equal(sub.parentSessionId, "s1");
  assert.equal(sub.sessionId, "s2");

  assert.equal(a1.projectId, "p1");
  assert.equal(a1.project, "munin");
  assert.equal(a1.agent, "build");
  assert.equal(sub.agent, "explore");
  assert.equal(a1.schema, "v2");
  assert.equal(a1.source, "opencode");

  // The message model wins, while the session variant fills a missing field.
  assert.equal(a1.provider, "ollama-cloud");
  assert.equal(a1.model, "gpt-oss:120b");
  assert.equal(a1.variant, "high");
});

test("priced output includes thinking, and thinking remains the reported subset", () => {
  const a1 = byId(buildEvents(fixture()).events, "a1");

  assert.equal(a1.outputTokens, 25);
  assert.equal(a1.thinkingTokens, 5);
  assert.equal(a1.cacheWrite5mTokens, 10);
  assert.equal(a1.cacheWrite1hTokens, 0);

  assert.equal(a1.cost.basis, "observed");
  assert.equal(a1.cost.observedUsd, 0.001);
  assert.equal(a1.cost.total, 0.001);

  // 100 input at $0.15/M, 25 output at $0.60/M, 50 cached at $0.014/M,
  // 10 writes at 1.0x input ($0.15/M).
  const expectedEstimate = (100 * 0.15 + 25 * 0.6 + 50 * 0.014 + 10 * 0.15) / 1_000_000;
  usd(a1.cost.estimatedUsd, expectedEstimate);
  usd(a1.cost.output, (25 * 0.6) / 1_000_000);
});

test("observed zero, estimated, and unpriced remain distinct", () => {
  const { events } = buildEvents(fixture());

  const a2 = byId(events, "a2");
  assert.equal(a2.cost.observedUsd, 0);
  assert.equal(a2.cost.basis, "observed");
  assert.equal(a2.cost.total, 0);
  assert.equal(a2.cost.unpriced, false);
  assert.ok(a2.cost.estimatedUsd > 0);

  const c1 = byId(events, "c1");
  assert.equal(c1.cost.observedUsd, null);
  assert.equal(c1.cost.basis, "estimated");
  assert.equal(c1.cost.unpriced, false);
  usd(c1.cost.total, (10 * 0.15 + 3 * 0.6) / 1_000_000);

  const ds = fixture();
  ds.messages.push({
    id: "mystery",
    sessionId: "s1",
    seq: 6,
    type: "assistant",
    timeCreated: T7,
    model: { provider: "gateway", model: "mystery-model" },
    usage: { tokens: counts({ input: 1000, output: 100 }) },
  });
  const m = byId(buildEvents(ds).events, "mystery");
  assert.equal(m.cost.unpriced, true);
  assert.equal(m.cost.total, 0);
  assert.equal(m.cost.estimatedUsd, null);
  assert.equal(m.cost.basis, "estimated");

  ds.messages[ds.messages.length - 1].usage.observedUsd = 0.25;
  const observed = byId(buildEvents(ds).events, "mystery");
  assert.equal(observed.cost.unpriced, false);
  assert.equal(observed.cost.basis, "observed");
  assert.equal(observed.cost.total, 0.25);
  assert.equal(observed.cost.estimatedUsd, null);
});

test("failed attempts are kept separately and are never billed", () => {
  const { events, attempts } = buildEvents(fixture());

  assert.equal(events.length, 4);
  assert.equal(attempts.length, 5);

  const failed = attempts.filter((attempt) => attempt.usage === undefined);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, "f1");
  assert.equal(failed[0].type, "assistant");
  assert.equal(failed[0].stopReason, "error");
  assert.equal(failed[0].errorType, "provider.quota");
  assert.equal(failed[0].observedUsd, undefined);
  assert.equal(
    events.some((event) => event.id === "f1"),
    false,
  );

  const paid = attempts.find((attempt) => attempt.id === "a1");
  assert.equal(paid.observedUsd, 0.001);
  assert.equal(paid.usage.observedUsd, 0.001);

  const compaction = attempts.find((attempt) => attempt.id === "c1");
  assert.equal(compaction.type, "compaction");
});

test("an empty dataset and a missing model fall back without throwing", () => {
  const empty = buildEvents({
    schema: "none",
    sessions: [],
    messages: [],
    warnings: [],
    sources: [],
  });

  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.attempts, []);
  assert.deepEqual(empty.window, { start: null, end: null, days: 0 });
  assert.ok(empty.warnings.some((warning) => warning.code === "analysis.no-events"));

  const missing = buildEvents({
    schema: "v2",
    sessions: [{ id: "s", projectId: "p", schema: "v2", timeCreated: T0, timeUpdated: T0 }],
    messages: [
      {
        id: "m",
        sessionId: "s",
        seq: 0,
        type: "assistant",
        timeCreated: T0,
        usage: { tokens: counts({ input: 10, output: 1 }) },
      },
    ],
    warnings: [],
    sources: [],
  });

  const event = missing.events[0];
  assert.equal(event.provider, "unknown");
  assert.equal(event.model, "unknown");
  assert.equal(event.variant, undefined);
  assert.equal(event.project, "p");
  assert.equal(event.isSubagent, false);
  assert.equal(event.cost.unpriced, true);
});

test("serialised events contain no text, prompt, summary or tool output", () => {
  const { events } = buildEvents(fixture());
  const json = JSON.stringify(events);

  const banned = new Set(["text", "prompt", "content", "summary", "state", "oldString"]);
  const found = [];

  function walk(value, path) {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        walk(value[index], `${path}[${index}]`);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (banned.has(key)) found.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
  }

  walk(events, "$");
  assert.deepEqual(found, []);

  const a1 = byId(events, "a1");
  assert.deepEqual(a1.instructionKeys, ["sys", "tool"]);
  assert.equal(a1.instructionChars, 1234);
  assert.equal(a1.prefixHash, "ph-1");
  assert.equal(a1.tools[0].signature, "Read:/a.ts#0:0");
  assert.equal(a1.tools[0].resultChars, 40);
  assert.ok(json.includes("Read:/a.ts#0:0"));
});

test("unpriced models are warned once with calls and observed spend", () => {
  const ds = fixture();
  ds.messages.push(
    {
      id: "m1",
      sessionId: "s1",
      seq: 6,
      type: "assistant",
      timeCreated: T7,
      model: { provider: "gateway", model: "mystery-model" },
      usage: { tokens: counts({ input: 100 }), observedUsd: 0.5 },
    },
    {
      id: "m2",
      sessionId: "s1",
      seq: 7,
      type: "assistant",
      timeCreated: T8,
      model: { provider: "gateway", model: "mystery-model" },
      usage: { tokens: counts({ input: 100 }) },
    },
  );

  const { warnings } = buildEvents(ds);
  const unpriced = warnings.filter((warning) => warning.code === "price.unpriced-model");

  assert.equal(unpriced.length, 1);
  assert.equal(unpriced[0].count, 2);
  assert.match(unpriced[0].message, /mystery-model/);
  assert.match(unpriced[0].message, /\$0\.5/);
  assert.ok(warnings.some((warning) => warning.code === "source.example"));
});

test("events and attempts sort by time, session and id; the window spans them", () => {
  const ds = fixture();
  ds.messages.reverse();

  const { events, attempts, window } = buildEvents(ds);

  assert.deepEqual(
    events.map((event) => event.id),
    ["a1", "c1", "a2", "s2a1"],
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.id),
    ["a1", "c1", "a2", "f1", "s2a1"],
  );

  assert.equal(window.start, T1);
  assert.equal(window.end, T6);
  assert.equal(window.days, 1);

  const spanning = fixture();
  spanning.messages.push({
    id: "later",
    sessionId: "s1",
    seq: 9,
    type: "assistant",
    timeCreated: "2026-10-22T10:00:00.000Z",
    usage: { tokens: counts({ input: 1 }) },
  });
  const multiDay = buildEvents(spanning).window;
  assert.equal(multiDay.start, T1);
  assert.equal(multiDay.end, "2026-10-22T10:00:00.000Z");
  assert.equal(
    multiDay.days,
    (Date.parse("2026-10-22T10:00:00.000Z") - Date.parse(T1)) / 86_400_000,
  );
});

test("latency is reported only when the completion is not before the start", () => {
  const ds = fixture();
  ds.messages.push({
    id: "backwards",
    sessionId: "s1",
    seq: 9,
    type: "assistant",
    timeCreated: "2026-10-20T10:10:00.000Z",
    completedAt: "2026-10-20T10:09:00.000Z",
    usage: { tokens: counts({ input: 1 }) },
  });

  const { events } = buildEvents(ds);
  assert.equal(byId(events, "a1").latencyMs, 2000);

  const backwards = byId(events, "backwards");
  assert.equal(backwards.endTs, "2026-10-20T10:09:00.000Z");
  assert.equal(backwards.latencyMs, undefined);
});

test("building events does not mutate the dataset", () => {
  const ds = fixture();
  const before = JSON.stringify(ds);

  buildEvents(ds);

  assert.equal(JSON.stringify(ds), before);
});

test("the sum of observed event cost equals the dataset's observed cost", () => {
  const ds = fixture();
  const expected = ds.messages
    .filter((message) => message.usage?.observedUsd !== undefined)
    .reduce((sum, message) => sum + message.usage.observedUsd, 0);
  const actual = buildEvents(ds).events.reduce(
    (sum, event) => sum + (event.cost.observedUsd ?? 0),
    0,
  );

  assert.equal(actual, expected);
  assert.equal(actual, 0.001);
});
