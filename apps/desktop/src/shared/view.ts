/**
 * Pure presentation helpers shared by the renderer and its tests.
 *
 * These functions format and select values the engine already produced. They
 * never price usage, recompute savings, sum overlapping findings, or invent
 * history: a missing value stays missing and an unpriced dollar stays unknown.
 */
import { dayKey } from "@munin/core";
import type {
  DayZone,
  FindingTier,
  Recommendation,
  ReportFinding,
  SessionSummary,
  SpendBucket,
  Totals,
  Window,
} from "@munin/core";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const usdPreciseFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const numberFormatter = new Intl.NumberFormat("en-US");

/** Money. Small non-zero values keep more digits instead of rounding to $0.00. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) > 0 && Math.abs(value) < 0.01
    ? usdPreciseFormatter.format(value)
    : usdFormatter.format(value);
}

/** Signed money for deltas. Zero is shown without a sign. */
export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return formatUsd(0);
  return `${value > 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;
}

export function formatNumber(value: number): string {
  return Number.isFinite(value) ? numberFormatter.format(value) : "—";
}

/** Compact token counts: 1.2M, 753k, 12.4k. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimOne(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trimOne(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimOne(value / 1_000)}k`;
  return numberFormatter.format(value);
}

function trimOne(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A rate as a percentage; null is unknown, never 0%. */
export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** Share of calls that carry a real price (observed or estimated). */
export function pricedCoverage(calls: number, unpricedCalls: number): number | null {
  if (!Number.isFinite(calls) || calls <= 0) return null;
  const covered = calls - Math.max(0, unpricedCalls);
  return Math.min(1, Math.max(0, covered / calls));
}

/** A percentage for the spend badge: "97% priced", never "0% priced" when unknown. */
export function pricedBadge(calls: number, unpricedCalls: number): string {
  const coverage = pricedCoverage(calls, unpricedCalls);
  return coverage === null ? "no calls" : `${Math.round(coverage * 100)}% priced`;
}

function zoneOption(timeZone: string): string | undefined {
  return timeZone === "local" ? undefined : timeZone;
}

function dateFormatter(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const zone = zoneOption(timeZone);
  return new Intl.DateTimeFormat("en-US", {
    ...options,
    ...(zone === undefined ? {} : { timeZone: zone }),
  });
}

export function formatMoment(iso: string, timeZone: string): string {
  try {
    return dateFormatter(timeZone, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatClock(iso: string, timeZone: string): string {
  try {
    return dateFormatter(timeZone, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatDayShort(key: string): string {
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** The footer interval, from the active report window. */
export function formatWindowRange(window: Window, timeZone: string): string {
  if (window.start === null || window.end === null) return "No calls in window";
  try {
    const format = dateFormatter(timeZone, { month: "short", day: "numeric" });
    const start = format.format(new Date(window.start));
    const end = format.format(new Date(window.end));
    return start === end ? start : `${start} – ${end}`;
  } catch {
    return "—";
  }
}

/** "2 min ago" from a real persisted scan timestamp. */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
      new Date(then),
    );
  } catch {
    return "earlier";
  }
}

export interface DayBar {
  /** `YYYY-MM-DD` in the report's day zone. */
  key: string;
  label: string;
  calls: number;
  usd: number;
  tokens: number;
  isLast: boolean;
}

function nextDayKey(key: string): string {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * One bar for every calendar day the window spans, using the report's own
 * `byDay` buckets. Days with no calls are real zeroes, not gaps.
 */
export function dailySeries(
  window: Window,
  byDay: readonly SpendBucket[],
  timeZone: DayZone,
): DayBar[] {
  if (window.start === null || window.end === null) return [];
  const startKey = dayKey(window.start, timeZone);
  const endKey = dayKey(window.end, timeZone);
  if (startKey === "unknown" || endKey === "unknown" || startKey > endKey) return [];

  const buckets = new Map(byDay.map((bucket) => [bucket.key, bucket]));
  const series: DayBar[] = [];
  let key = startKey;
  let guard = 0;
  while (key <= endKey && guard < 5000) {
    const bucket = buckets.get(key);
    series.push({
      key,
      label: formatDayShort(key),
      calls: bucket?.calls ?? 0,
      usd: bucket?.headlineUsd ?? 0,
      tokens: bucket?.totalTokens ?? 0,
      isLast: key === endKey,
    });
    key = nextDayKey(key);
    guard += 1;
  }
  return series;
}

/**
 * Recommendations first, in core's order, then remaining findings by projected
 * monthly saving. No new ranking is invented.
 */
export function orderFindings(
  findings: readonly ReportFinding[],
  recommendations: readonly Recommendation[],
): ReportFinding[] {
  const rank = new Map(recommendations.map((row, index) => [row.rule, index]));
  return [...findings].sort((a, b) => {
    const ai = rank.get(a.rule);
    const bi = rank.get(b.rule);
    if (ai !== undefined || bi !== undefined) {
      if (ai === undefined) return 1;
      if (bi === undefined) return -1;
      if (ai !== bi) return ai - bi;
    }
    if (a.savings.monthlyUsd !== b.savings.monthlyUsd) {
      return b.savings.monthlyUsd - a.savings.monthlyUsd;
    }
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
}

export function filterFindings(
  findings: readonly ReportFinding[],
  tier: FindingTier | "all",
): ReportFinding[] {
  return tier === "all" ? [...findings] : findings.filter((finding) => finding.tier === tier);
}

/** Never present withheld dollars as $0. */
export function findingSavingsLabel(finding: ReportFinding): string {
  if (finding.advisory) return "advisory";
  if (finding.savings.unpriced && finding.savings.windowUsd === 0) return "unknown";
  return formatUsd(finding.savings.windowUsd);
}

export interface SessionHeading {
  title: string;
  shortId: string;
}

export function sessionHeading(session: SessionSummary): SessionHeading {
  const title =
    session.title !== undefined && session.title.trim() !== ""
      ? session.title.trim()
      : session.project.trim() !== ""
        ? session.project
        : "Session";
  return { title, shortId: session.id.slice(-4) };
}

export function subagentCount(sessions: readonly SessionSummary[], parentId: string): number {
  return sessions.filter((session) => session.parentSessionId === parentId).length;
}

export interface TokenSegment {
  key: "input" | "cacheRead" | "cacheWrite" | "output";
  label: string;
  value: number;
  share: number;
  tone: string;
}

/**
 * Mutually exclusive token categories. `inputTokens` is uncached input; the
 * report's total is input + cache read + cache write + priced output, and
 * thinking is already inside output. Summing segments equals totalTokens.
 */
export function tokenSegments(totals: Totals): TokenSegment[] {
  const raw = [
    { key: "input" as const, label: "Input", value: totals.inputTokens, tone: "input" },
    {
      key: "cacheRead" as const,
      label: "Cache read",
      value: totals.cacheReadTokens,
      tone: "read",
    },
    {
      key: "cacheWrite" as const,
      label: "Cache write",
      value: totals.cacheWriteTokens,
      tone: "write",
    },
    {
      key: "output" as const,
      label: "Output",
      value: totals.outputTokens,
      tone: "output",
    },
  ];
  const sum = raw.reduce((total, part) => total + part.value, 0);
  return raw.map((part) => ({
    ...part,
    share: sum === 0 ? 0 : part.value / sum,
  }));
}

/** Cost for a model/session row, preserving unknown. */
export function costLabel(unpriced: boolean, headlineUsd: number): string {
  return unpriced && headlineUsd === 0 ? "unknown" : formatUsd(headlineUsd);
}

export function deltaSign(value: number): string {
  if (value > 0) return "+";
  if (value < 0) return "−";
  return "";
}
