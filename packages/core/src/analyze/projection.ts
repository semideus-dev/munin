/**
 * Projection pace.
 *
 * Monthly and annual figures are projections, so they need a daily rate. A
 * window up to 30 days long is its own pace. For a longer one, the rate comes
 * from the last 30 days of spend, so a user whose activity jumped this month is
 * not told the average of their whole history. Measured back from the last
 * call, so an old export still projects from its own final month — never from
 * the wall clock.
 */
import type { UsageEvent } from "../domain/usage.js";
import { windowOf } from "./build.js";

/** How far back the recent pace reaches. */
export const PACE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * The days a window's dollar amounts are divided by for a daily rate: the
 * whole window when it is at most `PACE_DAYS` long, else the days the last
 * `PACE_DAYS` of spend would need to reach the window total. Deterministic:
 * a fixed dataset always answers the same.
 */
export function projectionDays(events: UsageEvent[]): number {
  const days = Math.max(1, windowOf(events).days || 1);
  if (days <= PACE_DAYS) return days;

  const end = events.reduce((max, event) => {
    const candidateMs = Date.parse(event.endTs ?? event.ts);
    return Number.isFinite(candidateMs) && candidateMs > max ? candidateMs : max;
  }, -Infinity);
  if (!Number.isFinite(end)) return days;

  const from = end - PACE_DAYS * MS_PER_DAY;
  let totalUsd = 0;
  let recentUsd = 0;
  for (const event of events) {
    totalUsd += event.cost.total;
    if (Date.parse(event.ts) >= from) recentUsd += event.cost.total;
  }
  if (totalUsd <= 0 || recentUsd <= 0) return days;
  return totalUsd / (recentUsd / PACE_DAYS);
}
