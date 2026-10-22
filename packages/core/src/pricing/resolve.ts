/**
 * Model-id resolution. Longest match wins, and a free id never falls through
 * to a paid sibling.
 */
import type { ModelMatch, ModelPrice } from "./types.js";
import { ANTHROPIC_MODELS } from "./catalogue/anthropic.js";
import { GOOGLE_MODELS } from "./catalogue/google.js";
import { OLLAMA_MODELS } from "./catalogue/ollama.js";
import { OPEN_MODELS } from "./catalogue/open.js";
import { OPENAI_MODELS } from "./catalogue/openai.js";

/** Every shipped card. Order is stable, so reports are deterministic. */
export const CATALOGUE: ModelPrice[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
  ...OPEN_MODELS,
  ...OLLAMA_MODELS,
];

const BY_ID = new Map(CATALOGUE.map((model) => [model.id, model]));
const BY_LOWER_ID = new Map(CATALOGUE.map((model) => [model.id.toLowerCase(), model]));

// Bedrock and Vertex put a platform region in front of the vendor id.
const PLATFORM_PREFIX = /^(us|eu|apac)\./i;
// A vendor name in front of its model, as gateways pass it through
// (openai/gpt-5, z-ai/glm-4.6). A host's own spelling is not stripped: a host
// sets its own price, so it stays unpriced unless we ship a card for it.
const VENDOR_PREFIX = /^(anthropic|openai|azure|deepseek|z-ai|zai|moonshotai|minimax)[./]/i;
// The two gateways we do price explicitly. Their cards are the authority.
const PRICED_GATEWAY_PREFIX = /^(opencode|ollama-cloud)\//i;

function normalizeId(modelId: string): string {
  return modelId
    .trim()
    .replace(PLATFORM_PREFIX, "")
    .replace(PRICED_GATEWAY_PREFIX, "")
    .replace(VENDOR_PREFIX, "");
}

/** `-free` ids and `:free` ids need an exact card, never a prefix match. */
function isFreeId(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes("-free") || lower.endsWith(":free");
}

/**
 * Resolve a model id to its price card.
 *
 * Order: exact, case-insensitive exact, longest prefix. The free guard runs
 * after the exact attempts and before the prefix scan, so a free id with no
 * card stays unpriced instead of borrowing the paid card it extends.
 */
export function resolvePrice(modelId: string | null | undefined): ModelMatch | null {
  if (!modelId) return null;
  const normalized = normalizeId(modelId);
  if (normalized.length === 0) return null;

  const exact = BY_ID.get(normalized);
  if (exact) return { price: exact, matchedBy: "exact" };

  const lower = normalized.toLowerCase();
  const caseInsensitive = BY_LOWER_ID.get(lower);
  if (caseInsensitive) return { price: caseInsensitive, matchedBy: "lowercase" };

  if (isFreeId(normalized)) return null;

  let best: ModelPrice | null = null;
  for (const model of CATALOGUE) {
    const id = model.id.toLowerCase();
    if (lower.startsWith(id) && (best === null || model.id.length > best.id.length)) {
      best = model;
    }
  }
  return best === null ? null : { price: best, matchedBy: "prefix" };
}

export function priceFor(modelId: string | null | undefined): ModelPrice | null {
  return resolvePrice(modelId)?.price ?? null;
}

export function providerOf(modelId: string | null | undefined): string {
  return priceFor(modelId)?.provider ?? "unknown";
}

/** A model id for display: the catalogue label where there is one, else the raw id. */
export function modelLabel(modelId: string | null | undefined): string {
  if (!modelId) return "unknown";
  return priceFor(modelId)?.label ?? modelId;
}
