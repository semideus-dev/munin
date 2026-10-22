import type { ScanCursor, Snapshot } from "../domain/ledger.js";
import { assertNoBannedKeys } from "./slices.js";

export function serializeSnapshot(value: Snapshot, nowMs = Date.now()): string {
  validateSnapshot(value, { nowMs });
  return JSON.stringify(value);
}

export function validateSnapshot(
  value: unknown,
  options: { previousId?: number; nowMs: number },
): asserts value is Snapshot {
  assertNoBannedKeys(value);
  if (!isRecord(value) || value.schema !== "munin.snapshot/1") {
    throw new TypeError("Invalid snapshot schema");
  }
  assertExactKeys(
    value,
    [
      "schema",
      "id",
      "at",
      "source",
      "scope",
      "state",
      "window",
      "totals",
      "byModel",
      "findings",
      "dataClean",
      "warningCounts",
    ],
    "snapshot",
  );
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    throw new TypeError("Snapshot id must be a positive safe integer");
  }
  if (options.previousId !== undefined && (value.id as number) <= options.previousId) {
    throw new TypeError("Snapshot id must be greater than the previous id");
  }
  assertIsoAt(value.at, "Snapshot at");
  if (Date.parse(value.at) > options.nowMs)
    throw new TypeError("Snapshot at cannot be in the future");

  if (!isRecord(value.source) || typeof value.source.path !== "string" || !value.source.path) {
    throw new TypeError("Snapshot source path is required");
  }
  assertExactKeys(value.source, ["path", "origin", "schema"], "snapshot source");
  if (!["flag", "env", "settings", "default"].includes(String(value.source.origin))) {
    throw new TypeError("Snapshot source origin is invalid");
  }
  if (!["v1", "v2", "mixed", "none"].includes(String(value.source.schema))) {
    throw new TypeError("Snapshot source schema is invalid");
  }
  if (
    !isRecord(value.scope) ||
    !["full", "incremental"].includes(String(value.scope.mode)) ||
    !isNonNegativeInteger(value.scope.sessionsRead) ||
    !isNonNegativeInteger(value.scope.slicesReplaced)
  ) {
    throw new TypeError("Snapshot scope is invalid");
  }
  assertExactKeys(value.scope, ["mode", "sessionsRead", "slicesReplaced"], "snapshot scope");
  if (
    !isRecord(value.state) ||
    !isNonNegativeInteger(value.state.sessionsTracked) ||
    !isNonNegativeInteger(value.state.eventsTracked)
  ) {
    throw new TypeError("Snapshot state counters are invalid");
  }
  assertExactKeys(value.state, ["sessionsTracked", "eventsTracked"], "snapshot state");
  if (
    !isRecord(value.window) ||
    !isNullableIso(value.window.start) ||
    !isNullableIso(value.window.end)
  ) {
    throw new TypeError("Snapshot window is invalid");
  }
  assertExactKeys(value.window, ["start", "end", "days"], "snapshot window");
  if (!isNonNegativeNumber(value.window.days))
    throw new TypeError("Snapshot window days are invalid");
  if (
    !isRecord(value.totals) ||
    !isNonNegativeInteger(value.totals.calls) ||
    !isNonNegativeInteger(value.totals.sessions)
  ) {
    throw new TypeError("Snapshot totals are invalid");
  }
  assertExactKeys(
    value.totals,
    [
      "calls",
      "sessions",
      "inputTokens",
      "outputTokens",
      "thinkingTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "headlineUsd",
      "observedUsd",
      "estimatedUsd",
    ],
    "snapshot totals",
  );
  for (const field of [
    "inputTokens",
    "outputTokens",
    "thinkingTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "headlineUsd",
    "observedUsd",
    "estimatedUsd",
  ]) {
    if (!isNonNegativeNumber(value.totals[field]))
      throw new TypeError(`Snapshot total ${field} is invalid`);
  }
  if (!Array.isArray(value.byModel) || !Array.isArray(value.findings)) {
    throw new TypeError("Snapshot model and finding rows must be arrays");
  }
  for (const row of value.byModel) {
    if (
      !isRecord(row) ||
      typeof row.provider !== "string" ||
      typeof row.model !== "string" ||
      !isNonNegativeInteger(row.calls) ||
      !isNonNegativeInteger(row.totalTokens) ||
      !isNonNegativeNumber(row.headlineUsd) ||
      !isNonNegativeNumber(row.observedUsd) ||
      !isNonNegativeNumber(row.estimatedUsd)
    )
      throw new TypeError("Snapshot model row is invalid");
    assertExactKeys(
      row,
      ["provider", "model", "calls", "totalTokens", "headlineUsd", "observedUsd", "estimatedUsd"],
      "snapshot model row",
    );
  }
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      typeof finding.rule !== "string" ||
      !finding.rule ||
      !isNonNegativeInteger(finding.count) ||
      !isNonNegativeNumber(finding.claimedWindowUsd)
    )
      throw new TypeError("Snapshot finding row is invalid");
    assertExactKeys(finding, ["rule", "count", "claimedWindowUsd"], "snapshot finding row");
  }
  if (typeof value.dataClean !== "boolean" || !isRecord(value.warningCounts)) {
    throw new TypeError("Snapshot health fields are invalid");
  }
  for (const [code, count] of Object.entries(value.warningCounts)) {
    if (!code || !isNonNegativeInteger(count))
      throw new TypeError("Snapshot warning counts are invalid");
  }
}

export function validateScanCursor(value: unknown, nowMs: number): asserts value is ScanCursor {
  if (!isRecord(value) || value.schema !== "munin.cursor/1") {
    throw new TypeError("Invalid scan cursor schema");
  }
  assertExactKeys(value, ["schema", "sourceSchema", "v1", "v2", "at"], "scan cursor");
  if (!["v1", "v2", "mixed", "none"].includes(String(value.sourceSchema))) {
    throw new TypeError("Cursor source schema is invalid");
  }
  assertIsoAt(value.at, "Cursor at");
  if (Date.parse(value.at) > nowMs) throw new TypeError("Cursor at cannot be in the future");
  for (const field of ["v1", "v2"] as const) {
    const watermark = value[field];
    if (watermark !== null && !isNonNegativeNumber(watermark)) {
      throw new TypeError(`Cursor ${field} watermark is invalid`);
    }
    if (typeof watermark === "number" && watermark > nowMs) {
      throw new TypeError(`Cursor ${field} watermark cannot be in the future`);
    }
  }
}

function assertIsoAt(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO 8601 UTC timestamp`);
  }
}

function isNullableIso(value: unknown): value is string | null {
  if (value === null) return true;
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TypeError(`${label} has missing or unexpected fields`);
  }
}
