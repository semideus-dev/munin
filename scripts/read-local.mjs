#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  detectSchema,
  loadConfig,
  openReadOnly,
  readDataset,
  readInstructions,
  readV2Rows,
} from "@munin/local";
import { MuninError, reconcileAggregates } from "@munin/core";
import { err, group, heading, kv, out, sep } from "./lib/output.mjs";

function printUsage() {
  console.error(
    "Usage: node scripts/read-local.mjs [--schema|--rows|--summary|--reconcile|--check-privacy|--session <id>] [--db <path>] [--json]",
  );
}

function parseArgs(argv) {
  let db;
  let schema = false;
  let rows = false;
  let summary = false;
  let reconcile = false;
  let checkPrivacy = false;
  let json = false;
  let session;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--schema") {
      schema = true;
      continue;
    }

    if (arg === "--rows") {
      rows = true;
      continue;
    }

    if (arg === "--summary") {
      summary = true;
      continue;
    }

    if (arg === "--reconcile") {
      reconcile = true;
      continue;
    }

    if (arg === "--check-privacy") {
      checkPrivacy = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--session") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("missing value for --session");
      }
      session = value;
      index += 1;
      continue;
    }

    if (arg === "--db") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("missing value for --db");
      }
      db = value;
      index += 1;
      continue;
    }

    throw new Error(`unknown flag: ${arg}`);
  }

  return { schema, rows, summary, reconcile, checkPrivacy, json, session, db };
}

function printSchema(result, dbPath) {
  heading("Schema");
  kv("db", dbPath);
  kv("schema", result.schema);
  kv("tables", result.tables.join(", "));
  kv(
    "session counts",
    `session ${group(result.sessionCounts.session)}, session_v2 ${group(result.sessionCounts.session_v2)}`,
  );
}

function printRows(result, instructions, dbPath) {
  const totalTextChars = result.textLengths.reduce((sum, row) => sum + row.text_chars, 0);
  const typePairs = Object.entries(result.messageTypeCounts).sort(([a], [b]) => a.localeCompare(b));
  const typeText =
    typePairs.length === 0
      ? "none"
      : typePairs.map(([type, count]) => `${type}=${count}`).join(", ");

  heading("Rows");
  kv("db", dbPath);
  kv("sessions", group(result.sessions.length));
  kv("message types", typeText);
  kv("messages", group(result.messages.length));
  kv("invalid json rows", group(result.invalidJsonRows));
  kv("tool calls", group(result.tools.length));
  kv("text chars", group(totalTextChars));
  kv("instruction sessions", group(instructions.bySession.length));
  kv("instruction entries", group(instructions.entries.length));
  kv("instruction chars", group(instructions.bySession.reduce((sum, row) => sum + row.chars, 0)));
}

function summarize(dataset, sessionId) {
  const sessions = sessionId
    ? dataset.sessions.filter((session) => session.id === sessionId)
    : dataset.sessions;

  const sessionSet = new Set(sessions.map((session) => session.id));
  const messages = sessionId
    ? dataset.messages.filter((message) => sessionSet.has(message.sessionId))
    : dataset.messages;

  const modelCalls = messages.filter(
    (message) => message.type === "assistant" || message.type === "compaction",
  );

  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    observedCost: 0,
  };

  for (const message of modelCalls) {
    const usage = message.usage;
    if (usage === undefined) {
      continue;
    }
    totals.input += usage.tokens.input;
    totals.output += usage.tokens.output;
    totals.reasoning += usage.tokens.thinking;
    totals.cacheRead += usage.tokens.cacheRead;
    totals.cacheWrite += usage.tokens.cacheWrite;
    totals.observedCost += usage.observedUsd ?? 0;
  }

  const subagentCount = sessions.filter((session) => session.parentId !== undefined).length;

  const instructionSessions = sessions.filter((session) => session.instructions !== undefined);
  const instructionChars = instructionSessions.reduce(
    (sum, session) => sum + (session.instructions?.chars ?? 0),
    0,
  );

  return {
    schema: dataset.schema,
    sessions: sessions.length,
    messages: messages.length,
    modelCalls: modelCalls.length,
    totals,
    subagentCount,
    instructionSessions: instructionSessions.length,
    instructionChars,
    warnings: dataset.warnings,
  };
}

function printSummary(summary, dbPath, sessionId) {
  heading("Summary");
  kv("db", dbPath);
  kv("schema", summary.schema);
  if (sessionId !== undefined) kv("session", sessionId);
  kv("sessions", group(summary.sessions));
  kv("messages", group(summary.messages));
  kv("model calls", group(summary.modelCalls));
  kv(
    "tokens",
    [
      `input ${group(summary.totals.input)}`,
      `output ${group(summary.totals.output)}`,
      `reasoning ${group(summary.totals.reasoning)}`,
      `cache read ${group(summary.totals.cacheRead)}`,
      `cache write ${group(summary.totals.cacheWrite)}`,
    ].join(sep()),
  );
  kv("observed cost usd", summary.totals.observedCost);
  kv("subagent sessions", group(summary.subagentCount));
  kv("instruction sessions", group(summary.instructionSessions));
  kv("instruction chars", group(summary.instructionChars));

  if (summary.warnings.length === 0) {
    kv("warnings", "none");
    return;
  }

  const parts = summary.warnings.map((warning) =>
    warning.count === undefined ? warning.code : `${warning.code}(${warning.count})`,
  );
  kv("warnings", out.yellow(parts.join(", ")));
}

function printReconcile(result, dbPath) {
  heading("Reconcile");
  kv("db", dbPath);
  kv("checked sessions", group(result.checkedSessions));
  kv(
    "mismatch sessions",
    result.mismatchSessions > 0
      ? out.red(group(result.mismatchSessions))
      : group(result.mismatchSessions),
  );
  kv("largest delta", group(result.largestDelta));
  if (result.warning === undefined) {
    kv("warning", "none");
    return;
  }
  kv("warning", out.yellow(`${result.warning.code}(${result.warning.count ?? 0})`));
}

function hasBannedKeys(value, banned, path = "$", found = []) {
  const allowedOutputPaths = new Set([
    "$.messages[].usage.tokens.output",
    "$.sessions[].aggregateUsage.output",
  ]);

  function normalizePath(inputPath) {
    return inputPath.replace(/\[\d+\]/g, "[]").replace(/\.warnings\[\d+\]/g, ".warnings[]");
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      hasBannedKeys(value[index], banned, `${path}[${index}]`, found);
    }
    return found;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (banned.has(key)) {
        const normalized = normalizePath(childPath);
        const isAllowedOutput = key === "output" && allowedOutputPaths.has(normalized);
        if (!isAllowedOutput) {
          found.push(childPath);
        }
      }
      hasBannedKeys(child, banned, childPath, found);
    }
  }

  return found;
}

function reportExpectedError(error) {
  if (error instanceof MuninError) {
    console.error(`${err.red(`[${error.code}]`)} ${error.message}`);
    process.exit(1);
  }

  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    console.error(`${err.red("error:")} ${error.message}`);
    process.exit(64);
  }

  const selectedModes =
    Number(args.schema) +
    Number(args.rows) +
    Number(args.summary) +
    Number(args.reconcile) +
    Number(args.checkPrivacy) +
    Number(args.session !== undefined);
  if (selectedModes > 1) {
    printUsage();
    console.error(`${err.red("error:")} choose only one mode`);
    process.exit(64);
  }

  const mode = args.rows
    ? "rows"
    : args.summary
      ? "summary"
      : args.reconcile
        ? "reconcile"
        : args.checkPrivacy
          ? "check-privacy"
          : args.session !== undefined
            ? "session"
            : "schema";
  const config = loadConfig(args.db ? { db: args.db } : {});

  if (!existsSync(config.dbPath)) {
    console.error(`${err.red(`[source.missing-db]`)} Database not found: ${config.dbPath}`);
    process.exit(1);
  }

  if (
    mode === "summary" ||
    mode === "session" ||
    mode === "reconcile" ||
    mode === "check-privacy"
  ) {
    try {
      const dataset = readDataset(args.db ? { db: args.db } : {});
      if (mode === "reconcile") {
        const result = reconcileAggregates(dataset);
        if (args.json) {
          console.log(
            JSON.stringify({ ok: true, data: { db: config.dbPath, ...result } }, null, 2),
          );
        } else {
          printReconcile(result, config.dbPath);
        }
        return;
      }

      if (mode === "check-privacy") {
        const banned = new Set(["text", "summary", "content", "state", "output"]);
        const found = hasBannedKeys(dataset, banned);
        if (found.length > 0) {
          if (args.json) {
            console.log(
              JSON.stringify(
                {
                  ok: false,
                  error: {
                    code: "source.privacy-violation",
                    message: `Found banned keys at ${found.join(", ")}`,
                  },
                },
                null,
                2,
              ),
            );
          } else {
            console.error(
              `${err.red(`[source.privacy-violation]`)} Found banned keys at ${found.join(", ")}`,
            );
          }
          process.exit(1);
        }

        if (args.json) {
          console.log(
            JSON.stringify({ ok: true, data: { db: config.dbPath, bannedKeysFound: 0 } }, null, 2),
          );
        } else {
          heading("Privacy check");
          kv("db", config.dbPath);
          kv("privacy", out.green("ok"));
        }
        return;
      }

      const summary = summarize(dataset, args.session);
      if (args.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              data: {
                db: config.dbPath,
                ...(args.session === undefined ? {} : { session: args.session }),
                ...summary,
              },
            },
            null,
            2,
          ),
        );
      } else {
        printSummary(summary, config.dbPath, args.session);
      }
      return;
    } catch (error) {
      reportExpectedError(error);
    }
  }

  let db;
  try {
    db = openReadOnly(config.dbPath);
  } catch (error) {
    console.error(`${err.red(`[source.open-failed]`)} Could not open database: ${config.dbPath}`);
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }

  try {
    const schemaResult = detectSchema(db);

    if (mode === "schema") {
      printSchema(schemaResult, config.dbPath);
      return;
    }

    if (schemaResult.schema !== "v2" && schemaResult.schema !== "mixed") {
      console.error(
        `${err.red(`[source.unsupported-schema]`)} --rows requires v2 or mixed schema, found ${schemaResult.schema}`,
      );
      process.exit(1);
    }

    const rows = readV2Rows(db);
    const instructions = readInstructions(
      db,
      rows.sessions.map((row) => row.id),
    );
    printRows(rows, instructions, config.dbPath);
  } finally {
    db.close();
  }
}

main();
