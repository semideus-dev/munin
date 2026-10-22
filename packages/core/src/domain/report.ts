/**
 * The structured report: one serialisable object a CLI or dashboard can render
 * without recomputing anything.
 *
 * Nothing non-serialisable survives into a report: no functions, Maps, Sets,
 * Date objects, or clock-dependent fields. Two `buildReport()` calls on one
 * dataset must produce byte-identical JSON. A finding's `affects` function
 * becomes its exact claim list, and its `claimByEvent` map becomes a sorted
 * array.
 */
import type {
  CacheStats,
  DayZone,
  ProjectLabelCollision,
  SessionSummary,
  SpendBucket,
  Totals,
  Window,
} from "./analysis.js";
import type {
  AffectedTraffic,
  AnalysisError,
  FindingCandidate,
  FindingCategory,
  FindingDetector,
  FindingTier,
  Impact,
  SavingsEstimate,
  VerificationMode,
} from "./finding.js";
import type { SourceSchema, SourceWarning } from "./source.js";

/** A finding's split of its window saving, carried on one call. */
export interface FindingClaim {
  eventId: string;
  usd: number;
}

/** A detector finding, serialised for the report. */
export interface ReportFinding {
  rule: string;
  category: FindingCategory;
  title: string;
  detail: string;
  why: string;
  tier: FindingTier;
  savings: SavingsEstimate;
  affected: AffectedTraffic;
  impact: Impact;
  severity: "high" | "medium" | "low";
  risk: "safe" | "needs-verification";
  verification: VerificationMode;
  /** Advisories claim nothing and count in no savings figure. */
  advisory: boolean;
  /** Concrete instances, most expensive first. */
  observations: string[];
  fix: string;
  candidate?: FindingCandidate;
  /** Sorted by `usd` descending, then event id, so byte output is stable. */
  claimByEvent: FindingClaim[];
}

/** Recoverable spend for one tier set, de-overlapped per call. */
export interface TierSavings {
  /** The tiers covered: one tier, or everything. */
  tiers: FindingTier[];
  /** Calls claimed under this tier set, each at its largest claim. */
  claimedCalls: number;
  windowUsd: number;
  monthlyUsd: number;
  annualUsd: number;
}

/**
 * The money findings could recover, one tier at a time plus the combined
 * figure. Dollars come from priced findings only; a finding with no card and
 * no observed charge reports tokens alone and contributes nothing here.
 */
export interface ReportSavings {
  /** The window the findings were observed over. */
  windowDays: number;
  /** The days daily rates were divided by, the recent-pace equivalent. */
  projectionDays: number;
  /** Clean waste removals: removing the duplicate leaves the work as it was. */
  fix: TierSavings;
  /** Moves that likely help but change what the model does. */
  try: TierSavings;
  /** Trade-offs sized from your own usage; shown as "up to", never summed. */
  test: TierSavings;
  /** Fix + try + test de-overlapped together. A floor on the total possible. */
  all: TierSavings;
  /**
   * Physical waste in tokens, summed per finding without de-overlap: two
   * findings can count different waste on the same call.
   */
  tokensWasted: number;
  pricedTokensWasted: number;
  unpricedTokensWasted: number;
  /** Non-advisory findings whose dollars are withheld entirely. */
  unpricedFindings: number;
}

/** One model whose calls carry unpriced traffic. */
export interface UnpricedModelHealth {
  /** `provider/model` as the source reported it. */
  model: string;
  calls: number;
  /** Calls with neither card nor observed charge; dollars cannot exist. */
  unpricedCalls: number;
  /**
   * Observed spend the source recorded on this model's calls. Zero means the
   * model is fully blind to us; nonzero means at least one call was charged
   * but the model still has no card, so it cannot be estimated.
   */
  observedUsd: number;
}

/** One session whose aggregate disagrees with its own messages. */
export interface AggregateMismatch {
  sessionId: string;
  category: string;
  expected: number;
  actual: number;
  delta: number;
  threshold: number;
}

/** The reconciliation summary, re-derived from the source aggregates. */
export interface ReconciliationHealth {
  checkedSessions: number;
  mismatchSessions: number;
  /** Tokens; the category unit of every mismatch above. */
  largestDelta: number;
  mismatches: AggregateMismatch[];
}

/** How much instruction-prefix metadata the analysis had to work with. */
export interface InstructionHealth {
  /** Sessions with at least one usage-bearing call. */
  sessions: number;
  sessionsWithInstructions: number;
  calls: number;
  callsWithPrefix: number;
}

/** What a reviewer needs to know about the data behind every number. */
export interface DataHealth {
  schema: SourceSchema;
  /** Files or stores actually read. */
  sources: string[];
  /** Source sessions, including any without usage-bearing calls. */
  sessions: number;
  /** Sessions the totals classify as subagents. */
  subagentSessions: number;
  messages: number;
  /** Assistant and compaction attempts, including failures. */
  modelCalls: number;
  /** Attempts that reported no usage; they never become priced events. */
  failedCalls: number;
  /** Compaction attempts, including failed ones. */
  compactions: number;
  /** Phase 2 read warnings plus Phase 3 pricing and analysis warnings. */
  warnings: SourceWarning[];
  unpricedModels: UnpricedModelHealth[];
  /** Share of calls whose headline basis is `observed`. */
  observedCoverage: number | null;
  reconciliation: ReconciliationHealth;
  projectLabelCollisions: ProjectLabelCollision[];
  /** Detectors that threw. Findings behind a failed detector are absent. */
  detectorErrors: AnalysisError[];
  instruction: InstructionHealth;
}

export interface MuninReport {
  /** Bump on any breaking shape change. */
  formatVersion: 1;
  /** The accounting rules, in one paragraph. */
  method: string;
  pricingAsOf: string;
  pricingVersion: number;
  /** The zone day buckets use, exactly as passed. */
  timeZone: string;
  window: Window;
  totals: Totals;
  byModel: SpendBucket[];
  byProvider: SpendBucket[];
  byProject: SpendBucket[];
  byDay: SpendBucket[];
  bySession: SpendBucket[];
  byAgent: SpendBucket[];
  cache: CacheStats;
  /** One row per session with usage-bearing calls, children not rolled up. */
  sessions: SessionSummary[];
  /** Sorted by projected monthly saving, then rule, then title. */
  findings: ReportFinding[];
  savings: ReportSavings;
  dataHealth: DataHealth;
}

export interface BuildReportOptions {
  /** Day bucketing zone; `"UTC"` by default. */
  zone?: DayZone;
  /** Defaults to the standard detector registry when omitted. */
  detectors?: readonly FindingDetector[];
}
