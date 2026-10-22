import type { SessionSlice } from "../domain/ledger.js";
import type { UsageEvent } from "../domain/usage.js";

/** Privacy-sensitive field names refused by all ledger serializers. */
export const BANNED_KEYS: ReadonlySet<string> = new Set([
  "text",
  "summary",
  "content",
  "state",
  "output",
  "prompt",
  "oldString",
]);

const EVENT_KEYS = new Set([
  "id",
  "source",
  "schema",
  "provider",
  "model",
  "variant",
  "agent",
  "ts",
  "sessionId",
  "parentSessionId",
  "projectId",
  "project",
  "category",
  "turnId",
  "turnStartedAt",
  "endTs",
  "contextEpoch",
  "taskKind",
  "inputTokens",
  "outputTokens",
  "thinkingTokens",
  "cacheReadTokens",
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "latencyMs",
  "stopReason",
  "speed",
  "serviceTier",
  "batch",
  "isSubagent",
  "headless",
  "tools",
  "instructionKeys",
  "instructionChars",
  "toolDefCount",
  "prefixHash",
  "cost",
]);
const TOOL_KEYS = new Set([
  "id",
  "name",
  "signature",
  "resultChars",
  "resultTokens",
  "target",
  "isError",
]);
const COST_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "serverTools",
  "total",
  "unpriced",
  "observedUsd",
  "estimatedUsd",
  "basis",
]);
const ALLOWED_OUTPUT_PATH = "$.events[].cost.output";

export function serializeSessionSlice(value: SessionSlice): string {
  validateSessionSlice(value);
  return JSON.stringify(value);
}

export function deserializeSessionSlice(serialized: string): SessionSlice {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new TypeError("Session slice is not valid JSON");
  }
  validateSessionSlice(value);
  return value;
}

export function validateSessionSlice(value: unknown): asserts value is SessionSlice {
  assertNoBannedKeys(value);
  if (!isRecord(value) || value.schema !== "munin.slice/1")
    throw new TypeError("Invalid session slice schema");
  assertExactKeys(value, new Set(["schema", "sessionId", "at", "watermarkMs", "events"]), "$");
  if (typeof value.sessionId !== "string" || !value.sessionId)
    throw new TypeError("Slice sessionId is required");
  if (!isIsoUtc(value.at)) throw new TypeError("Slice at must be an ISO 8601 UTC timestamp");
  if (!isNonNegativeNumber(value.watermarkMs))
    throw new TypeError("Slice watermarkMs must be a non-negative number");
  if (!Array.isArray(value.events)) throw new TypeError("Slice events must be an array");
  value.events.forEach((event, index) =>
    validateEvent(event, value.sessionId as string, `$.events[${index}]`),
  );
}

/** Walk any value written by the runtime and refuse prompt-bearing field names. */
export function assertNoBannedKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoBannedKeys(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`.replace(/\[\d+\]/g, "[]");
    const outputIsUsageCost = key === "output" && childPath === ALLOWED_OUTPUT_PATH;
    const snapshotStateCounters = key === "state" && childPath === "$.state";
    if (BANNED_KEYS.has(key) && !outputIsUsageCost && !snapshotStateCounters) {
      throw new TypeError(`Privacy-sensitive key refused at ${childPath}`);
    }
    assertNoBannedKeys(child, childPath);
  }
}

function validateEvent(
  value: unknown,
  sessionId: string,
  path: string,
): asserts value is UsageEvent {
  if (!isRecord(value)) throw new TypeError(`Invalid usage event at ${path}`);
  assertExactKeys(value, EVENT_KEYS, path);
  for (const field of ["id", "provider", "model", "project", "sessionId"] as const) {
    if (typeof value[field] !== "string" || !value[field])
      throw new TypeError(`Invalid event ${field} at ${path}`);
  }
  if (value.sessionId !== sessionId)
    throw new TypeError(`Event sessionId does not match slice at ${path}`);
  if (value.source !== "opencode" || !["v1", "v2"].includes(value.schema))
    throw new TypeError(`Invalid event source/schema at ${path}`);
  if (!isIsoUtc(value.ts)) throw new TypeError(`Invalid event timestamp at ${path}`);

  for (const field of [
    "inputTokens",
    "outputTokens",
    "thinkingTokens",
    "cacheReadTokens",
    "cacheWrite5mTokens",
    "cacheWrite1hTokens",
  ]) {
    if (!isNonNegativeNumber(value[field]))
      throw new TypeError(`Invalid event ${field} at ${path}`);
  }
  for (const field of ["contextEpoch", "latencyMs", "instructionChars", "toolDefCount"]) {
    if (value[field] !== undefined && !isNonNegativeNumber(value[field]))
      throw new TypeError(`Invalid event ${field} at ${path}`);
  }
  for (const field of [
    "variant",
    "agent",
    "parentSessionId",
    "projectId",
    "category",
    "turnId",
    "turnStartedAt",
    "endTs",
    "taskKind",
    "stopReason",
    "speed",
    "serviceTier",
    "prefixHash",
  ]) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== "string") {
      throw new TypeError(`Invalid event ${field} at ${path}`);
    }
  }
  for (const field of ["batch", "isSubagent", "headless"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean")
      throw new TypeError(`Invalid event ${field} at ${path}`);
  }
  if (
    value.instructionKeys !== undefined &&
    (!Array.isArray(value.instructionKeys) ||
      !value.instructionKeys.every((key: unknown) => typeof key === "string"))
  ) {
    throw new TypeError(`Invalid event instructionKeys at ${path}`);
  }
  if (!Array.isArray(value.tools)) throw new TypeError(`Invalid event tools at ${path}`);
  value.tools.forEach((tool: unknown, index: number) =>
    validateTool(tool, `${path}.tools[${index}]`),
  );
  validateCost(value.cost, `${path}.cost`);
}

function validateTool(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`Invalid tool at ${path}`);
  assertExactKeys(value, TOOL_KEYS, path);
  for (const field of ["id", "name", "signature"] as const) {
    if (typeof value[field] !== "string") throw new TypeError(`Invalid tool ${field} at ${path}`);
  }
  for (const field of ["resultChars", "resultTokens"]) {
    if (value[field] !== undefined && !isNonNegativeNumber(value[field]))
      throw new TypeError(`Invalid tool ${field} at ${path}`);
  }
  if (value.target !== undefined && typeof value.target !== "string")
    throw new TypeError(`Invalid tool target at ${path}`);
  if (value.isError !== undefined && typeof value.isError !== "boolean")
    throw new TypeError(`Invalid tool isError at ${path}`);
}

function validateCost(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`Invalid event cost at ${path}`);
  assertExactKeys(value, COST_KEYS, path);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "serverTools", "total"]) {
    if (!isNonNegativeNumber(value[field])) throw new TypeError(`Invalid cost ${field} at ${path}`);
  }
  if (typeof value.unpriced !== "boolean") throw new TypeError(`Invalid cost unpriced at ${path}`);
  for (const field of ["observedUsd", "estimatedUsd"]) {
    if (value[field] !== null && !isNonNegativeNumber(value[field]))
      throw new TypeError(`Invalid cost ${field} at ${path}`);
  }
  if (!["observed", "estimated"].includes(value.basis))
    throw new TypeError(`Invalid cost basis at ${path}`);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`.replace(/\[\d+\]/g, "[]");
    if (!allowed.has(key)) throw new TypeError(`Unexpected field refused at ${childPath}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
