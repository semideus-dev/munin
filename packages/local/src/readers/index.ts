import { existsSync } from "node:fs";
import {
  WARNING_CODES,
  mergeDatasets,
  normalizeOpenCodeV1,
  normalizeOpenCodeV2,
  reconcileAggregates,
  type Dataset,
  type SourceWarning,
} from "@munin/core";
import { loadConfig, type LoadConfigOptions } from "../config.js";
import { readInstructions } from "./instructions.js";
import { readV1Rows, type ReadV1RowsOptions } from "./opencode-v1.js";
import { readV2Rows, type ReadV2RowsOptions } from "./opencode-v2.js";
import { detectSchema } from "./schema.js";
import { openReadOnly } from "./sqlite.js";

export interface ReadDatasetOptions extends LoadConfigOptions, ReadV1RowsOptions, ReadV2RowsOptions {}

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

      if (schema.schema === "none") {
        return emptyDataset(config.dbPath, {
          code: WARNING_CODES.sourceNoSchema,
          message: "No v1 or v2 session tables were found",
        });
      }

      if (schema.schema === "v1") {
        const rows = readV1Rows(db, {
          sinceDays: options.sinceDays,
          limit: options.limit,
          offset: options.offset,
        });

        if (rows.sessions.length === 0) {
          return emptyDataset(config.dbPath, {
            code: WARNING_CODES.sourceEmpty,
            message: "Schema exists but there are no sessions to read",
          });
        }

        return normalizeOpenCodeV1({
          sessions: rows.sessions,
          messages: rows.messages,
          parts: rows.parts,
          sourcePath: config.dbPath,
        });
      }

      const v2Rows = readV2Rows(db, {
        sinceDays: options.sinceDays,
        limit: options.limit,
        offset: options.offset,
      });

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
        });

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
        return {
          ...dataset,
          warnings: [
            ...dataset.warnings,
            { code: WARNING_CODES.sourceEmpty, message: "Schema exists but there are no sessions to read" },
          ],
        };
      }

      const reconcile = reconcileAggregates(dataset);
      if (reconcile.warning === undefined) {
        return dataset;
      }

      return {
        ...dataset,
        warnings: [...dataset.warnings, reconcile.warning],
      };
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
