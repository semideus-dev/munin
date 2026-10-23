/**
 * Validate every object the renderer may send.
 *
 * The preload bridge is not trusted: a compromised renderer could invoke the
 * exposed methods with arbitrary JSON. Unknown keys are rejected instead of
 * ignored, so the contract stays closed as it grows.
 */
import { MuninError } from "@munin/core";
import type { ReadOptions } from "@munin/application";
import type { FindingRequest, ScanRequest, SessionRequest } from "../shared/ipc.js";

const READ_KEYS = new Set(["days", "project", "tz"]);
const FINDING_KEYS = new Set([...READ_KEYS, "rule"]);
const SESSION_KEYS = new Set([...READ_KEYS, "sessionId"]);
const SCAN_KEYS = new Set([...READ_KEYS, "full"]);
const MAX_ID_LENGTH = 200;

function invalid(message: string): MuninError {
  return new MuninError({ code: "request.invalid", kind: "usage", message });
}

function recordOf(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Request options must be an object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`Unknown request option: ${key}`);
  }
  return record;
}

function readPart(record: Record<string, unknown>): ReadOptions {
  const request: ReadOptions = {};
  if (record.days !== undefined) {
    if (typeof record.days !== "number" || !Number.isInteger(record.days) || record.days <= 0) {
      throw invalid("days must be a positive whole number.");
    }
    request.days = record.days;
  }
  if (record.project !== undefined) {
    if (typeof record.project !== "string" || record.project.trim() === "") {
      throw invalid("project must be a non-empty string.");
    }
    request.project = record.project;
  }
  if (record.tz !== undefined) {
    if (typeof record.tz !== "string" || record.tz.trim() === "") {
      throw invalid("tz must be a non-empty string.");
    }
    request.tz = record.tz;
  }
  return request;
}

function idOf(record: Record<string, unknown>, field: "rule" | "sessionId"): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${field} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalid(`${field} is not a valid identifier.`);
  }
  return trimmed;
}

export function sanitizeReadRequest(value: unknown): ReadOptions {
  return readPart(recordOf(value, READ_KEYS));
}

export function sanitizeFindingRequest(value: unknown): FindingRequest {
  const record = recordOf(value, FINDING_KEYS);
  return { ...readPart(record), rule: idOf(record, "rule") };
}

export function sanitizeSessionRequest(value: unknown): SessionRequest {
  const record = recordOf(value, SESSION_KEYS);
  return { ...readPart(record), sessionId: idOf(record, "sessionId") };
}

export function sanitizeScanRequest(value: unknown): ScanRequest {
  const record = recordOf(value, SCAN_KEYS);
  const request: ScanRequest = readPart(record);
  if (record.full !== undefined) {
    if (typeof record.full !== "boolean") throw invalid("full must be a boolean.");
    request.full = record.full;
  }
  return request;
}
