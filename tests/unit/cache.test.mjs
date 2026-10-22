import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvents, cacheStats } from "@munin/core";

const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T10:01:00.000Z";
const T2 = "2026-10-20T10:02:00.000Z";
const T3 = "2026-10-20T10:03:00.000Z";
const T4 = "2026-10-20T10:04:00.000Z";
const T6 = "2026-10-20T10:06:00.000Z";
const T7 = "2026-10-20T10:07:00.000Z";

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
        timeUpdated: T7,
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
      {
        id: "s3",
        projectId: "p2",
        project: "munin",
        agent: "plan",
        schema: "v2",
        timeCreated: T6,
        timeUpdated: T7,
      },
    ],
    messages: [
      {
        id: "a1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: T1,
        agent: "build",
        usage: {
          tokens: counts({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10 }),
          observedUsd: 0.001,
        },
        stopReason: "stop",
      },
      {
        id: "c1",
        sessionId: "s1",
        seq: 1,
        type: "compaction",
        timeCreated: T2,
        usage: { tokens: counts({ input: 10, output: 2 }) },
      },
      {
        id: "a2",
        sessionId: "s1",
        seq: 2,
        type: "assistant",
        timeCreated: T3,
        usage: {
          tokens: counts({ input: 200, output: 40, cacheRead: 100 }),
          observedUsd: 0,
        },
        stopReason: "stop",
      },
      {
        id: "s2a1",
        sessionId: "s2",
        seq: 0,
        type: "assistant",
        timeCreated: T6,
        usage: { tokens: counts({ input: 5, output: 1 }) },
      },
      {
        id: "mystery",
        sessionId: "s3",
        seq: 0,
        type: "assistant",
        timeCreated: T7,
        model: { provider: "gateway", model: "mystery-model" },
        usage: { tokens: counts({ input: 1000, output: 100, cacheRead: 500 }) },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
}

function anthropicFixture() {
  return {
    schema: "v2",
    sessions: [
      {
        id: "s",
        projectId: "p",
        project: "munin",
        model: { provider: "anthropic", model: "claude-sonnet-5-5" },
        schema: "v2",
        timeCreated: T0,
        timeUpdated: T1,
      },
    ],
    messages: [
      {
        id: "m",
        sessionId: "s",
        seq: 0,
        type: "assistant",
        timeCreated: T1,
        usage: { tokens: counts({ input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }) },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
}

function usd(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected $${expected}, got $${actual} (difference ${actual - expected})`,
  );
}

function close(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${expected}, got ${actual} (difference ${actual - expected})`,
  );
}

// Anthropic's policy is known: the Sonnet 5.5 card is flat $2/$10 with no
// explicit cache rates, so reads bill at 0.1x input ($0.20/M) and 5m writes at
// 1.25x input ($2.50/M).
test("an Anthropic card bills reads at 0.1x input and 5m writes at 1.25x", () => {
  const stats = cacheStats(buildEvents(anthropicFixture()).events);

  assert.equal(stats.inputTokens, 100);
  assert.equal(stats.readTokens, 1000);
  assert.equal(stats.writeTokens, 50);
  // Phase 2 stores one write aggregate; it is the 5m TTL. The 1h price is
  // never applied because no such split exists in the source.
  assert.equal(stats.write5mTokens, 50);
  assert.equal(stats.write1hTokens, 0);
  assert.equal(stats.writesRecorded, true);

  close(stats.hitRate, 1000 / 1150);
  usd(stats.estimatedReadUsd, 0.0002);
  usd(stats.estimatedWriteUsd, 0.000125);

  // read + write is 325e-6 of the 725e-6 list-price estimate for the call.
  usd(stats.shareOfEstimate, 0.000325 / 0.000725);
});

test("zero writes and a zero input side are reported, never NaN", () => {
  const ds = fixture();
  ds.messages.find((message) => message.id === "a1").usage.tokens.cacheWrite = 0;

  const stats = cacheStats(buildEvents(ds).events);
  assert.equal(stats.writeTokens, 0);
  assert.equal(stats.writesRecorded, false);
  usd(stats.estimatedWriteUsd, 0);
  assert.ok(Number.isFinite(stats.hitRate));
  close(stats.hitRate, 650 / 1965);
  assert.equal(
    stats.byModel[0].hitRateChange === null || Number.isFinite(stats.byModel[0].hitRateChange),
    true,
  );

  const empty = buildEvents({
    schema: "v2",
    sessions: [
      {
        id: "s",
        projectId: "p",
        project: "munin",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: T0,
        timeUpdated: T0,
      },
    ],
    messages: [
      {
        id: "z",
        sessionId: "s",
        seq: 0,
        type: "assistant",
        timeCreated: T0,
        usage: { tokens: counts() },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  });
  const zeroSide = cacheStats(empty.events);
  assert.equal(zeroSide.readTokens, 0);
  assert.equal(zeroSide.hitRate, null);
  assert.equal(zeroSide.byModel[0].hitRate, null);
  assert.equal(zeroSide.byModel[0].hitRateChange, null);
});

// Exact fixture figures, derived by hand:
//   reads  = 50 (a1) + 100 (a2) + 500 (mystery) = 650
//   writes = 10 (a1), all 5m
//   estimated read cost  = 50*0.014/1e6 + 100*0.014/1e6 (mystery is unpriced)
//   estimated write cost = 10*0.15/1e6
//   list-price estimate  = 32.2e-6 + 3.3e-6 + 61.4e-6 + 1.35e-6 (unpriced is null)
test("cache costs are exact and unpriced reads cost zero but still count", () => {
  const stats = cacheStats(buildEvents(fixture()).events);
  const ds_free = fixture();

  assert.equal(stats.inputTokens, 1315);
  assert.equal(stats.readTokens, 650);
  assert.equal(stats.writeTokens, 10);
  assert.equal(stats.write5mTokens, 10);
  assert.equal(stats.write1hTokens, 0);
  assert.equal(stats.writesRecorded, true);
  close(stats.hitRate, 650 / 1975);

  usd(stats.estimatedReadUsd, (50 * 0.014 + 100 * 0.014) / 1_000_000);
  usd(stats.estimatedWriteUsd, (10 * 0.15) / 1_000_000);
  usd(stats.shareOfEstimate, 3.6e-6 / 88.65e-6);

  // Bucket sums add back to the global figures.
  for (const field of ["byModel", "byProvider", "bySession", "byDay"]) {
    assert.equal(
      stats[field].reduce((sum, row) => sum + row.readTokens, 0),
      stats.readTokens,
      field,
    );
    assert.equal(
      stats[field].reduce((sum, row) => sum + row.writeTokens, 0),
      stats.writeTokens,
      field,
    );
  }

  // The unpriced row counts its tokens; its estimated cost stays zero.
  const mystery = stats.byModel.find((row) => row.key === "gateway/mystery-model");
  assert.equal(mystery.readTokens, 500);
  usd(mystery.estimatedReadUsd, 0);
  close(mystery.hitRate, 500 / 1500);

  const gpt = stats.byModel[0];
  assert.equal(gpt.key, "ollama-cloud/gpt-oss:120b");
  assert.equal(gpt.readTokens, 150);
  close(gpt.hitRate, 150 / 475);
  usd(gpt.estimatedReadUsd, 2.1e-6);
  usd(gpt.estimatedWriteUsd, 1.5e-6);

  // deepseek-v4.1-flash-free has an explicit $0 card: reads are real traffic
  // at zero dollars — counted, priced, never "unpriced" like the mystery row.
  ds_free.messages.push({
    id: "free",
    sessionId: "s3",
    seq: 1,
    type: "assistant",
    timeCreated: T7,
    model: { provider: "opencode", model: "deepseek-v4.1-flash-free" },
    usage: { tokens: counts({ input: 10, cacheRead: 200 }) },
  });
  const freeStats = cacheStats(buildEvents(ds_free).events);
  assert.equal(freeStats.readTokens, 850);
  usd(freeStats.estimatedReadUsd, 2.1e-6);
  const free = freeStats.byModel.find((row) => row.key === "opencode/deepseek-v4.1-flash-free");
  assert.equal(free.readTokens, 200);
  usd(free.estimatedReadUsd, 0);
});

test("hit-rate change compares the later half against the earlier half", () => {
  const stats = cacheStats(buildEvents(fixture()).events);

  // s1: a1 = 50/(100+50+10) = 0.3125, c1 = 0, a2 = 100/(200+100) = 0.333...
  // The odd middle call (c1) is in neither half.
  const s1 = stats.bySession.find((row) => row.key === "s1");
  close(s1.hitRateChange, 100 / 300 - 50 / 160);

  const s2 = stats.bySession.find((row) => row.key === "s2");
  assert.equal(s2.hitRateChange, null); // one call, no halves
});

test("prefix identity groups by prefixHash, agent, model and variant", () => {
  const ds = {
    schema: "v2",
    sessions: [
      {
        id: "s1",
        projectId: "p",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: T0,
        timeUpdated: T0,
      },
      {
        id: "s2",
        projectId: "p",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: T0,
        timeUpdated: T0,
      },
      {
        id: "s3",
        projectId: "p",
        project: "munin",
        agent: "explore",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: T0,
        timeUpdated: T0,
      },
      {
        id: "s4",
        projectId: "p",
        project: "munin",
        agent: "build",
        model: { provider: "anthropic", model: "claude-sonnet-5-5" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: T0,
        timeUpdated: T0,
      },
      {
        id: "s5",
        projectId: "p",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b", variant: "high" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: T0,
        timeUpdated: T0,
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: T1,
        agent: "build",
        usage: { tokens: counts({ input: 100 }) },
      },
      {
        id: "m2",
        sessionId: "s2",
        seq: 0,
        type: "assistant",
        timeCreated: T2,
        agent: "build",
        usage: { tokens: counts({ input: 200 }) },
      },
      {
        id: "m3",
        sessionId: "s3",
        seq: 0,
        type: "assistant",
        timeCreated: T3,
        agent: "explore",
        usage: { tokens: counts({ input: 10 }) },
      },
      {
        id: "m4",
        sessionId: "s4",
        seq: 0,
        type: "assistant",
        timeCreated: T4,
        agent: "build",
        usage: { tokens: counts({ input: 20 }) },
      },
      {
        id: "m5",
        sessionId: "s5",
        seq: 0,
        type: "assistant",
        timeCreated: T6,
        agent: "build",
        usage: { tokens: counts({ input: 40 }) },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };

  const context = cacheStats(buildEvents(ds).events).instructionContext;

  // Five sessions share one instruction prefix, but only the two on the same
  // agent, model and variant share cache identity at request time.
  assert.equal(context.sessions, 5);
  assert.equal(context.totalChars, 2000);
  assert.equal(context.distinctPrefixHashes, 1);

  assert.equal(context.sharedPrefixes.length, 1);
  const shared = context.sharedPrefixes[0];
  assert.equal(shared.prefixHash, "ph-1");
  assert.equal(shared.agent, "build");
  assert.equal(shared.model, "ollama-cloud/gpt-oss:120b");
  assert.equal(shared.variant, undefined);
  assert.equal(shared.sessions, 2);
  assert.equal(shared.calls, 2);
  assert.equal(shared.uncachedInputTokens, 300);
});

test("an empty event list produces zeroed cache stats", () => {
  const stats = cacheStats([]);

  assert.equal(stats.inputTokens, 0);
  assert.equal(stats.readTokens, 0);
  assert.equal(stats.writeTokens, 0);
  assert.equal(stats.hitRate, null);
  assert.equal(stats.writesRecorded, false);
  assert.equal(stats.estimatedReadUsd, 0);
  assert.equal(stats.estimatedWriteUsd, 0);
  assert.equal(stats.shareOfEstimate, 0);
  for (const field of ["byModel", "byProvider", "bySession", "byDay"]) {
    assert.deepEqual(stats[field], []);
  }
  assert.deepEqual(stats.instructionContext, {
    sessions: 0,
    totalChars: 0,
    distinctPrefixHashes: 0,
    sharedPrefixes: [],
  });
});
