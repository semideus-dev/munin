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
  console.log(`db: ${dbPath}`);
  console.log(`schema: ${result.schema}`);
  console.log(`tables: ${result.tables.join(", ")}`);
  console.log(
    `session counts: session=${result.sessionCounts.session}, session_v2=${result.sessionCounts.session_v2}`,
  );
}

function printRows(result, instructions, dbPath) {
  const totalTextChars = result.textLengths.reduce((sum, row) => sum + row.text_chars, 0);
  const typePairs = Object.entries(result.messageTypeCounts).sort(([a], [b]) => a.localeCompare(b));
  const typeText =
    typePairs.length === 0 ? "none" : typePairs.map(([type, count]) => `${type}=${count}`).join(", ");

  console.log(`db: ${dbPath}`);
  console.log(`sessions: ${result.sessions.length}`);
  console.log(`message types: ${typeText}`);
  console.log(`messages: ${result.messages.length}`);
  console.log(`invalid json rows: ${result.invalidJsonRows}`);
  console.log(`tool calls: ${result.tools.length}`);
  console.log(`text chars: ${totalTextChars}`);
  console.log(`instruction sessions: ${instructions.bySession.length}`);
  console.log(`instruction entries: ${instructions.entries.length}`);
  console.log(`instruction chars: ${instructions.bySession.reduce((sum, row) => sum + row.chars, 0)}`);
}

function summarize(dataset, sessionId) {
  const sessions = sessionId
    ? dataset.sessions.filter((session) => session.id === sessionId)
    : dataset.sessions;

  const sessionSet = new Set(sessions.map((session) => session.id));
  const messages = sessionId
    ? dataset.messages.filter((message) => sessionSet.has(message.sessionId))
    : dataset.messages;

  const modelCalls = messages.filter((message) => message.type === "assistant" || message.type === "compaction");

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

  const subagentCount = modelCalls.filter((message) => {
    const agent = message.agent ?? "";
    return /subagent/i.test(agent);
  }).length;

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
  console.log(`db: ${dbPath}`);
  console.log(`schema: ${summary.schema}`);
  if (sessionId !== undefined) {
    console.log(`session: ${sessionId}`);
  }
  console.log(`sessions: ${summary.sessions}`);
  console.log(`messages: ${summary.messages}`);
  console.log(`model calls: ${summary.modelCalls}`);
  console.log(`tokens input: ${summary.totals.input}`);
  console.log(`tokens output: ${summary.totals.output}`);
  console.log(`tokens reasoning: ${summary.totals.reasoning}`);
  console.log(`tokens cache read: ${summary.totals.cacheRead}`);
  console.log(`tokens cache write: ${summary.totals.cacheWrite}`);
  console.log(`observed cost usd: ${summary.totals.observedCost}`);
  console.log(`subagent calls: ${summary.subagentCount}`);
  console.log(`instruction sessions: ${summary.instructionSessions}`);
  console.log(`instruction chars: ${summary.instructionChars}`);

  if (summary.warnings.length === 0) {
    console.log("warnings: none");
    return;
  }

  const parts = summary.warnings.map((warning) =>
    warning.count === undefined ? warning.code : `${warning.code}(${warning.count})`,
  );
  console.log(`warnings: ${parts.join(", ")}`);
}

function printReconcile(result, dbPath) {
  console.log(`db: ${dbPath}`);
  console.log(`checked sessions: ${result.checkedSessions}`);
  console.log(`mismatch sessions: ${result.mismatchSessions}`);
  console.log(`largest delta: ${result.largestDelta}`);
  if (result.warning === undefined) {
    console.log("warning: none");
    return;
  }
  console.log(`warning: ${result.warning.code}(${result.warning.count ?? 0})`);
}

function hasBannedKeys(value, banned, path = "$", found = []) {
  const allowedOutputPaths = new Set([
    "$.messages[].usage.tokens.output",
    "$.sessions[].aggregateUsage.output",
  ]);

  function normalizePath(inputPath) {
    return inputPath
      .replace(/\[\d+\]/g, "[]")
      .replace(/\.warnings\[\d+\]/g, ".warnings[]");
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
    console.error(`[${error.code}] ${error.message}`);
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
    console.error(`error: ${error.message}`);
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
    console.error("error: choose only one mode");
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
    console.error(`[source.missing-db] Database not found: ${config.dbPath}`);
    process.exit(1);
  }

  if (mode === "summary" || mode === "session" || mode === "reconcile" || mode === "check-privacy") {
    try {
      const dataset = readDataset(args.db ? { db: args.db } : {});
      if (mode === "reconcile") {
        const result = reconcileAggregates(dataset);
        if (args.json) {
          console.log(JSON.stringify({ ok: true, data: { db: config.dbPath, ...result } }, null, 2));
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
            console.log(JSON.stringify({ ok: false, error: { code: "source.privacy-violation", message: `Found banned keys at ${found.join(', ')}` } }, null, 2));
          } else {
            console.error(`[source.privacy-violation] Found banned keys at ${found.join(", ")}`);
          }
          process.exit(1);
        }

        if (args.json) {
          console.log(JSON.stringify({ ok: true, data: { db: config.dbPath, bannedKeysFound: 0 } }, null, 2));
        } else {
          console.log(`db: ${config.dbPath}`);
          console.log("privacy: ok");
        }
        return;
      }

      const summary = summarize(dataset, args.session);
      if (args.json) {
        console.log(JSON.stringify({ ok: true, data: { db: config.dbPath, ...(args.session === undefined ? {} : { session: args.session }), ...summary } }, null, 2));
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
    console.error(`[source.open-failed] Could not open database: ${config.dbPath}`);
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
      console.error(`[source.unsupported-schema] --rows requires v2 or mixed schema, found ${schemaResult.schema}`);
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
