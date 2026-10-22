/**
 * Day bucketing.
 *
 * UTC is the default. For non-UTC zones the local calendar day comes from
 * `Intl.DateTimeFormat.formatToParts`, never from slicing the ISO string: a
 * slice is only correct when the string is already in the bucketing zone.
 */
import type { DayZone } from "../domain/analysis.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

function pad(part: number): string {
  return part < 10 ? `0${part}` : String(part);
}

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;

  // en-CA renders year-month-day, so the parts are unambiguous.
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone === "local" ? undefined : zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatters.set(zone, created);
  return created;
}

/** The calendar day one timestamp falls on in `zone`, as `YYYY-MM-DD`. */
export function dayKey(iso: string, zone: DayZone = "UTC"): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";

  if (zone === "UTC") {
    // The UTC day comes straight from the parsed instant.
    const date = new Date(ms);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  const parts = formatterFor(zone).formatToParts(ms);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${read("year")}-${read("month")}-${read("day")}`;
}
