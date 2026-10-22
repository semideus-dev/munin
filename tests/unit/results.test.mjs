import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appliedChangesFromJournal,
  BASELINE_MAX_DAYS,
  BASELINE_MIN_DAYS,
  measureResults,
  resultsDays,
} from "@munin/core";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-23T00:00:00.000Z");
const appliedAt = NOW - 3 * DAY;

function event(ts, index, cost, turn = true) {
  return {
    ts: new Date(ts).toISOString(),
    sessionId: `s-${Math.floor(index / 10)}`,
    turnId: turn ? `t-${index}` : undefined,
    isSubagent: false,
    cost: { total: cost },
  };
}

function steadyEvents() {
  const events = [];
  let index = 0;
  for (const day of [-13, -7, -2]) {
    for (let count = 0; count < 20; count += 1) {
      events.push(event(appliedAt + day * DAY, index++, 0.01));
    }
  }
  for (const day of [0, 1, 2]) {
    for (let count = 0; count < 34; count += 1) {
      events.push(event(appliedAt + day * DAY + 1000, index++, 0.005));
    }
  }
  return events;
}

test("results use bounded before/after periods and report baseline sensitivity", () => {
  assert.equal(BASELINE_MIN_DAYS, 14);
  assert.equal(BASELINE_MAX_DAYS, 30);
  const changes = [{ id: "change-1", rule: "model-choice", at: new Date(appliedAt).toISOString() }];
  const report = measureResults({ events: steadyEvents() }, changes, { now: NOW });
  assert.equal(report.results[0].verdict, "working");
  assert.equal(report.results[0].measure, "turn");
  assert.equal(report.results[0].range !== null, true);
  assert.equal(report.results[0].before.days, BASELINE_MIN_DAYS);
  assert.equal(report.results[0].after.activeDays, 3);
  assert.equal(
    report.results[0].rows.some((row) => row.key === "callsPerTurn" && row.tradeOff),
    true,
  );
});

test("the result verdict uses the change threshold for no-change and worse", () => {
  const change = { id: "threshold", rule: "model-choice", at: new Date(appliedAt).toISOString() };
  const events = steadyEvents();
  const unchanged = events.map((row) =>
    Date.parse(row.ts) >= appliedAt ? { ...row, cost: { total: 0.01 } } : row,
  );
  const worse = events.map((row) =>
    Date.parse(row.ts) >= appliedAt ? { ...row, cost: { total: 0.02 } } : row,
  );
  assert.equal(
    measureResults({ events: unchanged }, [change], { now: NOW }).results[0].verdict,
    "no-change",
  );
  assert.equal(
    measureResults({ events: worse }, [change], { now: NOW }).results[0].verdict,
    "worse",
  );
});

test("results distinguish too-early from no-baseline and bound requested history", () => {
  const change = { id: "change-2", rule: "model-choice", at: new Date(appliedAt).toISOString() };
  const tooEarly = measureResults(
    { events: [event(NOW - DAY, 1, 0.01), event(NOW - 2 * DAY, 2, 0.01)] },
    [change],
    { now: NOW },
  );
  assert.equal(tooEarly.results[0].verdict, "too-early");

  const afterOnly = [];
  for (const day of [0, 1, 2]) {
    for (let i = 0; i < 100; i += 1)
      afterOnly.push(event(appliedAt + day * DAY + 1000, i + day * -100, 0.01));
  }
  const noBaseline = measureResults({ events: afterOnly }, [change], { now: NOW });
  assert.equal(noBaseline.results[0].verdict, "no-baseline");
  assert.equal(resultsDays([], NOW), BASELINE_MAX_DAYS + 1);
  assert.equal(
    resultsDays([{ ...change, at: new Date(NOW - 40 * DAY).toISOString() }], NOW),
    40 + BASELINE_MAX_DAYS + 1,
  );
});

test("manifest transitions deduplicate by id and close periods on undo or later same-rule change", () => {
  const first = {
    id: "a",
    rule: "same-rule",
    at: "2026-10-01T00:00:00.000Z",
    keys: ["days"],
    previous: {},
    values: {},
    status: "pending",
  };
  const next = {
    id: "b",
    rule: "same-rule",
    at: "2026-10-10T00:00:00.000Z",
    keys: ["tz"],
    previous: {},
    values: {},
    status: "applied",
  };
  const replaced = {
    id: "c",
    rule: "replacement-rule",
    at: "2026-10-02T00:00:00.000Z",
    keys: ["days"],
    previous: {},
    values: {},
    status: "applied",
  };
  const replacement = {
    ...replaced,
    id: "d",
    at: "2026-10-05T00:00:00.000Z",
  };
  const changes = appliedChangesFromJournal([
    first,
    { ...first, status: "applied" },
    { ...first, status: "undone", restoredAt: "2026-10-07T00:00:00.000Z" },
    next,
    replaced,
    replacement,
  ]);
  assert.equal(changes.length, 4);
  assert.equal(changes[0].until, "2026-10-07T00:00:00.000Z");
  assert.equal(changes[1].until, replacement.at);
  assert.equal(changes[2].until, undefined);
  assert.equal(changes[3].until, undefined);
});
