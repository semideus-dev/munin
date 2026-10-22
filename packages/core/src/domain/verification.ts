import type { VerificationMode } from "./finding.js";

export type ReplayKind = "token" | "plan";

export type VerificationState =
  "unverified" | "not_required" | "passed" | "failed" | "inconclusive";

/** Persisted replay result or explicit user acceptance of a manual risk. */
export interface VerificationRecord {
  rule: string;
  at: string;
  mode: VerificationMode;
  state: Exclude<VerificationState, "unverified" | "not_required">;
  acceptedRiskAt?: string;
  samples?: number;
  note?: string;
}
