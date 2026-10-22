import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billableTokens,
  cardFor,
  costForTokens,
  estimateCost,
  isPeak,
  PRICING_AS_OF,
  PRICING_VERSION,
  ratesFor,
  resolvePrice,
} from "@munin/core";

const MILLION = 1_000_000;

function tokens(overrides = {}) {
  return {
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  };
}

/** Compare dollars without letting binary floating point hide a real error. */
function usd(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected $${expected}, got $${actual} (difference ${actual - expected})`,
  );
}

const AT = "2026-10-22T12:00:00.000Z";

test("the catalogue states when it was checked and which rules version it is", () => {
  assert.equal(PRICING_AS_OF, "2026-10-22");
  assert.equal(PRICING_VERSION, 1);
});

test("gpt-oss:120b prices input, output and cached input at the verified card", () => {
  const cost = costForTokens(tokens({ input: MILLION, output: MILLION }), "gpt-oss:120b", {
    at: AT,
  });

  usd(cost.input, 0.15);
  usd(cost.output, 0.6);
  usd(cost.total, 0.75);
  assert.equal(cost.matchedBy, "exact");
  assert.equal(cost.card.from, "2026-01-01");
});

test("gpt-oss:120b cached reads use the explicit $0.014 rate, not a derived one", () => {
  const cost = costForTokens(tokens({ cacheRead: MILLION }), "ollama-cloud/gpt-oss:120b", {
    at: AT,
  });

  usd(cost.cacheRead, 0.014);
  usd(cost.total, 0.014);
  assert.equal(cost.rates.cachedInputPerM, 0.014);
});

test("an observed zero is a real observation and still carries the list estimate", () => {
  const cost = estimateCost({
    tokens: tokens({ input: MILLION }),
    model: "gpt-oss:120b",
    observedUsd: 0,
    at: AT,
  });

  assert.equal(cost.total, 0);
  assert.equal(cost.basis, "observed");
  assert.equal(cost.unpriced, false);
  assert.equal(cost.observedUsd, 0);
  usd(cost.estimatedUsd, 0.15);
});

test("a missing card is unpriced, never free", () => {
  const absent = estimateCost({
    tokens: tokens({ input: MILLION, output: MILLION }),
    model: "no-such-model-2026",
    at: AT,
  });

  assert.equal(absent.total, 0);
  assert.equal(absent.basis, "estimated");
  assert.equal(absent.unpriced, true);
  assert.equal(absent.estimatedUsd, null);
  assert.equal(absent.observedUsd, null);
  assert.equal(costForTokens(tokens({ input: MILLION }), "no-such-model-2026", { at: AT }), null);
});

test("a missing observation on a priced model is estimated", () => {
  const cost = estimateCost({
    tokens: tokens({ input: MILLION, output: MILLION }),
    model: "gpt-oss:120b",
    at: AT,
  });

  assert.equal(cost.basis, "estimated");
  assert.equal(cost.unpriced, false);
  assert.equal(cost.observedUsd, null);
  usd(cost.estimatedUsd, 0.75);
  usd(cost.total, 0.75);
});

test("a dated call selects the card in force, including an until date", () => {
  const price = {
    id: "dated-fixture",
    label: "Dated fixture",
    provider: "anthropic",
    tier: "fast",
    rates: [
      { from: "2026-01-01", until: "2026-05-31", inputPerM: 1, outputPerM: 2 },
      { from: "2026-06-01", inputPerM: 3, outputPerM: 4 },
    ],
    contextTokens: 1_000_000,
    maxOutputTokens: 1_000,
    capabilities: [],
    bestFor: "fixture only",
  };

  assert.equal(cardFor(price, "2026-05-31T23:59:59.999Z").inputPerM, 1);
  assert.equal(cardFor(price, "2026-06-01T00:00:00.000Z").inputPerM, 3);
  assert.equal(ratesFor(price, { at: "2026-03-01T00:00:00.000Z" }).inputPerM, 1);
  assert.equal(ratesFor(price, { at: "2026-07-01T00:00:00.000Z" }).inputPerM, 3);

  // No clock: the newest card is the deterministic fallback.
  assert.equal(ratesFor(price).inputPerM, 3);
});

test("long-context bands switch on the whole prompt and can be overridden", () => {
  const below = costForTokens(tokens({ input: 100_000 }), "claude-haiku-5-5", { at: AT });
  assert.equal(below.rates.inputPerM, 0.1);
  usd(below.input, 0.01);

  const above = costForTokens(tokens({ input: 200_000 }), "claude-haiku-5-5", { at: AT });
  assert.equal(above.rates.inputPerM, 0.5);
  usd(above.input, 0.1);

  // An explicit prompt size keeps a call in the cheaper band even when its
  // token count is larger.
  const forced = costForTokens(tokens({ input: 200_000 }), "claude-haiku-5-5", {
    at: AT,
    promptTokens: 100_000,
  });
  assert.equal(forced.rates.inputPerM, 0.1);
  usd(forced.input, 0.02);
});

test("batch traffic takes the provider discount", () => {
  const normal = costForTokens(tokens({ input: MILLION }), "claude-sonnet-5", { at: AT });
  const batch = costForTokens(tokens({ input: MILLION }), "claude-sonnet-5", {
    at: AT,
    batch: true,
  });

  usd(normal.input, 2);
  usd(batch.input, 1);
});

test("cache writes use the 5-minute TTL multiplier", () => {
  const write = costForTokens(tokens({ cacheWrite: MILLION }), "claude-sonnet-5", { at: AT });

  // $2 input, 1.25x for a 5-minute write.
  assert.equal(write.rates.cacheWrite5mPerM, 2.5);
  assert.equal(write.rates.cacheWrite1hPerM, 4);
  usd(write.cacheWrite, 2.5);
});

test("fast mode applies the model's premium to input and cache", () => {
  const fast = costForTokens(tokens({ input: MILLION, cacheRead: MILLION }), "claude-opus-5-5", {
    at: AT,
    speed: "fast",
  });

  usd(fast.input, 8);
  usd(fast.cacheRead, 0.4);
});

test("billable output adds thinking once and cost math never adds it again", () => {
  const billed = billableTokens(tokens({ input: 100, output: 200, thinking: 50 }));

  assert.equal(billed.output, 250);
  assert.equal(billed.thinking, 50);

  const cost = costForTokens(billed, "gpt-oss:120b", { at: AT });
  usd(cost.output, (250 * 0.6) / MILLION);
  usd(cost.total, (100 * 0.15 + 250 * 0.6) / MILLION);
});

test("off-peak pricing for deepseek-v4.1-flash follows the UTC clock", () => {
  const input = tokens({ input: MILLION });

  // 2026-10-21 is a Wednesday; 12:00-18:00 UTC is peak.
  const peak = costForTokens(input, "deepseek-v4.1-flash", {
    at: "2026-10-21T13:00:00.000Z",
  });
  usd(peak.input, 0.3);
  assert.equal(isPeak([[12, 18]], "2026-10-21T13:00:00.000Z"), true);

  const evening = costForTokens(input, "deepseek-v4.1-flash", {
    at: "2026-10-21T20:00:00.000Z",
  });
  usd(evening.input, 0.15);
  assert.equal(isPeak([[12, 18]], "2026-10-21T20:00:00.000Z"), false);

  // 2026-10-24 is a Saturday: off-peak all day.
  const weekend = costForTokens(input, "deepseek-v4.1-flash", {
    at: "2026-10-24T13:00:00.000Z",
  });
  usd(weekend.input, 0.15);
});

test("a free id resolves only to its exact $0 card", () => {
  const paid = resolvePrice("glm-5.3-flash");
  const free = resolvePrice("glm-5.3-flash-free");

  assert.equal(paid.price.id, "glm-5.3-flash");
  assert.equal(paid.price.rates[0].inputPerM, 0.15);
  assert.equal(free.price.id, "glm-5.3-flash-free");
  assert.equal(free.price.provider, "opencode");
  assert.equal(free.price.rates[0].inputPerM, 0);

  // A date suffix must not let the free id slide onto the paid sibling.
  assert.equal(resolvePrice("glm-5.3-flash-free-2026"), null);
  assert.equal(resolvePrice("deepseek-v4.1-flash-free-2026"), null);

  const freeCost = costForTokens(tokens({ input: MILLION }), "glm-5.3-flash-free", { at: AT });
  usd(freeCost.total, 0);
  assert.equal(freeCost.rates.inputPerM, 0);
});

test("gateway and vendor prefixes resolve without changing the card", () => {
  assert.equal(resolvePrice("us.anthropic.claude-sonnet-5").price.id, "claude-sonnet-5");
  assert.equal(resolvePrice("openai/gpt-5.5").price.id, "gpt-5.5");
  assert.equal(resolvePrice("ollama-cloud/gpt-oss:120b").price.id, "gpt-oss:120b");
  assert.equal(
    resolvePrice("opencode/deepseek-v4.1-flash-free").price.id,
    "deepseek-v4.1-flash-free",
  );

  const suffixed = resolvePrice("gpt-oss:120b-2026-10-01");
  assert.equal(suffixed.price.id, "gpt-oss:120b");
  assert.equal(suffixed.matchedBy, "prefix");
});

test("every model observed in the local history has a card", () => {
  for (const id of [
    "gpt-oss:120b",
    "gpt-oss:20b",
    "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-free",
    "glm-5.3-flash",
    "glm-5.3-flash-free",
    "kimi-k3",
  ]) {
    assert.notEqual(resolvePrice(id), null, `${id} should have a card`);
  }
});
