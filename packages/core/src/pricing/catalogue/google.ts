/**
 * Google Gemini cards, ported from the reference catalogue read 2026-10-19.
 *
 * They ship priced but are not recommended: no local traffic runs through
 * Gemini yet and these rates have not been re-checked against Google's list.
 */
import type { ModelPrice } from "../types.js";
import { flat, googleCaps, tiered } from "./shared.js";

export const GOOGLE_MODELS: ModelPrice[] = [
  {
    id: "gemini-3-pro",
    label: "Gemini 3 Pro",
    provider: "google",
    tier: "frontier",
    rates: tiered(2, 12, 200_000, 4, 18, "2025-11-18"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "Hardest reasoning and very long context. Thinking is always on.",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    tier: "frontier",
    rates: tiered(1.25, 10, 200_000, 2.5, 15, "2025-06-17"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "Long-context analysis and multi-step work below Gemini 3 Pro's price.",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    tier: "balanced",
    rates: flat(0.3, 2.5, "2025-06-17"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "The default workhorse: fast, cheap, and still able to think.",
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "google",
    tier: "fast",
    rates: flat(0.1, 0.4, "2025-07-22"),
    contextTokens: 1_000_000,
    maxOutputTokens: 64_000,
    capabilities: googleCaps,
    bestFor: "Classification, extraction and other mechanical steps at the lowest rate.",
  },
];
