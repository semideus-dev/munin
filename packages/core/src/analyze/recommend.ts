import type { Finding } from "../domain/finding.js";
import { CONFIDENCE_RANK } from "../domain/finding.js";
import type {
  Recommendation,
  RecommendationDecision,
  RecommendationDecisionStatus,
  RecommendationStatus,
} from "../domain/recommendation.js";
import { RULES } from "./rules.js";

/** Host-owned persistence seam. Core does not read the clock or filesystem. */
export interface DecisionStore {
  load(): Readonly<Record<string, RecommendationDecision>>;
  save(all: Readonly<Record<string, RecommendationDecision>>): void;
}

/** The core-level state transition; caller supplies timestamp and persistence. */
export function recordDecision(
  store: DecisionStore,
  rule: string,
  status: RecommendationDecisionStatus,
  at: string,
  note?: string,
): RecommendationDecision {
  if (rule.trim() === "") throw new TypeError("rule id is required");
  if (!Number.isFinite(Date.parse(at)))
    throw new TypeError("decision timestamp must be an ISO date");
  const decision: RecommendationDecision = {
    rule,
    status,
    at,
    ...(note === undefined ? {} : { note }),
  };
  store.save({ ...store.load(), [rule]: decision });
  return decision;
}

function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function actionFor(finding: Finding): string {
  const definition = RULES.find((rule) => rule.id === finding.rule);
  if (finding.rule === "model-fit" && finding.candidate?.to) {
    return `Route suitable calls to ${finding.candidate.to} and verify quality.`;
  }
  return definition?.action ?? finding.fix;
}

function rationaleFor(finding: Finding, totalCalls: number): string {
  const definition = RULES.find((rule) => rule.id === finding.rule);
  const share = totalCalls > 0 ? Math.round((finding.affected.calls / totalCalls) * 100) : 0;
  const traffic = `${finding.affected.calls} of ${totalCalls} calls (${share}%)`;
  const models = [...finding.affected.models].sort(codepointCompare);
  const modelList = models.length > 0 ? ` on ${models.join(", ")}` : "";
  const reason = definition?.rationale ?? finding.why;
  return `In this window, ${traffic}${modelList}: ${reason}`;
}

function claimedWindow(finding: Finding): number {
  let total = 0;
  for (const claim of finding.claimByEvent.values()) total += claim;
  return total;
}

function actionsFor(finding: Finding): Recommendation["actions"] {
  const actions: Recommendation["actions"] = ["view-affected", "simulate"];
  if (finding.verification === "replay") actions.push("verify");
  actions.push("apply");
  return actions;
}

/** Convert findings into stable, actionable recommendations. */
export function buildRecommendations(
  findings: readonly Finding[],
  totalCalls: number,
  decisions: Readonly<Record<string, RecommendationDecision>> = {},
): Recommendation[] {
  return findings
    .filter((finding) => !finding.advisory)
    .map((finding) => {
      const decision = decisions[finding.rule];
      const status: RecommendationStatus = decision?.status ?? "new";
      return {
        id: finding.rule,
        rule: finding.rule,
        action: actionFor(finding),
        rationale: rationaleFor(finding, totalCalls),
        confidence: finding.savings.confidence,
        tier: finding.tier,
        actions: actionsFor(finding),
        status,
        ...(decision === undefined ? {} : { decisionAt: decision.at }),
        ...(decision?.note === undefined ? {} : { decisionNote: decision.note }),
        windowUsd: claimedWindow(finding),
        monthlyUsd: finding.savings.monthlyUsd,
        affectedCalls: finding.affected.calls,
        models: [...finding.affected.models].sort(codepointCompare),
      };
    })
    .sort(
      (a, b) =>
        b.windowUsd - a.windowUsd ||
        CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
        codepointCompare(a.rule, b.rule),
    );
}
