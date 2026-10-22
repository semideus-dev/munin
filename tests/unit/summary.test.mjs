import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvents,
  dayKey,
  projectCollisions,
  projectCollisionWarnings,
  sessionSummaries,
  summarize,
  topCalls,
} from "@munin/core";

const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T10:01:00.000Z";
const T1_END = "2026-10-20T10:01:02.000Z";
const T2 = "2026-10-20T10:02:00.000Z";
const T3 = "2026-10-20T10:03:00.000Z";
const T4 = "2026-10-20T10:04:00.000Z";
const T5 = "2026-10-20T10:05:00.000Z";
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
        title: "Main",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b", variant: "high" },
        schema: "v2",
        timeCreated: T0,
        timeUpdated: T7,
        instructions: { keys: ["sys", "tool"], chars: 1234, prefixHash: "ph-1" },
      },
      {
        id: "s2",
        parentId: "s1",
        projectId: "p1",
        project: "munin",
        title: "Explore",
        agent: "explore",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: T5,
        timeUpdated: T6,
      },
      {
        id: "s3",
        projectId: "p2",
        project: "munin",
        title: "Other",
        agent: "plan",
        schema: "v2",
        timeCreated: T6,
        timeUpdated: T7,
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
        usage: { tokens: counts({ input: 1000, output: 100 }) },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
}

function zoneFixture() {
  return {
    schema: "v2",
    sessions: [
      {
        id: "s",
        projectId: "p",
        project: "munin",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: "2026-03-08T03:00:00.000Z",
        timeUpdated: "2026-03-08T08:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s",
        seq: 0,
        type: "assistant",
        timeCreated: "2026-03-08T03:59:00.000Z",
        usage: { tokens: counts({ input: 10 }) },
      },
      {
        id: "m2",
        sessionId: "s",
        seq: 1,
        type: "assistant",
        timeCreated: "2026-03-08T07:30:00.000Z",
        usage: { tokens: counts({ input: 20 }) },
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
}

function zeroUsageFixture() {
  return {
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

function sum(buckets, field) {
  return buckets.reduce((total, bucket) => total + bucket[field], 0);
}

// Exact fixture totals, derived by hand:
//   observed  = 0.001
//   estimated = 32.2e-6 (a1) + 3.3e-6 (c1) + 61.4e-6 (a2) + 1.35e-6 (sub)
//   headline  = 0.001 + 32.2e-6 + 0 + 1.35e-6 + 0 (mystery is unpriced)
test("fixture totals are exact", () => {
  const { events } = buildEvents(fixture());
  const { totals } = summarize(events);

  assert.equal(totals.calls, 5);
  assert.equal(totals.sessions, 3);
  assert.equal(totals.turns, 2);
  assert.equal(totals.subagentSessions, 1);

  assert.equal(totals.inputTokens, 1315);
  assert.equal(totals.outputTokens, 179);
  assert.equal(totals.thinkingTokens, 16);
  assert.equal(totals.cacheReadTokens, 150);
  assert.equal(totals.cacheWriteTokens, 10);
  assert.equal(totals.totalTokens, 1654);

  usd(totals.observedUsd, 0.001);
  usd(totals.estimatedUsd, (32.2 + 3.3 + 61.4 + 1.35) / 1_000_000);
  usd(totals.headlineUsd, 0.00100465);

  assert.equal(totals.unpricedCalls, 1);
  assert.deepEqual(totals.unpricedModels, ["mystery-model"]);
  close(totals.observedCoverage, 2 / 5);

  close(totals.cacheHitRate, 150 / 1475);
  close(totals.thinkingShare, 16 / 179);
  close(totals.avgTokensPerCall, 1654 / 5);
  usd(totals.avgCostPerCall, 0.00100465 / 5);
});

test("every bucket adds back to the totals", () => {
  const { events } = buildEvents(fixture());
  const summary = summarize(events);
  const { totals } = summary;

  for (const field of ["byModel", "byProvider", "byProject", "byDay", "bySession", "byAgent"]) {
    assert.equal(sum(summary[field], "calls"), totals.calls, field);
    assert.equal(sum(summary[field], "totalTokens"), totals.totalTokens, field);
    assert.equal(sum(summary[field], "inputTokens"), totals.inputTokens, field);
  }

  usd(sum(summary.bySession, "headlineUsd"), 0.00100465);
  usd(sum(summary.byModel, "estimatedUsd"), totals.estimatedUsd);
  usd(sum(summary.byProject, "observedUsd"), totals.observedUsd);
  // Model calls partition the event count.
  assert.equal(sum(summary.byModel, "calls"), events.length);
});

test("buckets rank by spend with the details attached", () => {
  const { events } = buildEvents(fixture());
  const summary = summarize(events);

  const [gpt, mystery] = summary.byModel;
  assert.equal(gpt.key, "ollama-cloud/gpt-oss:120b");
  assert.equal(gpt.calls, 4);
  assert.deepEqual(gpt.models, ["gpt-oss:120b"]);
  assert.deepEqual(gpt.providers, ["ollama-cloud"]);
  close(gpt.cacheHitRate, 150 / 475);
  usd(gpt.headlineUsd, 0.00100465);
  assert.equal(gpt.unpriced, false);
  assert.ok(gpt.spendShare > 0);

  assert.equal(mystery.key, "gateway/mystery-model");
  assert.equal(mystery.calls, 1);
  assert.equal(mystery.totalTokens, 1100);
  assert.equal(mystery.observedUsd, 0);
  assert.equal(mystery.estimatedUsd, 0);
  assert.equal(mystery.headlineUsd, 0);
  assert.equal(mystery.spendShare, 0);
  // Zero reads on a nonzero input side is a real zero, not a NaN.
  assert.equal(mystery.cacheHitRate, 0);
  assert.equal(mystery.unpriced, true);

  const [p1, p2] = summary.byProject;
  assert.equal(p1.key, "p1");
  assert.equal(p1.label, "munin");
  assert.equal(p1.calls, 4);
  assert.equal(p2.key, "p2");
  assert.equal(p2.label, "munin");
  assert.equal(p2.calls, 1);
  assert.equal(p2.unpriced, true);

  assert.deepEqual(
    summary.byProvider.map((bucket) => bucket.key),
    ["ollama-cloud", "gateway"],
  );
  assert.deepEqual(
    summary.byAgent.map((bucket) => bucket.key),
    ["build", "explore", "plan"],
  );
  assert.equal(summary.byAgent[0].calls, 3);
  usd(summary.byAgent[1].headlineUsd, 1.35e-6);
  assert.equal(summary.byAgent[2].headlineUsd, 0);

  assert.deepEqual(
    summary.bySession.map((bucket) => bucket.key),
    ["s1", "s2", "s3"],
  );
  usd(summary.bySession[0].headlineUsd, 0.0010033);
  usd(summary.bySession[1].headlineUsd, 1.35e-6);
});

test("subagent sessions are counted once and stay flagged", () => {
  const { events } = buildEvents(fixture());
  const summary = summarize(events);

  assert.equal(summary.totals.sessions, 3);
  assert.equal(summary.totals.subagentSessions, 1);
  assert.equal(summary.bySession.length, 3);
  // The three sessions partition the five calls; nothing is double counted.
  assert.equal(sum(summary.bySession, "calls"), summary.totals.calls);

  const summaries = sessionSummaries(events);
  const sub = summaries.find((entry) => entry.id === "s2");
  assert.equal(sub.isSubagent, true);
  assert.equal(sub.parentSessionId, "s1");
  assert.equal(sub.calls, 1);

  const parent = summaries.find((entry) => entry.id === "s1");
  assert.equal(parent.isSubagent, false);
  assert.equal(parent.parentSessionId, undefined);
  assert.equal(parent.calls, 3);
});

test("cache hit rate stays finite when no writes are recorded", () => {
  const ds = fixture();
  ds.messages.find((message) => message.id === "a1").usage.tokens.cacheWrite = 0;

  const summary = summarize(buildEvents(ds).events);
  assert.equal(summary.totals.cacheWriteTokens, 0);
  assert.ok(Number.isFinite(summary.totals.cacheHitRate));
  close(summary.totals.cacheHitRate, 150 / 1465);
});

test("a call with no input side reports a null hit rate, not a NaN", () => {
  const summary = summarize(buildEvents(zeroUsageFixture()).events);
  assert.equal(summary.totals.cacheHitRate, null);
  assert.equal(summary.totals.thinkingShare, null);
  assert.equal(summary.byModel[0].cacheHitRate, null);
});

test("unpriced calls stay out of the estimate but inside the observed and headline sums", () => {
  const summary = summarize(buildEvents(fixture()).events);

  // The list-price estimate excludes the call with no card.
  usd(summary.totals.estimatedUsd, (32.2 + 3.3 + 61.4 + 1.35) / 1_000_000);
  assert.equal(summary.byModel[1].estimatedUsd, 0);

  // Observed and headline sums cover every call; the unpriced call contributes
  // its zero observed charge rather than being dropped from the population.
  usd(summary.totals.observedUsd, 0.001);
  usd(summary.totals.headlineUsd, 0.00100465);
  assert.equal(summary.totals.calls, summary.totals.unpricedCalls + 4);

  // An unpriced model that carries an observed charge reports that charge.
  const ds = fixture();
  ds.messages.find((message) => message.id === "mystery").usage.observedUsd = 0.25;
  const observed = summarize(buildEvents(ds).events);
  usd(observed.totals.observedUsd, 0.251);
  usd(observed.totals.headlineUsd, 0.25100465);
  usd(observed.totals.estimatedUsd, (32.2 + 3.3 + 61.4 + 1.35) / 1_000_000);
});

test("a project label spread over two ids is reported once, with the ids", () => {
  const events = buildEvents(fixture()).events;

  assert.deepEqual(projectCollisions(events), [{ label: "munin", projectIds: ["p1", "p2"] }]);

  const warnings = projectCollisionWarnings(events);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "analysis.project-label-collision");
  assert.match(warnings[0].message, /munin/);
  assert.match(warnings[0].message, /p1, p2/);
});

test("session summaries carry source metadata and roll nothing up", () => {
  const { events, attempts } = buildEvents(fixture());
  const summaries = sessionSummaries(events, fixture().sessions, attempts);

  const s1 = summaries.find((entry) => entry.id === "s1");
  assert.equal(s1.title, "Main");
  assert.equal(s1.projectId, "p1");
  assert.equal(s1.project, "munin");
  assert.deepEqual(s1.agents, ["build"]);
  assert.deepEqual(s1.models, ["ollama-cloud/gpt-oss:120b"]);
  assert.equal(s1.firstTs, T1);
  assert.equal(s1.lastTs, T4);
  assert.equal(s1.calls, 3);
  assert.equal(s1.turns, 2);
  assert.equal(s1.compactions, 1);
  assert.equal(s1.inputTokens, 310);
  assert.equal(s1.outputTokens, 78);
  assert.equal(s1.thinkingTokens, 16);
  assert.equal(s1.cacheReadTokens, 150);
  assert.equal(s1.cacheWriteTokens, 10);
  assert.equal(s1.totalTokens, 548);
  usd(s1.estimatedUsd, 96.9e-6);
  usd(s1.observedUsd, 0.001);
  usd(s1.headlineUsd, 0.0010033);
  close(s1.cacheHitRate, 150 / 470);
  close(s1.observedCoverage, 2 / 3);

  const s2 = summaries.find((entry) => entry.id === "s2");
  assert.equal(s2.compactions, 0);
  assert.equal(s2.turns, 0);
  usd(s2.headlineUsd, 1.35e-6);
  assert.equal(s2.observedCoverage, 0);

  const s3 = summaries.find((entry) => entry.id === "s3");
  assert.equal(s3.unpriced, true);
  assert.equal(s3.totalTokens, 1100);

  assert.deepEqual(
    summaries.map((entry) => entry.id),
    ["s1", "s2", "s3"],
  );
  usd(
    summaries.reduce((acc, entry) => acc + entry.headlineUsd, 0),
    0.00100465,
  );

  // Without attempts the compaction count falls back to the last context epoch.
  const fallback = sessionSummaries(events, fixture().sessions);
  assert.equal(fallback.find((entry) => entry.id === "s1").compactions, 1);
});

test("day bucketing honours UTC, offset zones and DST", () => {
  const events = buildEvents(zoneFixture()).events;

  assert.deepEqual(
    summarize(events).byDay.map((bucket) => bucket.key),
    ["2026-03-08"],
  );

  // 03:59Z is 22:59 EST on Mar 7; 07:30Z is 03:30 EDT on Mar 8, across the
  // spring-forward gap. Slicing the ISO string would merge the two days.
  const newYork = summarize(events, { zone: "America/New_York" });
  assert.deepEqual(
    newYork.byDay.map((bucket) => bucket.key),
    ["2026-03-08", "2026-03-07"],
  );
  assert.equal(newYork.byDay[0].calls, 1);
  assert.equal(newYork.byDay[1].calls, 1);

  assert.equal(dayKey("2026-10-20T12:00:00.000Z", "Pacific/Auckland"), "2026-10-21");
  assert.equal(dayKey("2026-10-20T18:30:00.000Z", "Asia/Kolkata"), "2026-10-21");
  assert.match(dayKey("2026-10-20T12:00:00.000Z", "local"), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayKey("not-a-date"), "unknown");
});

test("top calls rank by headline cost and by tokens with stable ties", () => {
  const events = buildEvents(fixture()).events;

  const top = topCalls(events, 2);
  assert.deepEqual(
    top.byCost.map((event) => event.id),
    ["a1", "c1"],
  );
  assert.deepEqual(
    top.byTokens.map((event) => event.id),
    ["mystery", "a2"],
  );

  const all = topCalls(events, 5);
  assert.deepEqual(
    all.byCost.map((event) => event.id),
    ["a1", "c1", "s2a1", "a2", "mystery"],
  );
  assert.deepEqual(
    all.byTokens.map((event) => event.id),
    ["mystery", "a2", "a1", "c1", "s2a1"],
  );
});

test("an empty event list produces a zeroed summary", () => {
  const summary = summarize([]);
  const totals = summary.totals;

  assert.equal(totals.calls, 0);
  assert.equal(totals.sessions, 0);
  assert.equal(totals.turns, 0);
  assert.equal(totals.subagentSessions, 0);
  assert.equal(totals.avgTokensPerCall, 0);
  assert.equal(totals.avgCostPerCall, 0);
  assert.equal(totals.observedCoverage, null);
  assert.equal(totals.cacheHitRate, null);
  assert.equal(totals.thinkingShare, null);

  for (const field of ["byModel", "byProvider", "byProject", "byDay", "bySession", "byAgent"]) {
    assert.deepEqual(summary[field], []);
  }
});
