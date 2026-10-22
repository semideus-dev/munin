#!/usr/bin/env node
// The Phase 3 analysis harness: every number in the report is reachable from
// one of these modes without writing code. Reads only; the database is opened
// read-only and nothing writes state (docs/plans/phase-3-analysis.md, Step 8).
//
// stdout carries data only; warnings go to stderr. Exit: 0 on success, 1 on
// runtime failure, 64 on usage errors.
import { existsSync } from "node:fs";
import { loadConfig, readDataset } from "@munin/local";
import { buildEvents, buildReport, MuninError } from "@munin/core";
import {
  err,
  group,
  heading,
  hline,
  kv,
  LIST_INDENT,
  out,
  pct,
  sep,
  sub,
  table,
  usd,
} from "./lib/output.mjs";

const BANNED_KEYS = new Set([
  // Message bodies, prompt text, and stored blobs. Titles, paths, hashes,
  // signatures, and counts are allowed; an edit's old text must never appear
  // in the serialised output, only its hash in the `Edit:` signature.
  "text",
  "summary",
  "content",
  "state",
  "output",
  "prompt",
  "oldString",
]);

const ALLOWED_OUTPUT_PATHS = new Set([
  "$.messages[].usage.tokens.output",
  "$.sessions[].aggregateUsage.output",
]);

const MODES = ["totals", "models", "sessions", "cache", "findings", "report", "events"];

function printUsage() {
  console.error(
    "Usage: node scripts/analyze-local.mjs [--totals|--models|--sessions|--cache|--findings|--report|--events] [--session <id>] [--check-privacy] [--db <path>] [--tz <zone>] [--json]",
  );
}

function parseArgs(argv) {
  let db;
  let tz;
  let session;
  let mode;
  let checkPrivacy = false;
  let json = false;

  const withValue = (name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    index += 1;
    return value;
  };

  const setMode = (name) => {
    if (mode !== undefined) throw new Error("choose only one mode");
    mode = name;
  };

  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    if (MODES.includes(argument.slice(2))) setMode(argument.slice(2));
    else if (argument === "--session") {
      setMode("session");
      session = withValue("--session");
    } else if (argument === "--check-privacy") checkPrivacy = true;
    else if (argument === "--json") json = true;
    else if (argument === "--db") db = withValue("--db");
    else if (argument === "--tz") tz = withValue("--tz");
    else throw new Error(`unknown flag: ${argument}`);
    index += 1;
  }

  if (mode !== undefined && checkPrivacy) throw new Error("choose only one mode");
  if (mode === undefined && !checkPrivacy) throw new Error("choose a mode");
  return { mode: mode ?? "privacy", checkPrivacy, json, db, tz, session };
}

/* ---------- formatting: plain ASCII, deterministic, no box drawing ---------- */

function tokensLine(event) {
  const write =
    event.cacheWriteTokens ?? (event.cacheWrite5mTokens ?? 0) + (event.cacheWrite1hTokens ?? 0);
  return [
    `in=${group(event.inputTokens)}`,
    `out=${group(event.outputTokens)}`,
    `think=${group(event.thinkingTokens)}`,
    `read=${group(event.cacheReadTokens)}`,
    `write=${group(write)}`,
  ].join(" ");
}

function eventTokens(event) {
  const write =
    event.cacheWriteTokens ?? (event.cacheWrite5mTokens ?? 0) + (event.cacheWrite1hTokens ?? 0);
  return [
    group(event.inputTokens),
    group(event.outputTokens),
    group(event.thinkingTokens),
    group(event.cacheReadTokens),
    group(write),
  ];
}

const TIER_STYLES = {
  fix: (text) => out.green(text),
  try: (text) => out.yellow(text),
  test: (text) => out.cyan(text),
};

function severityStyle(text) {
  if (text === "high") return (value) => out.red(value);
  if (text === "medium") return (value) => out.yellow(value);
  if (text === "low") return (value) => out.green(value);
  return (value) => value;
}

function warningLines(warnings) {
  for (const warning of warnings) {
    const count = warning.count === undefined ? "" : ` (x${warning.count})`;
    console.error(`${err.yellow(`[${warning.code}]`)} ${warning.message}${count}`);
  }
}

/* ---------- human formatters ---------- */

function printTotals(report, dbPath, showDb = true) {
  const t = report.totals;
  const s = report.savings;
  heading("Totals");
  if (showDb) kv("db", dbPath);
  kv("time zone", report.timeZone);
  kv(
    "window",
    `${report.window.start} .. ${report.window.end} (${report.window.days.toFixed(2)} days)`,
  );
  kv(
    "calls",
    `${group(t.calls)} calls, ${group(t.sessions)} sessions, ${group(t.turns)} turns, ${group(t.subagentSessions)} subagent sessions`,
  );
  kv(
    "tokens",
    [
      `input ${group(t.inputTokens)}`,
      `priced output ${group(t.outputTokens)} (thinking ${group(t.thinkingTokens)})`,
      `cache read ${group(t.cacheReadTokens)}`,
      `cache write ${group(t.cacheWriteTokens)}`,
      `total ${out.bold(group(t.totalTokens))}`,
    ].join(sep()),
  );
  kv(
    "costs",
    [
      `observed ${usd(t.observedUsd)}`,
      `estimated ${usd(t.estimatedUsd)}`,
      `unpriced calls ${group(t.unpricedCalls)}`,
      `headline ${out.bold(usd(t.headlineUsd))}`,
    ].join(sep()),
  );
  kv(
    "rates",
    `observed coverage ${pct(t.observedCoverage)}  cache hit rate ${pct(t.cacheHitRate)}  thinking share ${pct(t.thinkingShare)}`,
  );
  kv(
    "averages",
    `${group(Math.round(t.avgTokensPerCall))} tokens/call, ${usd(t.avgCostPerCall)} cost/call`,
  );
  kv(
    "savings",
    `fix ${usd(s.fix.windowUsd)} (monthly ${usd(s.fix.monthlyUsd)}) | try ${usd(s.try.windowUsd)} | all ${usd(s.all.windowUsd)} | tokens wasted ${group(Math.round(s.tokensWasted))}`,
  );
  kv("spend basis", report.method);
}

function printModels(report, dbPath, showDb = true) {
  heading("By model");
  if (showDb) kv("db", dbPath);
  const head = [
    "model",
    "calls",
    "in",
    "out",
    "think",
    "read",
    "write",
    "total",
    "headline",
    "observed",
    "estimated",
    "share",
    "cache hit",
    "unpriced",
  ];
  const rows = report.byModel.map((row) => [
    row.key,
    group(row.calls),
    group(row.inputTokens),
    group(row.outputTokens),
    group(row.thinkingTokens),
    group(row.cacheReadTokens),
    group(row.cacheWriteTokens),
    group(row.totalTokens),
    usd(row.headlineUsd),
    usd(row.observedUsd),
    usd(row.estimatedUsd),
    pct(row.spendShare),
    pct(row.cacheHitRate),
    row.unpriced ? "yes" : "-",
  ]);
  table(head, rows, [
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
  ]);
}

function printSessions(report, dbPath, showDb = true) {
  heading("Sessions");
  if (showDb) kv("db", dbPath);
  const head = [
    "session",
    "project",
    "agent",
    "subagent",
    "compactions",
    "calls",
    "total tokens",
    "cache hit",
    "headline",
    "coverage",
  ];
  const rows = report.sessions.map((s) => [
    s.id,
    s.project,
    s.agents.join("+") || "-",
    s.isSubagent ? "yes" : "-",
    group(s.compactions),
    group(s.calls),
    group(s.totalTokens),
    pct(s.cacheHitRate),
    usd(s.headlineUsd),
    pct(s.observedCoverage),
  ]);
  table(head, rows, [
    "left",
    "left",
    "left",
    "left",
    "right",
    "right",
    "right",
    "right",
    "right",
    "right",
  ]);
}

function printCache(report, dbPath, showDb = true) {
  heading("Cache");
  if (showDb) kv("db", dbPath);
  const c = report.cache;
  kv(
    "traffic",
    `input ${group(c.inputTokens)} | read ${group(c.readTokens)} | write ${group(c.writeTokens)} (5m ${group(c.write5mTokens)}, 1h ${group(c.write1hTokens)})`,
  );
  kv("hit rate", pct(c.hitRate));
  kv("writes recorded", c.writesRecorded ? "yes" : "no");
  kv("share of estimate", pct(c.shareOfEstimate));
  kv("costs", `read ${usd(c.estimatedReadUsd)} | write ${usd(c.estimatedWriteUsd)}`);
  for (const [label, rows] of [
    ["by model", c.byModel],
    ["by provider", c.byProvider],
    ["by session", c.bySession],
    ["by day", c.byDay],
  ]) {
    if (rows.length === 0) continue;
    sub(`${label} (first ${Math.min(rows.length, 6)} of ${group(rows.length)})`);
    for (const row of rows.slice(0, 6)) {
      kv(
        row.key,
        `calls=${group(row.calls)}  read=${group(row.readTokens)}  write=${group(row.writeTokens)}  hit=${pct(row.hitRate)}  hit change=${pct(row.hitRateChange)}  read ${usd(row.estimatedReadUsd)}  write ${usd(row.estimatedWriteUsd)}`,
      );
    }
  }
  sub("instruction prefixes");
  kv(
    "distinct",
    `${group(c.instructionContext.distinctPrefixHashes)} across ${group(c.instructionContext.sessions)} sessions (${group(c.instructionContext.totalChars)} chars)`,
  );
  console.log(
    `  ${out.dim("shared prefixes (at least 2 sessions):")} ${group(c.instructionContext.sharedPrefixes.length)}`,
  );
  for (const row of c.instructionContext.sharedPrefixes.slice(0, 6)) {
    console.log(
      `    ${row.prefixHash.slice(0, 12)}  ${row.agent}  ${row.model}${row.variant === undefined ? "" : ` (${row.variant})`}  sessions=${group(row.sessions)}  calls=${group(row.calls)}  uncached in=${group(row.uncachedInputTokens)}`,
    );
  }
}

function printFindings(report, dbPath, showDb = true) {
  heading("Findings");
  if (showDb) kv("db", dbPath);
  const s = report.savings;
  kv(
    "recoverable",
    [
      `fix ${usd(s.fix.windowUsd)} (${group(s.fix.claimedCalls)} calls)`,
      `try ${usd(s.try.windowUsd)} (${group(s.try.claimedCalls)})`,
      `test ${usd(s.test.windowUsd)}`,
      `all ${usd(s.all.windowUsd)}`,
    ].join(sep()),
  );
  report.findings.forEach((finding, index) => {
    if (index > 0) {
      console.log("");
      hline();
    }
    console.log("");
    const tier = TIER_STYLES[finding.tier] ?? out.bold;
    console.log(
      `${tier(`[${finding.tier}]`)} ${out.bold(finding.title)}  ${out.dim(finding.rule)}`,
    );
    console.log(
      `  ${out.dim("severity")} ${severityStyle(finding.severity)(finding.severity)}  ${out.dim("confidence")} ${finding.savings.confidence}  ${out.dim("verification")} ${finding.verification}  ${out.dim("advisory")} ${finding.advisory ? "yes" : "no"}`,
    );
    kv("detail", finding.detail);
    kv("why", finding.why);
    kv(
      "affected",
      `${finding.affected.calls} calls, models ${finding.affected.models.join(", ") || "none"}, share ${pct(finding.affected.share)}`,
    );
    kv(
      "savings",
      [
        `window ${usd(finding.savings.windowUsd)}`,
        `monthly ${usd(finding.savings.monthlyUsd)}`,
        `annual ${usd(finding.savings.annualUsd)}`,
        `current ${usd(finding.savings.currentUsd)}`,
        `tokens ${group(Math.round(finding.savings.tokensWasted))}`,
      ].join(sep()),
    );
    if (finding.savings.unpriced) {
      console.log(`  ${out.yellow("unpriced: token-only")}`);
    }
    kv("evidence", `${finding.savings.evidence.kind}: ${finding.savings.evidence.basis}`);
    kv("calculation", finding.savings.calculation);
    for (const assumption of finding.savings.assumptions) kv("assumption", assumption);
    kv("fix", finding.fix);
    if (finding.observations.length > 0) {
      kv("observations", `${finding.observations.length} (first 5 shown)`);
      for (const observation of finding.observations.slice(0, 5)) {
        console.log(`${LIST_INDENT}${observation}`);
      }
    }
  });
}

function printEvents(priced, filter, label) {
  const events =
    filter === undefined ? priced.events : priced.events.filter((e) => filter(e.sessionId));
  const failed = priced.attempts.filter(
    (attempt) =>
      attempt.usage === undefined && (filter === undefined ? true : filter(attempt.sessionId)),
  );
  heading(label);
  kv("events", `${group(events.length)} calls`);
  kv("failed attempts", `${group(failed.length)} (no usage: never billed, never a free call)`);
  sub("calls");
  table(
    ["id", "ts", "model", "in", "out", "think", "read", "write", "basis", "cost"],
    events.map((event) => [
      event.id,
      event.ts,
      event.model,
      ...eventTokens(event),
      event.cost.basis,
      usd(event.cost.total),
    ]),
    ["left", "left", "left", "right", "right", "right", "right", "right", "left", "right"],
  );
  if (failed.length > 0) {
    sub("failed attempts (no usage)");
    table(
      ["id", "ts", "type"],
      failed.map((attempt) => [
        attempt.id,
        attempt.ts,
        `${attempt.errorType ?? "no usage"}${attempt.type === "compaction" ? " (compaction)" : ""}`,
      ]),
    );
  }
}

function printSessionReport(report, priced, id, dbPath) {
  const row = report.sessions.find((s) => s.id === id);
  if (row === undefined) {
    console.error(`${err.red(`[analysis.unknown-session]`)} no session with id ${id}`);
    process.exit(1);
  }
  heading("Session");
  kv("db", dbPath);
  kv("session", row.id);
  kv("project", row.project);
  kv("agent", row.agents.join("+") || "-");
  kv("subagent", row.isSubagent ? "yes" : "no");
  if (row.parentSessionId !== undefined) kv("parent", row.parentSessionId);
  kv("span", `${row.firstTs ?? "-"} .. ${row.lastTs ?? "-"}`);
  kv("calls", group(row.calls));
  kv("turns", group(row.turns));
  kv("compactions", group(row.compactions));
  kv(
    "tokens",
    tokensLine({
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      thinkingTokens: row.thinkingTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    }),
  );
  kv(
    "cost",
    `observed ${usd(row.observedUsd)} | estimated ${usd(row.estimatedUsd)} | headline ${out.bold(usd(row.headlineUsd))}`,
  );
  kv("rates", `cache hit ${pct(row.cacheHitRate)}, coverage ${pct(row.observedCoverage)}`);
  printEvents(priced, (sessionId) => sessionId === id, "Session calls");
}

function printReportText(report, dbPath) {
  heading("Report");
  kv("db", dbPath);
  kv("time zone", report.timeZone);
  kv("pricing", `${report.pricingAsOf} v${report.pricingVersion}`);
  printTotals(report, dbPath, false);
  printModels(report, dbPath, false);
  printSessions(report, dbPath, false);
  printCache(report, dbPath, false);
  printFindings(report, dbPath, false);
  const h = report.dataHealth;
  heading("Data health");
  kv("schema", h.schema);
  kv(
    "sources",
    `${group(h.sessions)} sessions, ${group(h.messages)} messages, ${group(h.modelCalls)} model calls (failed ${group(h.failedCalls)}, compactions ${group(h.compactions)}), ${group(h.subagentSessions)} subagent sessions`,
  );
  kv(
    "reconciliation",
    `${group(h.reconciliation.checkedSessions)} checked, ${h.reconciliation.mismatchSessions > 0 ? out.red(group(h.reconciliation.mismatchSessions)) : group(h.reconciliation.mismatchSessions)} mismatch, largest delta ${h.reconciliation.largestDelta} tokens`,
  );
  kv(
    "instruction coverage",
    `${h.instruction.sessionsWithInstructions}/${h.instruction.sessions} sessions, ${h.instruction.callsWithPrefix}/${h.instruction.calls} calls`,
  );
  kv("project label collisions", `${h.projectLabelCollisions.length}`);
  kv("unpriced models", `${h.unpricedModels.length}`);
  kv("detector errors", `${h.detectorErrors.length}`);
  kv("warnings", `${h.warnings.length}`);
  for (const wrong of h.detectorErrors) {
    console.error(`${err.red(`[analysis.detector-error]`)} ${wrong.rule}: ${wrong.message}`);
  }
  for (const collision of h.projectLabelCollisions) {
    console.error(
      `${err.red(`[analysis.project-label-collision]`)} '${collision.label}' maps to project ids: ${collision.projectIds.join(", ")}`,
    );
  }
}

/* ---------- privacy ---------- */

function hasBannedKeys(value, banned, path = "$", found = []) {
  function normalizePath(inputPath) {
    return inputPath.replace(/\[\d+\]/g, "[]").replace(/\.warnings\[\d+\]/g, ".warnings[]");
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      hasBannedKeys(value[index], banned, `${path}[${index}]`, found);
    }
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (banned.has(key)) {
        const normalized = normalizePath(childPath);
        const isAllowedOutput = key === "output" && ALLOWED_OUTPUT_PATHS.has(normalized);
        if (!isAllowedOutput) found.push(childPath);
      }
      hasBannedKeys(child, banned, childPath, found);
    }
  }
  return found;
}

function privacyFailure(found, json) {
  const message = `Found banned keys at ${found.join(", ")}`;
  if (json) {
    console.log(
      JSON.stringify({ ok: false, error: { code: "source.privacy-violation", message } }, null, 2),
    );
  } else {
    console.error(`${err.red(`[source.privacy-violation]`)} ${message}`);
  }
  process.exit(1);
}

function printPrivacy(report, json, dbPath) {
  const found = hasBannedKeys(report, BANNED_KEYS);
  if (found.length > 0) privacyFailure(found, json);
  if (json) {
    console.log(JSON.stringify({ ok: true, db: dbPath, bannedKeysFound: 0 }, null, 2));
    return;
  }
  heading("Privacy check");
  kv("db", dbPath);
  kv("privacy", out.green("ok"));
  kv(
    "notes",
    "Banned keys (text, summary, content, state, output, prompt, oldString) are absent from the serialised report. Message bodies never enter it, and an edit carries only its Edit:<path>#<hash> signature.",
  );
}

/* ---------- JSON payloads: stdout parses on its own ---------- */

function compactEvent(event) {
  return {
    id: event.id,
    sessionId: event.sessionId,
    ts: event.ts,
    type: event.type,
    model: event.model,
    agent: event.agent,
    turnId: event.turnId,
    tokens: {
      input: event.inputTokens,
      output: event.outputTokens,
      thinking: event.thinkingTokens,
      cacheRead: event.cacheReadTokens,
      cacheWrite: event.cacheWrite5mTokens + event.cacheWrite1hTokens,
      total:
        event.inputTokens +
        event.outputTokens +
        event.cacheReadTokens +
        event.cacheWrite5mTokens +
        event.cacheWrite1hTokens,
    },
    cost: { basis: event.cost.basis, total: event.cost.total },
    toolCount: event.tools.length,
  };
}

function failedAttempt(attempt) {
  const tokens = attempt.usage?.tokens;
  return {
    id: attempt.id,
    sessionId: attempt.sessionId,
    ts: attempt.ts,
    type: attempt.type,
    errorType: attempt.errorType ?? "no usage",
    tokens:
      tokens === undefined
        ? null
        : {
            input: tokens.input,
            output: tokens.output,
            thinking: tokens.thinking,
            cacheRead: tokens.cacheRead,
            cacheWrite: tokens.cacheWrite,
          },
  };
}

function jsonPayload(report, priced, mode, dbPath, zone, session) {
  const header = { db: dbPath, timeZone: zone };
  switch (mode) {
    case "totals":
      return { ...header, window: report.window, totals: report.totals, savings: report.savings };
    case "models":
      return { ...header, byModel: report.byModel };
    case "sessions":
      return { ...header, sessions: report.sessions };
    case "cache":
      return { ...header, cache: report.cache };
    case "findings":
      return { ...header, savings: report.savings, findings: report.findings };
    case "events":
      return {
        ...header,
        events: priced.events.map(compactEvent),
        failedAttempts: priced.attempts
          .filter((attempt) => attempt.usage === undefined)
          .map(failedAttempt),
      };
    case "session": {
      const row = report.sessions.find((s) => s.id === session);
      if (row === undefined) {
        throw Object.assign(new Error(`no session with id ${session}`), {
          code: "analysis.unknown-session",
        });
      }
      return {
        ...header,
        session: row,
        events: priced.events.filter((event) => event.sessionId === session).map(compactEvent),
        failedAttempts: priced.attempts
          .filter((attempt) => attempt.usage === undefined && attempt.sessionId === session)
          .map(failedAttempt),
      };
    }
    case "report":
      return report;
    default:
      throw new Error(`unreachable mode ${mode}`);
  }
}

/* ---------- main ---------- */

function expectedFailure(error) {
  if (error instanceof MuninError) {
    console.error(`${err.red(`[${error.code}]`)} ${error.message}`);
    process.exit(1);
  }
  const code = error?.code;
  if (typeof code === "string") {
    console.error(`${err.red(`[${code}]`)} ${error.message}`);
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

  const options = args.db === undefined ? {} : { db: args.db };
  const config = loadConfig(options);

  if (!existsSync(config.dbPath)) {
    console.error(`${err.red(`[source.missing-db]`)} Database not found: ${config.dbPath}`);
    process.exit(1);
  }

  let dataset;
  let report;
  let priced;
  try {
    dataset = readDataset(options);
    warningLines(dataset.warnings);
    if (dataset.warnings.some((warning) => warning.code === "source.missing-db")) {
      console.error(`${err.red(`[source.missing-db]`)} Database not found: ${config.dbPath}`);
      process.exit(1);
    }
    priced = buildEvents(dataset);
    report = buildReport(dataset, { zone: args.tz });
  } catch (error) {
    expectedFailure(error);
    return;
  }

  if (args.mode === "privacy") {
    printPrivacy(report, args.json, config.dbPath);
    return;
  }

  if (args.json) {
    try {
      console.log(
        JSON.stringify(
          jsonPayload(report, priced, args.mode, config.dbPath, args.tz ?? "UTC", args.session),
          null,
          2,
        ),
      );
    } catch (error) {
      expectedFailure(error);
    }
    return;
  }

  switch (args.mode) {
    case "totals":
      printTotals(report, config.dbPath);
      return;
    case "models":
      printModels(report, config.dbPath);
      return;
    case "sessions":
      printSessions(report, config.dbPath);
      return;
    case "cache":
      printCache(report, config.dbPath);
      return;
    case "findings":
      printFindings(report, config.dbPath);
      return;
    case "events":
      printEvents(priced, undefined, "model calls");
      return;
    case "session":
      printSessionReport(report, priced, args.session, config.dbPath);
      return;
    case "report":
      printReportText(report, config.dbPath);
      return;
    default:
      throw new Error(`unreachable mode ${args.mode}`);
  }
}

try {
  main();
} catch (error) {
  expectedFailure(error);
}
