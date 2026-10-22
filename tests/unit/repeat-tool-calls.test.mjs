import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvents, detectFindings, detectRepeatToolCalls } from "@munin/core";

const MINUTE = 60_000;
function at(index) {
  return new Date(1737244800000 + index * MINUTE).toISOString(); // 2026-01-19T00:00Z, fixed epoch
}

function toolCall(id, name, signature, overrides = {}) {
  return { id, name, signature, resultChars: 240, ...overrides };
}

function counts(overrides = {}) {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, ...overrides };
}

/**
 * One session, one main context; each call's headline is
 * (1000 x $0.15/M + 100 x $0.60/M) = $0.00021 on the gpt-oss:120b card.
 */
function fixtures(calls, sessionOverrides = {}) {
  return {
    schema: "v2",
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: at(0),
        timeUpdated: at(calls.length + 1),
        ...sessionOverrides,
      },
    ],
    messages: calls.map((tools, index) => ({
      id: `a${index + 1}`,
      sessionId: "s1",
      seq: index,
      type: "assistant",
      timeCreated: at(index + 1),
      usage: { tokens: counts({ input: 1000, output: 100 }) },
      stopReason: "stop",
      toolCalls: tools,
    })),
    warnings: [],
    sources: ["fixture"],
  };
}

function detected(dataset) {
  const { findings, errors } = detectFindings(buildEvents(dataset).events, [
    { rule: "repeat-tool-calls", run: detectRepeatToolCalls },
  ]);
  assert.equal(errors.length, 0);
  return findings;
}

function usd(actual, expected, label = "usd") {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${label}: expected $${expected}, got $${actual} (difference ${actual - expected})`,
  );
}

test("a duplicate read in one context: exact tokens, exact USD, exact remaining-call factor", () => {
  const findings = detected(
    fixtures([
      // a1: first read, no duplicate.       headline $0.00021
      [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      // a2: duplicate #1 of /a.ts; 2 calls remain after it.
      [toolCall("t2", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      // a3: first read of /b.ts.
      [toolCall("t3", "Read", "Read:/b.ts#0:0", { target: "/b.ts", resultChars: 400 })],
      // a4: duplicate of /b.ts; 0 calls remain after it.
      [toolCall("t4", "Read", "Read:/b.ts#0:0", { target: "/b.ts", resultChars: 400 })],
    ]),
  );
  assert.equal(findings.length, 1);
  const finding = findings[0];
  const s = finding.savings;

  // 240 chars / 4 = 60 tokens; 400 chars / 4 = 100 tokens.
  assert.equal(s.tokensWasted, 160);
  // result tokens x (cache-write rate + remaining calls x cached rate)/1e6:
  //   a2: 60 x ($0.15/M + 2 x $0.014/M)/1e6 = 60 x $0.178/M = $0.00001068
  //   a4: 100 x ($0.15/M + 0 x $0.014/M)/1e6 = 100 x $0.15/M = $0.000015
  usd(s.windowUsd, (60 * 0.178 + 100 * 0.15) / 1_000_000, "windowUsd");
  usd(s.windowUsd, 25.68e-6, "windowUsd (same number)");
  // The affected calls are the two carrying duplicates, at $0.00021 each.
  usd(s.currentUsd, 0.00042, "currentUsd");
  usd(s.monthlyUsd, 25.68e-6 * 30, "monthlyUsd");
  assert.equal(finding.claimByEvent.size, 2);
  usd(finding.claimByEvent.get("a2"), 25.68e-6 / 2, "claim a2");
  usd(finding.claimByEvent.get("a4"), 25.68e-6 / 2, "claim a4");
  // Rate components: the card's explicit cached rate and the write multiplier.
  assert.match(s.calculation, /cache-write rate \+ remaining calls in context x cache-read rate/);
  assert.match(s.calculation, /2026-01-01 rate card/);
  // Under 10 duplicates the sample is too thin to average.
  assert.equal(s.confidence, "low");
  assert.equal(finding.affects({ id: "a2" }), true);
  assert.equal(finding.affects({ id: "a4" }), true);
  assert.equal(finding.affects({ id: "a1" }), false);
  assert.equal(finding.affects({ id: "a3" }), false);
  assert.match(finding.observations[0], /^Read:\/b\.ts#0:0:/);
  assert.equal(finding.severity, "low");
});

test("a read after an edit, after a compaction, or by a subagent is not a repeat", () => {
  // An edit to /a.ts retires only reads of /a.ts; the NEXT read of /a.ts is
  // fresh, and the one after it is a plain duplicate again.
  const afterEdit = detected(
    fixtures([
      [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      [{ ...toolCall("t2", "Edit", "Edit:/a.ts#abcd1234", { target: "/a.ts" }), resultChars: 0 }],
      [toolCall("t3", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      [toolCall("t4", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
    ]),
  );
  assert.equal(afterEdit.length, 1);
  usd(afterEdit[0].savings.windowUsd, (60 * 0.15) / 1_000_000, "dup after edit");
  assert.equal(afterEdit[0].savings.tokensWasted, 60);
  assert.deepEqual(afterEdit[0].claimByEvent.has("a2"), false);
  assert.equal(afterEdit[0].claimByEvent.has("a4"), true);

  // A read after a compaction is a fresh context, not a repeat.
  const afterCompaction = fixtures([
    [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
    [],
    [toolCall("t3", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
  ]);
  afterCompaction.messages.splice(1, 0, {
    id: "c1",
    sessionId: "s1",
    seq: 1,
    type: "compaction",
    timeCreated: at(2),
    usage: { tokens: counts({ input: 10, output: 2 }) },
  });
  assert.deepEqual(detected(afterCompaction), []);

  // A subagent starts empty: its read is not a repeat of the main session's.
  const bothRead = {
    schema: "v2",
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        agent: "build",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: at(0),
        timeUpdated: at(2),
      },
      {
        id: "sub1",
        parentId: "s1",
        projectId: "p1",
        project: "munin",
        agent: "explore",
        model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
        schema: "v2",
        timeCreated: at(1),
        timeUpdated: at(2),
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: at(1),
        usage: { tokens: counts({ input: 1000, output: 100 }) },
        stopReason: "stop",
        toolCalls: [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts" })],
      },
      {
        id: "m2",
        sessionId: "sub1",
        seq: 0,
        type: "assistant",
        timeCreated: at(2),
        usage: { tokens: counts({ input: 1000, output: 100 }) },
        stopReason: "stop",
        toolCalls: [toolCall("t2", "Read", "Read:/a.ts#0:0", { target: "/a.ts" })],
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
  assert.deepEqual(detected(bothRead), []);
});

test("an errored read is not counted; an unknown tool retires reads; bash retires searches, not reads", () => {
  // An errored mutation must not retire anything (the file's state is unknown),
  // so the later read is still a duplicate of the first.
  const erroredMutation = detected(
    fixtures([
      [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      [
        {
          ...toolCall("t2", "Edit", "Edit:/a.ts#bad", { target: "/a.ts", isError: true }),
          resultChars: 0,
        },
      ],
      [toolCall("t3", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
    ]),
  );
  assert.equal(erroredMutation.length, 1);
  usd(erroredMutation[0].savings.windowUsd, (60 * 0.15) / 1_000_000, "dup survives errored edit");
  assert.equal(erroredMutation[0].savings.tokensWasted, 60);

  // An errored read carried no content, so it is not a duplicate either.
  const erroredRead = detected(
    fixtures([
      [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      [
        toolCall("t2", "Read", "Read:/a.ts#0:0", {
          target: "/a.ts",
          resultChars: 240,
          isError: true,
        }),
      ],
    ]),
  );
  assert.deepEqual(erroredRead, []);

  // An unknown tool name is mutating: the following read of /a.ts is fresh.
  const unknownRetires = detected(
    fixtures([
      [toolCall("t1", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
      [toolCall("t2", "Frobnicate", "Frobnicate:whatever")],
      [toolCall("t3", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 })],
    ]),
  );
  assert.deepEqual(unknownRetires, []);

  // Bash retires searches as a class, but never file reads: the second Grep is
  // fresh while the repeated Read is still a duplicate.
  const bashRetires = detected(
    fixtures([
      [toolCall("t1", "Grep", "Grep:x#", { resultChars: 400 })],
      [toolCall("t2", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 400 })],
      [{ ...toolCall("t3", "Bash", "Bash:rm x", {}), resultChars: 0 }],
      [toolCall("t4", "Grep", "Grep:x#", { resultChars: 400 })],
      [toolCall("t5", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 400 })],
    ]),
  );
  assert.equal(bashRetires.length, 1);
  assert.equal(bashRetires[0].savings.tokensWasted, 100); // 400 chars / 4, the a5 Read only
  usd(bashRetires[0].savings.windowUsd, (100 * 0.15) / 1_000_000, "only the read repeated");
  assert.equal(bashRetires[0].claimByEvent.has("a5"), true);
  assert.equal(bashRetires[0].claimByEvent.has("a4"), false);
});

test("a $0 card yields token-only; an unpriced card yields unpriced: true", () => {
  // deepseek-v4.1-flash-free has an explicit $0 card: the duplicate is counted,
  // nothing is billed, and the finding is priced (at zero), never "unpriced".
  const freeCard = {
    schema: "v2",
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        project: "munin",
        model: { provider: "opencode", model: "deepseek-v4.1-flash-free" },
        schema: "v2",
        timeCreated: at(0),
        timeUpdated: at(2),
      },
    ],
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        seq: 0,
        type: "assistant",
        timeCreated: at(1),
        usage: { tokens: counts({ input: 500, output: 50 }) },
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
        usage: { tokens: counts({ input: 500, output: 50 }) },
        toolCalls: [
          toolCall("t2", "Read", "Read:/a.ts#0:0", { target: "/a.ts", resultChars: 240 }),
        ],
      },
    ],
    warnings: [],
    sources: ["fixture"],
  };
  const free = detected(freeCard);
  assert.equal(free.length, 1);
  assert.equal(free[0].savings.tokensWasted, 60);
  usd(free[0].savings.windowUsd, 0, "free card window");
  assert.equal(free[0].savings.unpriced, false);
  assert.equal(free[0].claimByEvent.size, 0);

  // No card at all: dollars are withheld, tokens stand, unpriced is true.
  const unpriced = { ...freeCard };
  unpriced.sessions = [
    { ...freeCard.sessions[0], model: { provider: "gateway", model: "mystery-model" } },
  ];
  const [ghost] = detected(unpriced);
  assert.equal(ghost.savings.tokensWasted, 60);
  usd(ghost.savings.windowUsd, 0, "unpriced window");
  assert.equal(ghost.savings.unpriced, true);
  assert.equal(ghost.savings.assumptions.length, 4);
  assert.match(ghost.savings.assumptions[3], /reported in tokens only/);
});
