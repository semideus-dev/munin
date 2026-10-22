import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildReport, buildEvents, detectFindings, DETECTORS } from "@munin/core";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
function at(index, day = 0) {
  return new Date(1737244800000 + day * DAY + index * MINUTE).toISOString(); // 2026-01-19T00:00Z
}

function toolCall(id, name, signature, overrides = {}) {
  return { id, name, signature, resultChars: 240, ...overrides };
}

/**
 * Three calls sharing one context on the gpt-oss card, plus one observed call
 * on a cardless model, an unpriced call, a failed attempt, a compaction, and a
 * subagent. Enough to populate every report section with real, checkable
 * shapes.
 */
function fixture() {
  return {
    schema: "v2",
    sources: ["opencode.db", "assets/sessions"],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: at(0),
        timeUpdated: at(5),
      },
      {
        id: "s2",
        projectId: "p1",
        project: "munin",
        model: { provider: "gateway", model: "mystery-model" },
        schema: "v2",
        timeCreated: at(10),
        timeUpdated: at(14),
      },
      {
        id: "s3",
        projectId: "p1",
        project: "munin",
        model: { provider: "gateway", model: "mystery-model" },
        schema: "v2",
        timeCreated: at(0, 1),
        timeUpdated: at(1, 1),
      },
      {
        id: "s4",
        parentId: "s1",
        projectId: "p1",
        project: "munin",
        agent: "explore",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        instructions: { keys: ["sys"], chars: 400, prefixHash: "ph-1" },
        timeCreated: at(16),
        timeUpdated: at(17),
      },
    ],
    messages: [
      // s1: one context, a duplicate Read on m2 (/a.ts) and m4 (/b.ts).
      {
        id: "m1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: at(1),
        agent: "build",
        usage: { tokens: { input: 1000, output: 100, thinking: 20, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
        toolCalls: [
          toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 }),
        ],
      },
      {
        id: "m2",
        sessionId: "s1",
        seq: 1,
        type: "assistant",
        timeCreated: at(2),
        agent: "build",
        usage: { tokens: { input: 1000, output: 100, thinking: 20, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
        toolCalls: [
          toolCall("t2", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 }),
        ],
      },
      {
        id: "m3",
        sessionId: "s1",
        seq: 2,
        type: "assistant",
        timeCreated: at(3),
        agent: "build",
        usage: { tokens: { input: 1000, output: 100, thinking: 20, cacheRead: 0, cacheWrite: 10 } },
        stopReason: "stop",
        toolCalls: [
          toolCall("t3", "Read", "Read:/b.ts#0:0", { target: "/b.ts", resultChars: 400 }),
        ],
      },
      {
        id: "m4",
        sessionId: "s1",
        seq: 3,
        type: "assistant",
        timeCreated: at(4),
        agent: "build",
        usage: { tokens: { input: 1000, output: 100, thinking: 20, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
        toolCalls: [
          toolCall("t4", "Read", "Read:/b.ts#0:0", { target: "/b.ts", resultChars: 400 }),
        ],
      },
      // s2: a compaction, an observed charge on a cardless model, and a failure.
      {
        id: "c1",
        sessionId: "s2",
        seq: 0,
        type: "compaction",
        timeCreated: at(11),
        usage: { tokens: { input: 10, output: 2, thinking: 0, cacheRead: 0, cacheWrite: 0 } },
      },
      {
        id: "m5",
        sessionId: "s2",
        seq: 1,
        type: "assistant",
        timeCreated: at(12),
        usage: {
          tokens: { input: 800, output: 40, thinking: 0, cacheRead: 0, cacheWrite: 0 },
          observedUsd: 0.1133,
        },
        stopReason: "stop",
      },
      {
        id: "m6",
        sessionId: "s2",
        seq: 2,
        type: "assistant",
        timeCreated: at(13),
        errorType: "provider.quota",
        stopReason: "error",
      },
      // s2's next day: an unpriced call and one plain message.
      {
        id: "m7",
        sessionId: "s3",
        seq: 0,
        type: "user",
        timeCreated: at(0, 1),
      },
      {
        id: "m8",
        sessionId: "s3",
        seq: 1,
        type: "assistant",
        timeCreated: at(1, 1),
        usage: { tokens: { input: 500, output: 60, thinking: 10, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
      },
      // s4: a subagent call, fresh context on the same prefix.
      {
        id: "m9",
        sessionId: "s4",
        seq: 0,
        type: "assistant",
        timeCreated: at(17),
        agent: "explore",
        usage: { tokens: { input: 200, output: 10, thinking: 0, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
        toolCalls: [
          toolCall("t5", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 }),
        ],
      },
    ],
    warnings: [],
  };
}

const SNAPSHOT = new URL("./snapshots/report.test.mjs.json", import.meta.url);

test("a fixture report matches the stored snapshot byte for byte", () => {
  const first = JSON.stringify(buildReport(fixture(), { zone: "UTC" }), null, 2);
  const second = JSON.stringify(buildReport(fixture(), { zone: "UTC" }), null, 2);
  assert.equal(first, second, "two builds must produce byte-identical output");

  if (process.env.MUNIN_WRITE_SNAPSHOT === "1") {
    fs.writeFileSync(SNAPSHOT, `${first}\n`);
    return;
  }
  const stored = fs.readFileSync(SNAPSHOT, "utf8");
  if (first !== stored.replace(/\n$/, "")) {
    const at_ = [...stored].findIndex((char, i) => char !== first[i]);
    assert.equal(
      first,
      stored,
      `snapshot mismatch at char ${at_}: ${first.slice(Math.max(0, at_ - 80), at_ + 80)}`,
    );
  }
});

test("bucket and session sums reconcile to the totals", () => {
  const report = buildReport(fixture());
  const totals = report.totals;

  for (const field of ["byModel", "byProvider", "byProject", "byDay", "bySession", "byAgent"]) {
    const sum = (key) => report[field].reduce((acc, row) => acc + row[key], 0);
    assert.equal(sum("calls"), totals.calls, `${field} calls`);
    assert.equal(sum("inputTokens"), totals.inputTokens, `${field} inputTokens`);
    assert.equal(sum("totalTokens"), totals.totalTokens, `${field} totalTokens`);
    assert.equal(sum("cacheWriteTokens"), totals.cacheWriteTokens, `${field} cacheWriteTokens`);
    assert.ok(Math.abs(sum("headlineUsd") - totals.headlineUsd) < 1e-9, `${field} headlineUsd`);
    assert.ok(Math.abs(sum("observedUsd") - totals.observedUsd) < 1e-9, `${field} observedUsd`);
  }

  // Session rows are not rolled up: they add back to the totals exactly once.
  const sessionCalls = report.sessions.reduce((acc, s) => acc + s.calls, 0);
  const sessionTokens = report.sessions.reduce((acc, s) => acc + s.totalTokens, 0);
  const sessionUsd = report.sessions.reduce((acc, s) => acc + s.headlineUsd, 0);
  assert.equal(sessionCalls, totals.calls);
  assert.equal(sessionTokens, totals.totalTokens);
  assert.ok(Math.abs(sessionUsd - totals.headlineUsd) < 1e-9);

  // Priced calls plus unpriced calls equals the total call count.
  const dataset = fixture();
  const events = buildEvents(dataset).events;
  const estimated = events.filter((e) => e.cost.basis === "estimated").length;
  const observed = events.filter((e) => e.cost.basis === "observed").length;
  assert.equal(estimated + observed, totals.calls);
  assert.equal(totals.calls, events.length);
  // The one observed charge is the cardless model's call; the rest estimate.
  assert.equal(observed, 1);
  assert.equal(totals.observedCoverage, 1 / events.length);
});

test("findings in the report equal the detector output, claims serialised", () => {
  const dataset = fixture();
  const report = buildReport(dataset);
  const { findings, errors } = detectFindings(buildEvents(dataset).events, DETECTORS);
  assert.equal(errors.length, 0);
  assert.equal(report.findings.length, findings.length);
  assert.equal(report.findings.length, 1, "the fixture triggers exactly the repeat-read rule");

  for (const [index, finding] of findings.entries()) {
    const row = report.findings[index];
    for (const key of ["rule", "category", "title", "tier", "severity", "verification"]) {
      assert.equal(row[key], finding[key], `${key} of ${finding.rule}`);
    }
    assert.deepEqual(row.savings, finding.savings);
    assert.deepEqual(row.affected, finding.affected);

    const claimed = [...finding.claimByEvent.keys()];
    assert.deepEqual(row.claimByEvent.map((c) => c.eventId).sort(), [...claimed].sort());
    for (const claim of row.claimByEvent) {
      assert.equal(
        claim.usd,
        finding.claimByEvent.get(claim.eventId),
        `claim for ${claim.eventId}`,
      );
    }
    // Sorted by usd descending, then event id.
    for (let i = 1; i < row.claimByEvent.length; i += 1) {
      const prev = row.claimByEvent[i - 1];
      const cur = row.claimByEvent[i];
      assert.ok(prev.usd > cur.usd || (prev.usd === cur.usd && prev.eventId < cur.eventId));
    }
  }

  // The de-overlapped savings reflect the one fix finding.
  assert.ok(Math.abs(report.savings.fix.windowUsd - findings[0].savings.windowUsd) < 1e-12);
  assert.equal(report.savings.try.claimedCalls, 0);
  assert.equal(report.savings.pricedTokensWasted, findings[0].savings.tokensWasted);
  assert.equal(report.savings.unpricedFindings, 0);
});

/** Fail on anything non-serialisable, before stringify can silently drop it. */
function assertPlain(value, path = "$") {
  if (value === null || typeof value !== "object") {
    assert.ok(typeof value !== "function", `function at ${path}`);
    assert.ok(
      !(value instanceof Map || value instanceof Set || value instanceof Date),
      `non-plain at ${path}`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPlain(item, `${path}[${i}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assert.ok(
      !(item instanceof Map || item instanceof Set || item instanceof Date),
      `non-plain at ${path}.${key}`,
    );
    assert.ok(typeof item !== "function", `function at ${path}.${key}`);
    assertPlain(item, `${path}.${key}`);
  }
}

test("the report serialises to JSON with no functions, maps, dates, or locale strings", () => {
  const report = buildReport(fixture());
  assertPlain(report);
  const json = JSON.stringify(report);
  const reparsed = JSON.parse(json);
  assert.equal(JSON.stringify(reparsed), json, "round trip is idempotent");
  assert.ok(!json.includes("[object"));
  assert.ok(!json.includes("undefined"));
  assert.ok(!json.includes("NaN"));
  assert.ok(!json.includes("Infinity"));
});

test("an empty dataset produces a valid report with analysis.no-events", () => {
  const empty = { schema: "none", sessions: [], messages: [], warnings: [], sources: [] };
  const report = buildReport(empty);

  assert.equal(report.formatVersion, 1);
  assert.deepEqual(report.window, { start: null, end: null, days: 0 });
  assert.equal(report.totals.calls, 0);
  assert.equal(
    report.dataHealth.warnings.some((w) => w.code === "analysis.no-events"),
    true,
  );
  assert.deepEqual(report.findings, []);
  assert.equal(report.savings.fix.windowUsd, 0);
  assert.equal(report.savings.all.monthlyUsd, 0);
  assert.equal(report.savings.tokensWasted, 0);
  assert.equal(report.dataHealth.sessions, 0);
  assert.equal(report.dataHealth.modelCalls, 0);
  assert.equal(report.dataHealth.observedCoverage, null);
  assert.deepEqual(report.dataHealth.detectorErrors, []);
  assert.deepEqual(report.dataHealth.projectLabelCollisions, []);
  assert.equal(report.bySession.length, 0);
  assert.equal(JSON.stringify(report).includes("undefined"), false);
});
