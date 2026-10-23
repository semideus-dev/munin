// Pure renderer helpers: formatting, day series, ordering, token composition
// and session labels. These run without Electron and pin the presentation rules
// that the GUI relies on: unknown is not zero, days are real buckets, and
// thinking is never counted twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  costLabel,
  dailySeries,
  filterFindings,
  findingSavingsLabel,
  formatCompact,
  formatPercent,
  formatRelativeTime,
  formatSignedUsd,
  formatUsd,
  formatWindowRange,
  orderFindings,
  pricedBadge,
  pricedCoverage,
  sessionHeading,
  subagentCount,
  tokenSegments,
} from "../../apps/desktop/dist/shared/view.js";

function bucket(key, overrides = {}) {
  return {
    key,
    calls: 1,
    sessions: 1,
    inputTokens: 100,
    outputTokens: 50,
    thinkingTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    totalTokens: 175,
    observedUsd: 1,
    estimatedUsd: 0,
    headlineUsd: 1,
    observedCalls: 1,
    unpricedCalls: 0,
    unpriced: false,
    spendShare: 1,
    cacheHitRate: 0.16,
    observedCoverage: 1,
    models: ["p/m"],
    providers: ["p"],
    projects: ["proj"],
    agents: ["build"],
    ...overrides,
  };
}

test("money formatting keeps small real amounts visible", () => {
  assert.equal(formatUsd(70.2), "$70.20");
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(Number.NaN), "—");
  assert.equal(formatSignedUsd(1.84), "+$1.84");
  assert.equal(formatSignedUsd(-1.84), "−$1.84");
  assert.equal(formatSignedUsd(0), "$0.00");
});

test("compact numbers and percentages are honest about missing rates", () => {
  assert.equal(formatCompact(3_100_000), "3.1M");
  assert.equal(formatCompact(212_000), "212k");
  assert.equal(formatCompact(999), "999");
  assert.equal(formatPercent(0.973), "97%");
  assert.equal(formatPercent(0.973, 1), "97.3%");
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(Number.NaN), "—");
});

test("priced coverage derives from authoritative call counts", () => {
  assert.equal(pricedCoverage(100, 3), 0.97);
  assert.equal(pricedCoverage(0, 0), null);
  assert.equal(pricedCoverage(-1, 0), null);
  assert.equal(pricedBadge(100, 3), "97% priced");
  assert.equal(pricedBadge(0, 0), "no calls");
});

test("daily series fills every calendar day in the window with real zeroes", () => {
  const window = {
    start: "2026-10-20T10:00:00.000Z",
    end: "2026-10-23T09:00:00.000Z",
    days: 3,
  };
  const series = dailySeries(window, [bucket("2026-10-20", { headlineUsd: 2 }), bucket("2026-10-23", { headlineUsd: 5 })], "UTC");
  assert.deepEqual(
    series.map((day) => day.key),
    ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
  );
  assert.deepEqual(
    series.map((day) => day.usd),
    [2, 0, 0, 5],
  );
  assert.equal(series.at(-1).isLast, true);
  assert.equal(series[0].label, "Oct 20");
  assert.equal(dailySeries({ start: null, end: null, days: 0 }, [], "UTC").length, 0);
  assert.equal(
    dailySeries({ start: "2026-10-23T10:00:00Z", end: "2026-10-20T10:00:00Z", days: 0 }, [], "UTC")
      .length,
    0,
  );
});

test("token composition is mutually exclusive and sums to the report total", () => {
  const totals = {
    inputTokens: 100,
    outputTokens: 50,
    thinkingTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
    totalTokens: 175,
  };
  const segments = tokenSegments(totals);
  assert.deepEqual(
    segments.map((segment) => segment.key),
    ["input", "cacheRead", "cacheWrite", "output"],
  );
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.value, 0),
    totals.totalTokens,
  );
  assert.equal(segments.reduce((sum, segment) => sum + segment.share, 0).toFixed(6), "1.000000");
  const empty = tokenSegments({ ...totals, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
  assert.equal(empty.every((segment) => segment.share === 0), true);
});

function finding(rule, tier, monthlyUsd, extra = {}) {
  return {
    rule,
    tier,
    title: `Title ${rule}`,
    detail: "detail",
    why: "why",
    risk: "safe",
    severity: "medium",
    verification: "none",
    impact: "cost",
    fix: "fix",
    advisory: false,
    observations: [],
    overlapWith: [],
    affected: { calls: 1, share: 0.1, models: [], projects: [] },
    savings: {
      windowUsd: monthlyUsd,
      monthlyUsd,
      assumptions: [],
      calculation: "x",
      confidence: "high",
      confidenceBasis: "b",
      unpriced: false,
    },
    ...extra,
  };
}

test("findings follow recommendation order, then monthly saving", () => {
  const rows = [
    finding("c", "fix", 10),
    finding("b", "try", 30),
    finding("a", "test", 20),
  ];
  const recommendations = [{ rule: "b" }, { rule: "a" }];
  assert.deepEqual(
    orderFindings(rows, recommendations).map((row) => row.rule),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    filterFindings(rows, "fix").map((row) => row.rule),
    ["c"],
  );
  assert.equal(filterFindings(rows, "all").length, 3);
});

test("unpriced savings and advisory findings never render as a fake zero", () => {
  const unpriced = finding("u", "try", 0);
  unpriced.savings.unpriced = true;
  assert.equal(findingSavingsLabel(unpriced), "unknown");
  assert.equal(findingSavingsLabel(finding("zero", "fix", 0)), "$0.00");
  const advisory = finding("adv", "test", 0, { advisory: true });
  assert.equal(findingSavingsLabel(advisory), "advisory");
  assert.equal(costLabel(true, 0), "unknown");
  assert.equal(costLabel(true, 2.5), "$2.50");
  assert.equal(costLabel(false, 0), "$0.00");
});

test("session headings, short ids and subagent counts use real distinct rows", () => {
  const parent = {
    id: "ses_abcdefa91f",
    title: "",
    project: "api-server",
    parentSessionId: null,
    isSubagent: false,
  };
  const child = {
    id: "ses_child7c02",
    title: "child task",
    project: "api-server",
    parentSessionId: parent.id,
    isSubagent: true,
  };
  assert.deepEqual(sessionHeading(parent), { title: "api-server", shortId: "a91f" });
  assert.deepEqual(sessionHeading(child), { title: "child task", shortId: "7c02" });
  assert.equal(subagentCount([parent, child], parent.id), 1);
  assert.equal(subagentCount([parent, child], child.id), 0);
});

test("relative timestamps and footer ranges come from real timestamps", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-10-23T11:59:50.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-10-23T11:58:00.000Z", now), "2 min ago");
  assert.equal(formatRelativeTime("2026-10-23T09:00:00.000Z", now), "3 h ago");
  assert.equal(formatRelativeTime("2026-10-20T12:00:00.000Z", now), "3 d ago");
  assert.equal(formatRelativeTime("not a date", now), "unknown");
  assert.equal(
    formatWindowRange(
      { start: "2026-10-20T10:00:00.000Z", end: "2026-10-23T09:00:00.000Z", days: 3 },
      "UTC",
    ),
    "Oct 20 – Oct 23",
  );
  assert.equal(formatWindowRange({ start: null, end: null, days: 0 }, "UTC"), "No calls in window");
});
