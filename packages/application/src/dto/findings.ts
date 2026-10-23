/**
 * Findings: the report's serialised findings and recommendations, plus a join
 * from exact claims to the calls they name.
 *
 * No confidence percentage, no savings re-summing, no alternative ranking: the
 * list keeps report order and `savings` is forwarded untouched.
 */
import type {
  MuninReport,
  PricedDataset,
  Recommendation,
  ReportFinding,
  ReportSavings,
  Window,
} from "@munin/core";

/** One claimed call, joined from `claimByEvent` and the priced dataset. */
export interface FindingClaimDTO {
  eventId: string;
  /** This finding's claim on the call, in USD; zero for unpriced traffic. */
  usd: number;
  ts: string | null;
  provider: string | null;
  model: string | null;
  /** The call's own token total, using the report's composition rule. */
  totalTokens: number | null;
}

export interface FindingListDTO {
  window: Window;
  /** Forwarded unchanged. Tiers are never summed by the adapter. */
  savings: ReportSavings;
  /** Every finding in report order, including advisories. */
  findings: ReportFinding[];
  /** Core-ranked, non-advisory recommendations with decision status. */
  recommendations: Recommendation[];
}

export interface FindingDetailDTO {
  finding: ReportFinding;
  recommendation: Recommendation | null;
  /** Exact claimed calls in claim order (largest claim first). */
  claims: FindingClaimDTO[];
}

export function findingListDTO(report: MuninReport): FindingListDTO {
  return {
    window: report.window,
    savings: report.savings,
    findings: report.findings,
    recommendations: report.recommendations,
  };
}

/**
 * A call's total token count under the same rule the report uses for buckets:
 * input + priced output + cache read + cache write. Thinking is part of priced
 * output and is never added again.
 */
function eventTotalTokens(event: PricedDataset["events"][number]): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheWrite5mTokens +
    event.cacheWrite1hTokens
  );
}

export function findingDetailDTO(
  report: MuninReport,
  priced: PricedDataset,
  rule: string,
): FindingDetailDTO | null {
  const finding = report.findings.find((row) => row.rule === rule);
  if (finding === undefined) return null;
  const eventsById = new Map(priced.events.map((event) => [event.id, event]));
  const claims = finding.claimByEvent.map((claim): FindingClaimDTO => {
    const event = eventsById.get(claim.eventId);
    return {
      eventId: claim.eventId,
      usd: claim.usd,
      ts: event?.ts ?? null,
      provider: event?.provider ?? null,
      model: event?.model ?? null,
      totalTokens: event === undefined ? null : eventTotalTokens(event),
    };
  });
  return {
    finding,
    recommendation: report.recommendations.find((row) => row.rule === rule) ?? null,
    claims,
  };
}
