/**
 * Ollama Cloud cards, checked 2026-10-22 against Ollama's published list.
 *
 * The 120b card is the strongest validation in the local history: its explicit
 * cached rate reproduces the observed charge exactly.
 */
import type { ModelPrice } from "../types.js";
import { openModel } from "./shared.js";

const VERIFIED = "Ollama Cloud list price, checked 2026-10-22";

export const OLLAMA_MODELS: ModelPrice[] = [
  openModel(
    "gpt-oss:120b",
    "GPT-OSS 120B",
    "ollama-cloud",
    "fast",
    {
      inputPerM: 0.15,
      cachedInputPerM: 0.014,
      outputPerM: 0.6,
      label: VERIFIED,
    },
    131_072,
    32_768,
  ),
  openModel(
    "gpt-oss:20b",
    "GPT-OSS 20B",
    "ollama-cloud",
    "fast",
    {
      inputPerM: 0.07,
      cachedInputPerM: 0.035,
      outputPerM: 0.3,
      label: VERIFIED,
    },
    131_072,
    32_768,
  ),
];
