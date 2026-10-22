/**
 * Pricing contracts: dated rate cards and the shapes the resolver and cost
 * math exchange.
 *
 * Every rate is USD per 1,000,000 tokens unless the field says otherwise. A
 * card is dated because a later price change must not rewrite history.
 */
import type { TokenCounts } from "../domain/usage.js";

export type Tier = "frontier" | "balanced" | "fast";

export type Capability =
  "tools" | "vision" | "reasoning" | "batch" | "caching" | "structured-output";

/** Rates that replace a card's base rates once a prompt passes a size. */
export interface LongContextRates {
  aboveTokens: number;
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  cacheWritePerM?: number;
}

/** A price that was in effect over a date range. */
export interface RateCard {
  /** Inclusive ISO date this rate took effect. */
  from: string;
  /** Inclusive ISO date it stopped applying. Absent means "still current". */
  until?: string;
  inputPerM: number;
  outputPerM: number;
  /**
   * Explicit cached-input rate. When absent, the provider's cache-read
   * multiplier is applied to `inputPerM`.
   */
  cachedInputPerM?: number;
  /**
   * Explicit cache-write rate for every TTL. When absent, the provider's write
   * multipliers apply.
   */
  cacheWritePerM?: number;
  /**
   * Rates that replace the ones above once a call's prompt passes
   * `aboveTokens`.
   */
  longContext?: LongContextRates;
  /**
   * A discount outside peak hours, on weekdays by UTC clock; weekends count as
   * off-peak. The rates above are the peak ones.
   */
  offPeak?: { factor: number; peakUtc: Array<[number, number]> };
  /** Why this card exists, e.g. "introductory pricing". */
  label?: string;
}

export interface ModelPrice {
  id: string;
  label: string;
  provider: string;
  tier: Tier;
  /** Chronological rate cards. The last card with no `until` is current. */
  rates: RateCard[];
  contextTokens: number;
  maxOutputTokens: number;
  capabilities: Capability[];
  /** Fast-mode premium pricing, where the model supports `speed: "fast"`. */
  fast?: { inputPerM: number; outputPerM: number };
  /** Short note for a future recommendation engine. */
  bestFor: string;
  /** False prices a model without proposing switches to it. */
  switchTarget?: false;
  /** False leaves it out of recommendations: priced so its calls count. */
  listed?: false;
}

/**
 * How each provider prices cache traffic, as multipliers on the input rate.
 * A model may override any of these with an explicit rate.
 */
export interface ProviderCachePolicy {
  read: number;
  write5m: number;
  write1h: number;
  /** Discount applied to asynchronous batch traffic. */
  batch: number;
  /**
   * True when the reported input count already includes cache reads. Readers
   * subtract them before analysis, so cost math must not subtract again.
   */
  inputIncludesCacheReads?: boolean;
}

/**
 * Server-side tools billed per request, which no token count includes. Only
 * tools with a published per-request price.
 */
export interface ServerToolPrices {
  /** USD per 1,000 web searches. */
  webSearchPer1k: number;
}

/** How a model id found its card, so data health can explain the match. */
export type PriceMatchKind = "exact" | "lowercase" | "prefix";

export interface ModelMatch {
  price: ModelPrice;
  matchedBy: PriceMatchKind;
}

export interface CostOptions {
  /** When the call happened, which decides the rate card. Never read the clock. */
  at?: string | number | Date;
  /** `"fast"` bills at fast-mode rates on models that support it. */
  speed?: string | null;
  /** Batch traffic bills at the provider's batch discount. */
  batch?: boolean;
  /**
   * Prompt size (input + cache reads + cache writes), which picks the band of a
   * tiered card. When omitted, the token counts supply it.
   */
  promptTokens?: number;
  /** Server-side web searches, billed per request rather than per token. */
  webSearches?: number;
}

/** Fully resolved per-million rates for a model at a point in time. */
export interface EffectiveRates {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number;
  cacheWrite5mPerM: number;
  cacheWrite1hPerM: number;
  /** The card these came from, so callers can explain the number. */
  card: RateCard;
}

/** What one token profile costs at list prices. */
export interface TokenCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  serverTools: number;
  total: number;
  /** The card and the resolved rates behind the number. */
  card: RateCard;
  rates: EffectiveRates;
  matchedBy: PriceMatchKind;
}

export interface EstimateCostInput {
  /**
   * Canonical tokens where `output` is the billed output count and already
   * includes `thinking`. Use `billableTokens()` to convert source counts.
   */
  tokens: TokenCounts;
  model: string | null | undefined;
  /** Provider-reported charge. A finite zero is a real observation. */
  observedUsd?: number | null;
  at?: string | number | Date;
  speed?: string | null;
  batch?: boolean;
  promptTokens?: number;
  webSearches?: number;
}
