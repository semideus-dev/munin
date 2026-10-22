import type { ConfidenceLevel } from "../../domain/finding.js";

/** Below this many calls, an average is an anecdote rather than a rate. */
export const SAMPLE_THIN = 10;
/** At or above this, one unusual call cannot meaningfully move the figure. */
export const SAMPLE_SOLID = 50;

/**
 * Confidence mechanics ported from the reference engine.
 *
 * Inputs are mechanical only: whether pricing was measured from recorded tokens,
 * sample size, and whether the fix keeps token profile stable.
 */
export function confidenceOf(input: {
  measured: boolean;
  sample: number;
  tokenProfileStable: boolean;
}): {
  level: ConfidenceLevel;
  basis: string;
} {
  const reasons: string[] = [
    input.measured
      ? "costed from recorded tokens at the rate in force"
      : "modelled rather than measured",
    `${input.sample} affected call${input.sample === 1 ? "" : "s"}`,
    input.tokenProfileStable
      ? "token counts unchanged by the fix"
      : "the replacement model's token counts are assumed to match",
  ];

  let level: ConfidenceLevel;
  if (!input.measured) {
    level = "low";
    reasons.push("low because the cost was never measured");
  } else if (input.sample < SAMPLE_THIN) {
    level = "low";
    reasons.push(`low because fewer than ${SAMPLE_THIN} calls is too thin to average`);
  } else if (!input.tokenProfileStable) {
    level = "medium";
    reasons.push("medium because the fix changes how the model responds");
  } else if (input.sample < SAMPLE_SOLID) {
    level = "medium";
    reasons.push(`medium because the sample is under ${SAMPLE_SOLID} calls`);
  } else {
    level = "high";
    reasons.push("high because only future traffic is assumed");
  }

  return { level, basis: reasons.join("; ") };
}
