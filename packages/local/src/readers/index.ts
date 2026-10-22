import { existsSync } from "node:fs";
import {
  WARNING_CODES,
  mergeDatasets,
  normalizeOpenCodeV1,
  normalizeOpenCodeV2,
  reconcileAggregates,
  type Dataset,
  type SchemaVersion,
  type SourceWarning,
} from "@munin/core";
import { loadConfig, type LoadConfigOptions } from "../config.js";
import { readInstructions } from "./instructions.js";
import { readV1Rows, type ReadV1RowsOptions } from "./opencode-v1.js";
import { readV2Rows, type ReadV2RowsOptions } from "./opencode-v2.js";
import { detectSchema } from "./schema.js";
import { openReadOnly } from "./sqlite.js";

export interface ReadDatasetOptions
  extends LoadConfigOptions, ReadV1RowsOptions, ReadV2RowsOptions {
  /** Independent persisted high-water marks for mixed source databases. */
  watermarks?: Partial<Record<SchemaVersion, number | null>>;
  /** Schema used to write the current cursor, for mixed-schema transition recovery. */
  previousSchema?: Dataset["schema"];
  /** Runtime-only observer for the exact raw rows selected by each schema reader. */
  onSessionsRead?: (schema: SchemaVersion, timeUpdatedMs: readonly number[]) => void;
}

function emptyDataset(sourcePath: string, warning: SourceWarning): Dataset {
  return {
    schema: "none",
    sessions: [],
    messages: [],
    warnings: [warning],
    sources: [sourcePath],
  };
}

function openErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const text = String((error as { message: unknown }).message).toLowerCase();
    if (text.includes("database is locked") || text.includes("database is busy")) {
      return WARNING_CODES.sourceBusy;
    }
  }
  return WARNING_CODES.sourceUnreadable;
}

export function readDataset(options: ReadDatasetOptions = {}): Dataset {
  const config = loadConfig(options);

  if (!existsSync(config.dbPath)) {
    return emptyDataset(config.dbPath, {
      code: WARNING_CODES.sourceMissingDb,
      message: `Database not found: ${config.dbPath}`,
    });
  }

  let db;
  try {
    db = openReadOnly(config.dbPath);
  } catch (error) {
    return emptyDataset(config.dbPath, {
      code: openErrorCode(error),
      message: `Could not open database: ${config.dbPath}`,
    });
  }

  try {
    try {
      const schema = detectSchema(db);
      const hasWatermark = options.watermarkMs !== undefined || options.watermarks !== undefined;
      const sourceSchemaChanged =
        hasWatermark &&
        options.previousSchema !== undefined &&
        options.previousSchema !== schema.schema;
      const v1Watermark = sourceSchemaChanged
        ? undefined
        : (options.watermarks?.v1 ?? options.watermarkMs ?? undefined);
      const v2Watermark = sourceSchemaChanged
        ? undefined
        : (options.watermarks?.v2 ?? options.watermarkMs ?? undefined);
      const schemaChangeWarning: SourceWarning | undefined = sourceSchemaChanged
        ? {
            code: WARNING_CODES.sourceSchemaChanged,
            message: `Source schema changed from ${options.previousSchema} to ${schema.schema}; reading all sessions for this pass`,
            count: 1,
          }
        : undefined;

      const withSchemaWarning = (dataset: Dataset): Dataset =>
        schemaChangeWarning === undefined
          ? dataset
          : { ...dataset, warnings: [...dataset.warnings, schemaChangeWarning] };

      if (schema.schema === "none") {
        return withSchemaWarning(
          emptyDataset(config.dbPath, {
            code: WARNING_CODES.sourceNoSchema,
            message: "No v1 or v2 session tables were found",
          }),
        );
      }

      if (schema.schema === "v1") {
        const rows = readV1Rows(db, {
          sinceDays: options.sinceDays,
          limit: options.limit,
          offset: options.offset,
          watermarkMs: v1Watermark,
          overlapMs: options.overlapMs,
        });
        options.onSessionsRead?.(
          "v1",
          rows.sessions.map((session) => session.time_updated),
        );

        if (rows.sessions.length === 0) {
          return withSchemaWarning({
            schema: "v1",
            sessions: [],
            messages: [],
            warnings:
              v1Watermark === undefined
                ? [
                    {
                      code: WARNING_CODES.sourceEmpty,
                      message: "Schema exists but there are no sessions to read",
                    },
                  ]
                : [],
            sources: [config.dbPath],
          });
        }

        return withSchemaWarning(
          normalizeOpenCodeV1({
            sessions: rows.sessions,
            messages: rows.messages,
            parts: rows.parts,
            sourcePath: config.dbPath,
          }),
        );
      }

      const v2Rows = readV2Rows(db, {
        sinceDays: options.sinceDays,
        limit: options.limit,
        offset: options.offset,
        watermarkMs: v2Watermark,
        overlapMs: options.overlapMs,
      });
      options.onSessionsRead?.(
        "v2",
        v2Rows.sessions.map((session) => session.time_updated),
      );

      const v2Instructions = readInstructions(
        db,
        v2Rows.sessions.map((session) => session.id),
      );

      const v2Dataset = normalizeOpenCodeV2({
        sessions: v2Rows.sessions,
        messages: v2Rows.messages,
        tools: v2Rows.tools,
        textLengths: v2Rows.textLengths,
        instructionEntries: v2Instructions.entries,
        instructionBySession: v2Instructions.bySession,
        invalidJsonRows: v2Rows.invalidJsonRows,
        sourcePath: config.dbPath,
      });

      let dataset: Dataset;

      if (schema.schema === "v2") {
        dataset = v2Dataset;
      } else {
        const v1Rows = readV1Rows(db, {
          sinceDays: options.sinceDays,
          limit: options.limit,
          offset: options.offset,
          watermarkMs: v1Watermark,
          overlapMs: options.overlapMs,
        });
        options.onSessionsRead?.(
          "v1",
          v1Rows.sessions.map((session) => session.time_updated),
        );

        const v1Dataset = normalizeOpenCodeV1({
          sessions: v1Rows.sessions,
          messages: v1Rows.messages,
          parts: v1Rows.parts,
          sourcePath: config.dbPath,
        });

        dataset = mergeDatasets({
          v1: v1Dataset,
          v2: v2Dataset,
          v1Count: schema.sessionCounts.session,
          v2Count: schema.sessionCounts.session_v2,
          limit: options.limit,
          offset: options.offset,
        });
      }

      if (dataset.sessions.length === 0) {
        const hasAllSchemaWatermarks =
          schema.schema === "v2"
            ? v2Watermark !== undefined
            : v1Watermark !== undefined && v2Watermark !== undefined;
        return withSchemaWarning({
          ...dataset,
          warnings: hasAllSchemaWatermarks
            ? dataset.warnings
            : [
                ...dataset.warnings,
                {
                  code: WARNING_CODES.sourceEmpty,
                  message: "Schema exists but there are no sessions to read",
                },
              ],
        });
      }

      const reconcile = reconcileAggregates(dataset);
      if (reconcile.warning === undefined) {
        return withSchemaWarning(dataset);
      }

      return withSchemaWarning({
        ...dataset,
        warnings: [...dataset.warnings, reconcile.warning],
      });
    } catch (error) {
      return emptyDataset(config.dbPath, {
        code: openErrorCode(error),
        message: `Could not read database: ${config.dbPath}`,
      });
    }
  } finally {
    db.close();
  }
}
