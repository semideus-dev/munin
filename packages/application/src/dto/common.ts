/**
 * Shared presentation DTOs.
 *
 * Every field is mapped from data the engine already produced. Nothing here
 * computes money, tokens, findings or savings.
 */
import { basename } from "node:path";
import type { SourceSchema } from "@munin/core";
import type { DbOrigin, SourceDatabaseStatus } from "@munin/local";

/** The source database as the UI may show it. */
export interface SourceStatusDTO {
  status: "ready" | "missing" | "unreadable";
  /** The resolved path. Settings may show it; compact cards use `pathLabel`. */
  path: string;
  pathLabel: string;
  origin: DbOrigin;
  /** The schema of the last read, when one has happened in this process. */
  schema: SourceSchema | null;
  sizeBytes?: number;
  modifiedAt?: string;
  reason?: string;
}

export function sourceStatusDTO(
  status: SourceDatabaseStatus,
  origin: DbOrigin,
  schema: SourceSchema | null,
): SourceStatusDTO {
  const base = {
    path: status.path,
    pathLabel: basename(status.path),
    origin,
    schema,
  };
  if (status.kind === "ready") {
    return {
      ...base,
      status: "ready",
      sizeBytes: status.sizeBytes,
      modifiedAt: status.modifiedAt,
    };
  }
  if (status.kind === "missing") return { ...base, status: "missing" };
  return { ...base, status: "unreadable", reason: status.reason };
}
