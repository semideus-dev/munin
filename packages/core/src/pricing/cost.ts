/**
 * Cost math from canonical tokens. No vendor JSON and no clock reading: the
 * caller supplies the call time, so a fixed dataset always prices the same.
 */
import type { CostCalculation, TokenCounts } from "../domain/usage.js";
import { costHeadline } from "../domain/cost.js";
import { PROVIDERS, SERVER_TOOLS } from "./providers.js";
import { resolvePrice } from "./resolve.js";
import type {
  CostOptions,
  EffectiveRates,
  EstimateCostInput,
  ModelPrice,
  RateCard,
  TokenCost,
} from "./types.js";

const PER_MILLION = 1_000_000;

function timeOf(at: CostOptions["at"]): number | null {
  if (at === undefined || at === null) return null;
  const when = at instanceof Date ? at : new Date(at);
  const time = when.getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * The rate card in force for a model at a call time. With no time, or a time
 * outside every window, the newest card is used. That fallback is fixed by the
 * catalogue order, never by the clock.
 */
export function cardFor(price: ModelPrice, at?: CostOptions["at"]): RateCard {
  const time = timeOf(at);
  if (time !== null) {
    for (const card of price.rates) {
      const from = new Date(`${card.from}T00:00:00.000Z`).getTime();
      const until = card.until ? new Date(`${card.until}T23:59:59.999Z`).getTime() : Infinity;
      if (time >= from && time <= until) return card;
    }
  }
  return price.rates[price.rates.length - 1]!;
}

/** Whether a moment falls in peak hours: a weekday, inside one of the UTC ranges. */
export function isPeak(peakUtc: Array<[number, number]>, at?: CostOptions["at"]): boolean {
  const time = timeOf(at);
  // No usable time means no discount. Conservative, and deterministic.
  if (time === null) return true;
  const when = new Date(time);
  const day = when.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = when.getUTCHours() + when.getUTCMinutes() / 60;
  return peakUtc.some(([from, to]) => hour >= from && hour < to);
}

/** Fully resolved per-million rates for a model at a point in time. */
export function ratesFor(price: ModelPrice, opts: CostOptions = {}): EffectiveRates {
  const card = cardFor(price, opts.at);
  const policy = PROVIDERS[price.provider] ?? PROVIDERS.anthropic!;
  const scale = card.offPeak && !isPeak(card.offPeak.peakUtc, opts.at) ? card.offPeak.factor : 1;

  let inputPerM = card.inputPerM;
  let outputPerM = card.outputPerM;
  let cardCachedPerM = card.cachedInputPerM;
  let cardWritePerM = card.cacheWritePerM;

  // Long-context band, where the provider prices one. Checked before fast-mode
  // so an explicit fast rate still wins, as it does for a flat card.
  const band = card.longContext;
  if (band && Math.max(0, opts.promptTokens ?? 0) > band.aboveTokens) {
    inputPerM = band.inputPerM;
    outputPerM = band.outputPerM;
    cardCachedPerM = band.cachedInputPerM;
    cardWritePerM = band.cacheWritePerM;
  }

  if (opts.speed === "fast" && price.fast) {
    // The fast premium covers cache traffic too. A derived cache rate follows
    // the new input rate on its own; an explicit one has to be scaled.
    const premium = inputPerM === 0 ? 1 : price.fast.inputPerM / inputPerM;
    if (cardCachedPerM !== undefined) cardCachedPerM *= premium;
    if (cardWritePerM !== undefined) cardWritePerM *= premium;
    inputPerM = price.fast.inputPerM;
    outputPerM = price.fast.outputPerM;
  }

  let cachedInputPerM = cardCachedPerM ?? inputPerM * policy.read;
  let cacheWrite5mPerM = cardWritePerM ?? inputPerM * policy.write5m;
  let cacheWrite1hPerM = cardWritePerM ?? inputPerM * policy.write1h;

  if (opts.batch || scale !== 1) {
    const discount = (opts.batch ? policy.batch : 1) * scale;
    inputPerM *= discount;
    outputPerM *= discount;
    cachedInputPerM *= discount;
    cacheWrite5mPerM *= discount;
    cacheWrite1hPerM *= discount;
  }

  return { inputPerM, outputPerM, cachedInputPerM, cacheWrite5mPerM, cacheWrite1hPerM, card };
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Convert source token counts to the priced shape.
 *
 * OpenCode stores reasoning separately from visible output, but bills both as
 * output. Event construction uses this once, so no later stage adds thinking
 * a second time.
 */
export function billableTokens(tokens: TokenCounts): TokenCounts {
  return {
    input: count(tokens.input),
    output: count(tokens.output) + count(tokens.thinking),
    // Keep the subset for display. `costForTokens` never adds it again.
    thinking: count(tokens.thinking),
    cacheRead: count(tokens.cacheRead),
    cacheWrite: count(tokens.cacheWrite),
  };
}

/**
 * What a token profile costs at the card's list prices, or `null` when the
 * model has no card.
 *
 * `tokens.output` is the billed output count and already includes
 * `tokens.thinking`. Cache writes are treated as the 5-minute TTL, because
 * Phase 2 stores one aggregate.
 */
export function costForTokens(
  tokens: TokenCounts,
  modelId: string | null | undefined,
  options: CostOptions = {},
): TokenCost | null {
  const match = resolvePrice(modelId);
  if (!match) return null;

  const input = count(tokens.input);
  const output = count(tokens.output);
  const cacheRead = count(tokens.cacheRead);
  const cacheWrite = count(tokens.cacheWrite);

  const rates = ratesFor(match.price, {
    ...options,
    promptTokens: options.promptTokens ?? input + cacheRead + cacheWrite,
  });

  const inputUsd = (input * rates.inputPerM) / PER_MILLION;
  const outputUsd = (output * rates.outputPerM) / PER_MILLION;
  const cacheReadUsd = (cacheRead * rates.cachedInputPerM) / PER_MILLION;
  const cacheWriteUsd = (cacheWrite * rates.cacheWrite5mPerM) / PER_MILLION;

  // Per-request tool charges are not token traffic, so batch and fast-mode
  // multipliers do not touch them.
  const tools = SERVER_TOOLS[match.price.provider];
  const searches = count(options.webSearches);
  const serverTools = tools && searches > 0 ? (searches * tools.webSearchPer1k) / 1000 : 0;

  return {
    input: inputUsd,
    output: outputUsd,
    cacheRead: cacheReadUsd,
    cacheWrite: cacheWriteUsd,
    serverTools,
    total: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd + serverTools,
    card: rates.card,
    rates,
    matchedBy: match.matchedBy,
  };
}

function observedCost(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Price one call and pick the headline.
 *
 * Observed wins, including a legitimate zero. With no observation the list
 * price is the headline. With neither there is no card: the call is unpriced,
 * total stays zero, and every consumer must show it as unpriced, not free.
 */
export function estimateCost(input: EstimateCostInput): CostCalculation {
  const tokens = input.tokens;
  const priced = costForTokens(tokens, input.model, {
    at: input.at,
    speed: input.speed,
    batch: input.batch,
    promptTokens: input.promptTokens,
    webSearches: input.webSearches,
  });
  const observed = observedCost(input.observedUsd);
  const estimatedUsd = priced === null ? null : priced.total;
  const headline = costHeadline(observed, estimatedUsd);

  return {
    input: priced?.input ?? 0,
    output: priced?.output ?? 0,
    cacheRead: priced?.cacheRead ?? 0,
    cacheWrite: priced?.cacheWrite ?? 0,
    serverTools: priced?.serverTools ?? 0,
    total: headline.total,
    unpriced: headline.unpriced,
    observedUsd: observed,
    estimatedUsd,
    basis: headline.basis,
  };
}
