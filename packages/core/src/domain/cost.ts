import type { CostBasis } from "./usage.js";

export interface CostHeadline {
  /** The number reports show. */
  total: number;
  basis: CostBasis;
  /** True when neither a charge nor a rate card exists. */
  unpriced: boolean;
}

/**
 * Pick the headline cost (docs/adr/0003-observed-cost-headlines.md).
 *
 * A provider-reported charge wins, including a legitimate zero. Otherwise the
 * dated list price is the headline. With neither, the call is unpriced: total
 * stays zero and every consumer must show it as unpriced, never free.
 */
export function costHeadline(
  observedUsd: number | null,
  estimatedUsd: number | null,
): CostHeadline {
  if (observedUsd !== null) {
    return { total: observedUsd, basis: "observed", unpriced: false };
  }
  if (estimatedUsd !== null) {
    return { total: estimatedUsd, basis: "estimated", unpriced: false };
  }
  return { total: 0, basis: "estimated", unpriced: true };
}
