/**
 * Overview: the report fields a glance view needs, grouped without arithmetic.
 *
 * `totals` is the report's `Totals` object untouched; the grouped fields below
 * are field selections from it so the renderer never has to know which field
 * feeds which row. No value is recomputed.
 */
import type {
  DataHealth,
  FindingTier,
  MuninReport,
  ReportSavings,
  Totals,
  Window,
} from "@munin/core";
import type { SourceStatusDTO } from "./common.js";
import type { ScanRuntimeState } from "./runtime.js";

export interface TokenMixDTO {
  inputTokens: number;
  /** Priced output: source output plus reasoning, as the report defines it. */
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Input + priced output + cache read + cache write. Never adds thinking again. */
  totalTokens: number;
}

export interface CostSummaryDTO {
  /** Observed where reported, else the list-price estimate. */
  headlineUsd: number;
  observedUsd: number;
  estimatedUsd: number;
  /** Share of calls whose headline basis is `observed`; null when unknown. */
  observedCoverage: number | null;
  unpricedCalls: number;
  unpricedModels: string[];
}

export interface EfficiencyDTO {
  cacheHitRate: number | null;
  /** Thinking as a share of priced output. */
  thinkingShare: number | null;
  avgTokensPerCall: number;
  avgCostPerCall: number;
}

export interface SavingsTierDTO {
  tiers: FindingTier[];
  claimedCalls: number;
  windowUsd: number;
  monthlyUsd: number;
  annualUsd: number;
}

export interface SavingsSummaryDTO {
  windowDays: number;
  projectionDays: number;
  fix: SavingsTierDTO;
  try: SavingsTierDTO;
  /** A trade-off sized from the user's own usage: show as "up to", never sum. */
  test: SavingsTierDTO;
  /** Fix + try + test de-overlapped together. The only combined figure. */
  all: SavingsTierDTO;
  tokensWasted: number;
  pricedTokensWasted: number;
  unpricedTokensWasted: number;
  unpricedFindings: number;
}

export interface TopFindingDTO {
  rule: string;
  title: string;
  tier: FindingTier;
  severity: "high" | "medium" | "low" | null;
  confidence: "low" | "medium" | "high";
  windowUsd: number;
  monthlyUsd: number;
  affectedCalls: number;
  advisory: boolean;
}

export interface OverviewDTO {
  /** When this DTO was assembled; not a source timestamp. */
  generatedAt: string;
  source: SourceStatusDTO;
  scan: { status: ScanRuntimeState; lastScanAt: string | null };
  pricing: { asOf: string; version: number };
  /** The report's own accounting paragraph. */
  method: string;
  window: Window;
  timeZone: string;
  totals: Totals;
  tokenMix: TokenMixDTO;
  cost: CostSummaryDTO;
  efficiency: EfficiencyDTO;
  savings: SavingsSummaryDTO;
  /** Highest-ranked actionable recommendation from core, joined to its finding. */
  topFinding: TopFindingDTO | null;
  health: DataHealth;
}

function savingsTierDTO(tier: ReportSavings["fix"]): SavingsTierDTO {
  return {
    tiers: [...tier.tiers],
    claimedCalls: tier.claimedCalls,
    windowUsd: tier.windowUsd,
    monthlyUsd: tier.monthlyUsd,
    annualUsd: tier.annualUsd,
  };
}

export function savingsSummaryDTO(savings: ReportSavings): SavingsSummaryDTO {
  return {
    windowDays: savings.windowDays,
    projectionDays: savings.projectionDays,
    fix: savingsTierDTO(savings.fix),
    try: savingsTierDTO(savings.try),
    test: savingsTierDTO(savings.test),
    all: savingsTierDTO(savings.all),
    tokensWasted: savings.tokensWasted,
    pricedTokensWasted: savings.pricedTokensWasted,
    unpricedTokensWasted: savings.unpricedTokensWasted,
    unpricedFindings: savings.unpricedFindings,
  };
}

function topFindingDTO(report: MuninReport): TopFindingDTO | null {
  // Core already ranks recommendations by window dollars, then confidence.
  const recommendation = report.recommendations[0];
  if (recommendation === undefined) return null;
  const finding = report.findings.find((row) => row.rule === recommendation.rule);
  return {
    rule: recommendation.rule,
    title: finding?.title ?? recommendation.action,
    tier: recommendation.tier,
    severity: finding?.severity ?? null,
    confidence: recommendation.confidence,
    windowUsd: recommendation.windowUsd,
    monthlyUsd: recommendation.monthlyUsd,
    affectedCalls: recommendation.affectedCalls,
    advisory: finding?.advisory ?? false,
  };
}

export function overviewDTO(
  report: MuninReport,
  source: SourceStatusDTO,
  generatedAt: string,
  scan: { status: ScanRuntimeState; lastScanAt: string | null },
): OverviewDTO {
  const totals = report.totals;
  return {
    generatedAt,
    source,
    scan,
    pricing: { asOf: report.pricingAsOf, version: report.pricingVersion },
    method: report.method,
    window: report.window,
    timeZone: report.timeZone,
    totals,
    tokenMix: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      thinkingTokens: totals.thinkingTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalTokens: totals.totalTokens,
    },
    cost: {
      headlineUsd: totals.headlineUsd,
      observedUsd: totals.observedUsd,
      estimatedUsd: totals.estimatedUsd,
      observedCoverage: totals.observedCoverage,
      unpricedCalls: totals.unpricedCalls,
      unpricedModels: [...totals.unpricedModels],
    },
    efficiency: {
      cacheHitRate: totals.cacheHitRate,
      thinkingShare: totals.thinkingShare,
      avgTokensPerCall: totals.avgTokensPerCall,
      avgCostPerCall: totals.avgCostPerCall,
    },
    savings: savingsSummaryDTO(report.savings),
    topFinding: topFindingDTO(report),
    health: report.dataHealth,
  };
}
