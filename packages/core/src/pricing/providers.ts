/**
 * Provider cache policies and per-request server-tool prices.
 *
 * A gateway's name is not a pricing authority: `opencode` and `ollama-cloud`
 * pass a model through, but the card's own `provider` decides how cache
 * traffic is billed. These policies are only the fallback when a card does not
 * carry an explicit rate.
 */
import type { ProviderCachePolicy, ServerToolPrices } from "./types.js";

/** The date the shipped cards were last checked. */
export const PRICING_AS_OF = "2026-10-22";

/** Bumped whenever a shipped card or the cost rules change. */
export const PRICING_VERSION = 1;

export const SERVER_TOOLS: Record<string, ServerToolPrices> = {
  anthropic: { webSearchPer1k: 10 },
};

export const PROVIDERS: Record<string, ProviderCachePolicy> = {
  anthropic: { read: 0.1, write5m: 1.25, write1h: 2.0, batch: 0.5 },
  // OpenAI caches automatically and bills nothing to write, so a write is just
  // input. Older models discount reads by less than 10x and set an explicit
  // cached rate on their card.
  openai: { read: 0.1, write5m: 1.0, write1h: 1.0, batch: 0.5, inputIncludesCacheReads: true },
  // Google's `promptTokenCount` includes cached tokens, like OpenAI's. Explicit
  // caching also bills storage per token-hour, which is not tied to a request
  // and is not counted; implicit caching is modelled exactly.
  google: { read: 0.25, write5m: 1.0, write1h: 1.0, batch: 0.5, inputIncludesCacheReads: true },
  // The providers below set an explicit cached rate on every card. DeepSeek and
  // Z.ai bill nothing extra to write; Kimi bills a 1h write at twice input.
  deepseek: { read: 0.02, write5m: 1.0, write1h: 1.0, batch: 1 },
  zai: { read: 0.2, write5m: 1.0, write1h: 1.0, batch: 1 },
  moonshot: { read: 0.1, write5m: 1.0, write1h: 2.0, batch: 1 },
  minimax: { read: 0.2, write5m: 1.25, write1h: 1.25, batch: 1 },
  // Ollama publishes an explicit cached rate for both gpt-oss cards, so the
  // multiplier is only a fallback. 0.1 is the ratio the 120b card implies
  // ($0.014 cached / $0.15 input, rounded).
  "ollama-cloud": { read: 0.1, write5m: 1.0, write1h: 1.0, batch: 1 },
  // The only opencode cards shipped here are the explicit $0 free tiers. They
  // bill nothing for any token category, so every multiplier is zero.
  opencode: { read: 0, write5m: 0, write1h: 0, batch: 1 },
};

/** Anthropic's cache multipliers, kept as a named export for readability. */
export const CACHE_MULTIPLIER = PROVIDERS.anthropic!;
export const BATCH_MULTIPLIER = PROVIDERS.anthropic!.batch;
