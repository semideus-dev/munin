/**
 * Open-weight and gateway cards. The reference catalogue was read 2026-10-19;
 * the local cards added below were checked 2026-10-22.
 *
 * These are priced so their calls count, not recommended.
 */
import type { ModelPrice } from "../types.js";
import { openModel } from "./shared.js";

const M1 = 1_048_576;
const K200 = 202_752;

// DeepSeek bills half outside peak hours. The reference cards use 01:00-04:00
// and 06:00-10:00 UTC; the local V4.1 Flash card below uses 12:00-18:00.
const DEEPSEEK_PEAK: Array<[number, number]> = [
  [1, 4],
  [6, 10],
];
const DEEPSEEK_V41_FLASH_PEAK: Array<[number, number]> = [[12, 18]];

const deepseek = (inputPerM: number, cachedInputPerM: number, outputPerM: number) => ({
  inputPerM,
  outputPerM,
  cachedInputPerM,
  offPeak: { factor: 0.5, peakUtc: DEEPSEEK_PEAK },
});

const glm = (inputPerM: number, cachedInputPerM: number, outputPerM: number) => ({
  inputPerM,
  outputPerM,
  cachedInputPerM,
});

/** An explicit $0 card. Free ids must never fall through to a paid sibling. */
function freeModel(
  id: string,
  label: string,
  provider: string,
  contextTokens: number,
  maxOutputTokens: number,
): ModelPrice {
  return {
    id,
    label,
    provider,
    tier: "fast",
    rates: [
      {
        from: "2026-01-01",
        inputPerM: 0,
        outputPerM: 0,
        cachedInputPerM: 0,
        cacheWritePerM: 0,
        label: "free tier",
      },
    ],
    contextTokens,
    maxOutputTokens,
    capabilities: ["tools", "caching", "reasoning"],
    bestFor: "Free tier; priced at $0 so it never prefix-matches a paid sibling.",
    switchTarget: false,
    listed: false,
  };
}

export const OPEN_MODELS: ModelPrice[] = [
  // DeepSeek bills half outside 01:00 to 04:00 and 06:00 to 10:00 UTC on
  // weekdays, and all weekend.
  openModel(
    "deepseek-v4-pro",
    "DeepSeek V4 Pro",
    "deepseek",
    "frontier",
    deepseek(1.32, 0.044, 3.96),
    M1,
    384_000,
  ),
  openModel(
    "deepseek-flash",
    "DeepSeek Flash",
    "deepseek",
    "fast",
    deepseek(0.3, 0.006, 1.2),
    M1,
    384_000,
  ),
  // The old Flash ids bill at the new Flash price.
  openModel(
    "deepseek-v4-flash",
    "DeepSeek V4 Flash",
    "deepseek",
    "fast",
    deepseek(0.3, 0.006, 1.2),
    M1,
    384_000,
  ),
  // Observed locally. Peak is 12:00-18:00 UTC on weekdays; everything else,
  // including weekends, bills at half.
  openModel(
    "deepseek-v4.1-flash",
    "DeepSeek V4.1 Flash",
    "deepseek",
    "fast",
    {
      inputPerM: 0.3,
      cachedInputPerM: 0.006,
      outputPerM: 1.2,
      offPeak: { factor: 0.5, peakUtc: DEEPSEEK_V41_FLASH_PEAK },
    },
    M1,
    384_000,
  ),

  openModel("glm-5.3-flashx", "GLM-5.3 FlashX", "zai", "fast", glm(0.37, 0.075, 1.25), M1, 131_072),
  openModel("glm-5.3-flash", "GLM-5.3 Flash", "zai", "fast", glm(0.15, 0.03, 0.5), M1, 131_072),
  openModel("glm-5.3", "GLM-5.3", "zai", "frontier", glm(1.4, 0.26, 4.4), M1, 131_072),
  openModel("glm-5.2", "GLM-5.2", "zai", "frontier", glm(1.4, 0.26, 4.4), M1, 32_768),
  openModel("glm-5.1", "GLM-5.1", "zai", "frontier", glm(1.4, 0.26, 4.4), K200, 16_384),
  openModel("glm-5", "GLM-5", "zai", "frontier", glm(1, 0.2, 3.2), K200, 16_384),
  // Z.ai's free models get a $0 card, so they do not prefix-match a paid one.
  openModel("glm-4.7-flashx", "GLM-4.7 FlashX", "zai", "fast", glm(0.07, 0.01, 0.4), K200, 16_384),
  openModel("glm-4.7-flash", "GLM-4.7 Flash", "zai", "fast", glm(0, 0, 0), K200, 16_384),
  openModel("glm-4.7", "GLM-4.7", "zai", "balanced", glm(0.6, 0.11, 2.2), K200, 16_384),
  openModel("glm-4.6", "GLM-4.6", "zai", "balanced", glm(0.6, 0.11, 2.2), K200, 131_072),
  openModel("glm-4.5-airx", "GLM-4.5 AirX", "zai", "fast", glm(1.1, 0.22, 4.5), 131_072, 98_304),
  openModel("glm-4.5-air", "GLM-4.5 Air", "zai", "fast", glm(0.2, 0.03, 1.1), 131_072, 98_304),
  openModel("glm-4.5-flash", "GLM-4.5 Flash", "zai", "fast", glm(0, 0, 0), 131_072, 98_304),
  openModel("glm-4.5-x", "GLM-4.5 X", "zai", "balanced", glm(2.2, 0.45, 8.9), 131_072, 98_304),
  openModel("glm-4.5", "GLM-4.5", "zai", "balanced", glm(0.6, 0.11, 2.2), 131_072, 98_304),

  // Kimi lists a cache hit and a cache miss; a miss is the input rate.
  openModel("kimi-k3", "Kimi K3", "moonshot", "frontier", glm(3, 0.3, 15), M1, 131_072),
  openModel(
    "kimi-k2.7-code-highspeed",
    "Kimi K2.7 Code Highspeed",
    "moonshot",
    "balanced",
    glm(1.9, 0.38, 8),
    262_144,
    131_072,
  ),
  openModel(
    "kimi-k2.7-code",
    "Kimi K2.7 Code",
    "moonshot",
    "balanced",
    glm(0.95, 0.19, 4),
    262_144,
    131_072,
  ),
  openModel("kimi-k2.6", "Kimi K2.6", "moonshot", "balanced", glm(0.95, 0.16, 4), 262_144, 131_072),

  // MiniMax-M3 doubles past 512K input. Its write rate is not listed, so M2.7's
  // is used, doubled past 512K like the rest.
  openModel(
    "minimax-m3",
    "MiniMax-M3",
    "minimax",
    "balanced",
    {
      ...glm(0.3, 0.06, 1.2),
      cacheWritePerM: 0.375,
      longContext: {
        aboveTokens: 524_288,
        inputPerM: 0.6,
        outputPerM: 2.4,
        cachedInputPerM: 0.12,
        cacheWritePerM: 0.75,
      },
    },
    M1,
    131_072,
  ),
  openModel(
    "minimax-m2.7-highspeed",
    "MiniMax-M2.7 Highspeed",
    "minimax",
    "balanced",
    { ...glm(0.6, 0.06, 2.4), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.7",
    "MiniMax-M2.7",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.06, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.5-highspeed",
    "MiniMax-M2.5 Highspeed",
    "minimax",
    "balanced",
    { ...glm(0.6, 0.03, 2.4), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.5",
    "MiniMax-M2.5",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.03, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.1-highspeed",
    "MiniMax-M2.1 Highspeed",
    "minimax",
    "balanced",
    { ...glm(0.6, 0.03, 2.4), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2.1",
    "MiniMax-M2.1",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.03, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),
  openModel(
    "minimax-m2",
    "MiniMax-M2",
    "minimax",
    "balanced",
    { ...glm(0.3, 0.03, 1.2), cacheWritePerM: 0.375 },
    196_608,
    131_072,
  ),

  // The free ids observed through opencode. They need exact cards because
  // `glm-5.3-flash-free` is a prefix-extension of the paid `glm-5.3-flash`.
  freeModel("deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash (free)", "opencode", M1, 384_000),
  freeModel("glm-5.3-flash-free", "GLM-5.3 Flash (free)", "opencode", M1, 131_072),
];
