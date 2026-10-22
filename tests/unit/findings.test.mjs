import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFinding,
  detectFindings,
  findingValidationProblems,
  recoverableByEvent,
  recoverableWindow,
  windowOf,
} from "@munin/core";

function event(id, overrides = {}) {
  return {
    id,
    ts: "2026-10-20T10:00:00.000Z",
    model: "gpt-oss:120b",
    project: "munin",
    agent: "build",
    cost: { total: 0.00075, unpriced: false },
    ...overrides,
  };
}

// Two priced calls (e1 = $0.00075, e2 = $0.0009 headline), so the window is
// $0.00165 over one observed day and every projection divides by one day.
function events() {
  return [
    event("e1"),
    event("e2", { ts: "2026-10-20T10:01:00.000Z", cost: { total: 0.0009, unpriced: false } }),
  ];
}

function draft(overrides = {}) {
  return {
    rule: "test-rule",
    category: "context-bloat",
    title: "test waste",
    detail: "what is happening",
    why: "why it costs money",
    wastedUsd: 0.0003,
    tokensWasted: 2000,
    events: [event("e1")],
    evidence: { kind: "measured", basis: "counted directly" },
    confidence: { level: "high", basis: "only future traffic is assumed" },
    impact: "none",
    risk: "safe",
    assumptions: ["a duplicate is waste"],
    calculation: "1000 tokens x $0.30/M on the 2026-10-22 card",
    observations: ["sig: 2 duplicates, 1000 tok"],
    fix: "stop doing that",
    ...overrides,
  };
}

/** Run drafts through detection, so the window and totals come from the contract itself. */
function detected(list, eventsList = events()) {
  const { findings, errors } = detectFindings(eventsList, [{ rule: "test-rule", run: () => list }]);
  assert.equal(errors.length, 0);
  return findings;
}

function usd(actual, expected, label = "usd") {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${label}: expected $${expected}, got $${actual} (difference ${actual - expected})`,
  );
}

function claimOf(finding, id) {
  const claim = finding.claimByEvent.get(id);
  assert.ok(claim !== undefined, `no claim for ${id}`);
  return claim;
}

test("savings arithmetic is exact on a known call", () => {
  const [finding] = detected([draft()]);
  assert.ok(finding !== undefined);
  const s = finding.savings;

  // The affected call's headline: 1000 input x $0.15/M + 1000 output x $0.60/M.
  usd(s.currentUsd, 0.00075, "currentUsd");
  // Modelled waste below the clamp: reported as modelled.
  usd(s.windowUsd, 0.0003, "windowUsd");
  // One observed day, so the projection multiplies untouched.
  usd(s.monthlyUsd, 0.0003 * 30, "monthlyUsd");
  usd(s.annualUsd, 0.0003 * 365, "annualUsd");
  assert.equal(s.windowDays, 1);
  assert.equal(s.projectionDays, 1);

  usd(claimOf(finding, "e1"), 0.0003, "claim");
  assert.equal(finding.claimByEvent.size, 1);
  assert.equal(s.tokensWasted, 2000);
  assert.equal(s.unpriced, false);
  assert.equal(s.pricingAsOf, "2026-10-22");
  assert.equal(s.confidence, "high");

  assert.equal(finding.affected.calls, 1);
  usd(finding.affected.share, 0.00075 / 0.00165, "share");
  assert.deepEqual(finding.affected.models, ["gpt-oss:120b"]);
  assert.deepEqual(finding.affected.sampleEventIds, ["e1"]);

  // impact "none" defaults the tier to fix; a safe fix needs no verification.
  assert.equal(finding.tier, "fix");
  assert.equal(finding.verification, "not-required");
  assert.equal(finding.affects({ id: "e1" }), true);
  assert.equal(finding.affects({ id: "e2" }), false);
  assert.equal(finding.severity, "low"); // $0.0003/day is under the medium bar
  assert.equal(s.assumptions.length, 1); // no clamp, no unpriced note

  // Claims are split by cost when two calls are affected.
  const [twoCosts] = detected([draft({ events: events(), wastedUsd: 0.0016 })]);
  usd(claimOf(twoCosts, "e1"), 0.0016 * (0.00075 / 0.00165), "cost-weighted claim e1");
  usd(claimOf(twoCosts, "e2"), 0.0016 * (0.0009 / 0.00165), "cost-weighted claim e2");
});

test("modelled waste above affected spend is clamped to what was spent", () => {
  // e1 + e2 cost $0.00165 together; the detector claims $0.005.
  const [finding] = detected([draft({ events: events(), wastedUsd: 0.005, tokensWasted: 30000 })]);
  const s = finding.savings;

  usd(s.currentUsd, 0.00165, "currentUsd");
  usd(s.windowUsd, 0.00165, "windowUsd");
  usd(s.monthlyUsd, 0.00165 * 30, "monthlyUsd");
  usd(s.annualUsd, 0.00165 * 365, "annualUsd");
  usd(finding.affected.share, 1, "share");

  // The clamp says so, with the numbers kept to six decimals.
  assert.equal(s.assumptions.length, 2);
  assert.match(s.assumptions[1], /modelled \$0\.005 of waste/);
  assert.match(s.assumptions[1], /more than the affected calls cost \(\$0\.00165\)/);
  assert.match(s.assumptions[1], /capped at what was actually spent/);
});

test("two findings on one call de-overlap to the larger claim", () => {
  const findings = detected([
    draft({ rule: "r-small", title: "small", wastedUsd: 0.0003 }),
    draft({ rule: "r-big", title: "big", wastedUsd: 0.0005 }),
  ]);
  assert.equal(findings.length, 2);
  // Sorted by monthly projection, biggest first.
  assert.deepEqual(
    findings.map((f) => f.rule),
    ["r-big", "r-small"],
  );

  usd(recoverableWindow(findings), 0.0005, "recoverableWindow");
  const { byEvent, unattributed } = recoverableByEvent(findings);
  assert.equal(unattributed, 0);
  usd(byEvent.get("e1") ?? -1, 0.0005, "per-call");

  // A finding that changes model behaviour does not count in the fix headline...
  const mixed = detected([
    draft({ rule: "r-small", title: "small", wastedUsd: 0.0003 }),
    draft({ rule: "r-big", title: "big", tier: "try", wastedUsd: 0.0005 }),
  ]);
  usd(recoverableWindow(mixed, "fix"), 0.0003, "fix only");
  // ...until it is asked for alongside, still at its own claim.
  usd(recoverableWindow(mixed, ["fix", "try"]), 0.0005, "fix + try");
  assert.equal(recoverableWindow(mixed, "test"), 0);
});

test("an unpriced finding reports tokens, zero dollars, and unpriced: true", () => {
  const [finding] = detected([
    draft({
      rule: "unpriced-rule",
      events: [event("u1", { model: "gateway/mystery-model", cost: { total: 0, unpriced: true } })],
      wastedUsd: 0.001,
      tokensWasted: 5000,
    }),
  ]);
  const s = finding.savings;

  usd(s.currentUsd, 0, "currentUsd");
  usd(s.windowUsd, 0, "windowUsd");
  usd(s.monthlyUsd, 0, "monthlyUsd");
  usd(s.annualUsd, 0, "annualUsd");
  assert.equal(s.unpriced, true);
  // The dollar figure is withheld; the physical waste is still named.
  assert.equal(s.tokensWasted, 5000);
  assert.equal(finding.claimByEvent.size, 0);
  assert.equal(s.assumptions.length, 2);
  assert.match(s.assumptions[1], /reported in tokens only/);
  usd(finding.affected.share, 0, "share");
  assert.deepEqual(finding.affected.sampleEventIds, ["u1"]);
});

test("a real $0 card is priced, not unpriced, and still claims nothing", () => {
  const [finding] = detected([
    draft({
      rule: "free-rule",
      events: [
        event("f1", { model: "deepseek-v4.1-flash-free", cost: { total: 0, unpriced: false } }),
      ],
      wastedUsd: 0.001,
      tokensWasted: 5000,
    }),
  ]);

  // A $0 card makes the call priced at zero. The clamp to $0 of affected
  // spend still zeroes the window figure: dollars genuinely cannot be
  // recovered on a free model. But the call HAS a card, so the finding is not
  // flagged unpriced, and the clamp note explains the zero.
  usd(finding.savings.windowUsd, 0, "windowUsd");
  assert.equal(finding.savings.unpriced, false);
  assert.equal(finding.savings.assumptions.length, 2);
  assert.match(finding.savings.assumptions[1], /modelled \$0\.001 of waste.*cost \(\$0\)/s);
  assert.equal(finding.savings.tokensWasted, 5000);
});

test("a finding without a calculation or assumptions fails validation", () => {
  const noCalc = draft({ calculation: "  " });
  assert.deepEqual(findingValidationProblems(noCalc), [
    "calculation is empty: every finding needs a reproducible formula",
  ]);
  const noAssumptions = draft({ assumptions: [] });
  assert.deepEqual(findingValidationProblems(noAssumptions), [
    "assumptions is empty: every finding names what it assumes",
  ]);

  // buildFinding enforces the same contract, naming the rule.
  const context = {
    events: events(),
    window: windowOf(events()),
    projectionDays: 1,
    totalUsd: 0.00165,
  };
  assert.throws(
    () => buildFinding(noCalc, context),
    /validation failed for rule "test-rule".*calculation/,
  );
  assert.throws(() => buildFinding(noAssumptions, context), /assumptions/);
});

test("a detector error is reported with the rule name, not silence", () => {
  const { findings, errors } = detectFindings(events(), [
    {
      rule: "boom-rule",
      run: () => {
        throw new Error("boom happened");
      },
    },
    { rule: "good-rule", run: () => [draft({ rule: "good-rule" })] },
  ]);

  // The crash is named, and the other detector still ran.
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, "boom-rule");
  assert.match(errors[0].message, /boom happened/);
  assert.deepEqual(
    findings.map((f) => f.rule),
    ["good-rule"],
  );
});

test("long windows project at the recent 30-day pace", () => {
  // 40 observed days: $0.10 on 2026-09-10 (outside the last 30 days from the
  // last call) and $0.12 on 2026-10-20 (inside).
  const list = [
    event("old", { ts: "2026-09-10T10:00:00.000Z", cost: { total: 0.1, unpriced: false } }),
    event("end", { ts: "2026-10-20T10:00:00.000Z", cost: { total: 0.12, unpriced: false } }),
  ];
  assert.ok(windowOf(list).days > 30, `window is ${windowOf(list).days} days`);

  const [finding] = detected([draft({ events: list, wastedUsd: 0.04, tokensWasted: 40000 })], list);
  const s = finding.savings;
  assert.equal(s.windowDays, 40);
  // The last 30 days carry $0.12/day-pace of $0.004; the $0.22 window total is
  // priced as though it took 0.22 / (0.12/30) = 55 pace days.
  usd(s.projectionDays, 0.22 / (0.12 / 30), "projectionDays");
  usd(s.monthlyUsd, (0.04 / (0.22 / (0.12 / 30))) * 30, "monthlyUsd");
});
