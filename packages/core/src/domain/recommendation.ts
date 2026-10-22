import type { ConfidenceLevel, FindingTier } from "./finding.js";

export type RecommendationAction = "view-affected" | "simulate" | "verify" | "apply";
export type RecommendationDecisionStatus = "viewed" | "applied" | "done" | "dismissed";
export type RecommendationStatus = "new" | RecommendationDecisionStatus;

/** Persisted choice for a rule recommendation. */
export interface RecommendationDecision {
  rule: string;
  status: RecommendationDecisionStatus;
  at: string;
  note?: string;
}

/** Actionable presentation derived from a finding, not a second analysis. */
export interface Recommendation {
  id: string;
  rule: string;
  action: string;
  rationale: string;
  confidence: ConfidenceLevel;
  tier: FindingTier;
  actions: RecommendationAction[];
  status: RecommendationStatus;
  decisionAt?: string;
  decisionNote?: string;
  /** Sum of this finding's per-call claims; overlaps are separately disclosed. */
  windowUsd: number;
  monthlyUsd: number;
  affectedCalls: number;
  models: string[];
}
