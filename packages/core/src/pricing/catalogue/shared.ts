/**
 * Small constructors shared by the catalogue files. They keep each card short
 * enough that the source and the date stay next to the number.
 */
import type { Capability, ModelPrice, RateCard, Tier } from "../types.js";

export const anthropicCaps: Capability[] = [
  "tools",
  "vision",
  "batch",
  "caching",
  "structured-output",
];
export const openaiCaps: Capability[] = [
  "tools",
  "vision",
  "batch",
  "caching",
  "structured-output",
];
export const googleCaps: Capability[] = [
  "tools",
  "vision",
  "batch",
  "caching",
  "structured-output",
];
export const openCaps: Capability[] = ["tools", "caching", "reasoning"];

/** A card whose rate changes above a prompt-size threshold. */
export function tiered(
  inputPerM: number,
  outputPerM: number,
  aboveTokens: number,
  longInputPerM: number,
  longOutputPerM: number,
  from = "2026-01-01",
): RateCard[] {
  return [
    {
      from,
      inputPerM,
      outputPerM,
      longContext: { aboveTokens, inputPerM: longInputPerM, outputPerM: longOutputPerM },
    },
  ];
}

export function flat(inputPerM: number, outputPerM: number, from = "2026-01-01"): RateCard[] {
  return [{ from, inputPerM, outputPerM }];
}

/** A rate card whose cached-input price is not the provider's default multiple. */
export function withCache(
  inputPerM: number,
  outputPerM: number,
  cachedInputPerM: number,
  from: string,
): RateCard[] {
  return [{ from, inputPerM, outputPerM, cachedInputPerM }];
}

/**
 * An OpenAI card from GPT-5.4 on. `writes`: GPT-5.6+ bills cache writes at
 * 1.25x input. `long`: past 272K input tokens the whole request bills at 2x
 * input and cache, 1.5x output. No cached rate means no prompt caching.
 */
export function gpt(
  inputPerM: number,
  cachedInputPerM: number | undefined,
  outputPerM: number,
  from: string,
  opts: { writes?: boolean; long?: boolean } = {},
): RateCard[] {
  const cacheWritePerM = opts.writes ? inputPerM * 1.25 : undefined;
  const card: RateCard = { from, inputPerM, outputPerM };
  if (cachedInputPerM !== undefined) card.cachedInputPerM = cachedInputPerM;
  if (cacheWritePerM !== undefined) card.cacheWritePerM = cacheWritePerM;
  if (opts.long) {
    const longContext: NonNullable<RateCard["longContext"]> = {
      aboveTokens: 272_000,
      inputPerM: inputPerM * 2,
      outputPerM: outputPerM * 1.5,
    };
    if (cachedInputPerM !== undefined) longContext.cachedInputPerM = cachedInputPerM * 2;
    if (cacheWritePerM !== undefined) longContext.cacheWritePerM = cacheWritePerM * 2;
    card.longContext = longContext;
  }
  return [card];
}

/**
 * A card for a model Munin prices but does not recommend: it costs the calls
 * people make on it and stays out of recommendations.
 */
export function openModel(
  id: string,
  label: string,
  provider: string,
  tier: Tier,
  card: Omit<RateCard, "from">,
  contextTokens: number,
  maxOutputTokens: number,
): ModelPrice {
  return {
    id,
    label,
    provider,
    tier,
    rates: [{ from: "2026-01-01", ...card }],
    contextTokens,
    maxOutputTokens,
    capabilities: openCaps,
    bestFor: "Priced so its calls count. Not compared or recommended here.",
    switchTarget: false,
    listed: false,
  };
}
