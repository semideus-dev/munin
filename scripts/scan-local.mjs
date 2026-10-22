#!/usr/bin/env node
import { createScanWatcher, readScanResults, readScanSnapshots, runScan } from "@munin/local";
import { err, group, heading, kv, out, sub, usd } from "./lib/output.mjs";

function usage() {
  console.log(`Usage: npm run scan -- [options]

Options:
  --db <path>          OpenCode database path
  --state-dir <path>   Munin state directory
  --full               Read all source sessions and reconcile the ledger
  --repair             Rewrite ledger slices when --full finds drift
  --check-privacy      Validate slice/snapshot journals and the candidate cursor
  --watch              Poll the database for changes
  --interval <ms>      Watch interval (default 2000, minimum 500)
  --snapshots          List snapshots and show the latest trend
  --results            Compare applied changes with before/after usage
  --tz <zone>          Day-bucket timezone
  --help               Show this help`);
}

function parseArgs(argv) {
  const options = { interval: 2000 };
  const valueAfter = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--full") options.full = true;
    else if (flag === "--repair") options.repair = true;
    else if (flag === "--check-privacy") options.checkPrivacy = true;
    else if (flag === "--watch") options.watch = true;
    else if (flag === "--snapshots") options.snapshots = true;
    else if (flag === "--results") options.results = true;
    else if (flag === "--db") options.db = valueAfter(flag, index++);
    else if (flag === "--state-dir") options.stateDir = valueAfter(flag, index++);
    else if (flag === "--tz") options.zone = valueAfter(flag, index++);
    else if (flag === "--interval") {
      const value = Number(valueAfter(flag, index++));
      if (!Number.isFinite(value) || !Number.isInteger(value))
        throw new Error("--interval must be an integer number of milliseconds");
      options.interval = Math.max(500, value);
    } else throw new Error(`unknown flag: ${flag}`);
  }

  if (options.repair && !options.full) throw new Error("--repair requires --full");
  if (options.snapshots && options.results)
    throw new Error("choose only one of --snapshots or --results");
  if (
    (options.snapshots || options.results) &&
    (options.full || options.repair || options.watch || options.checkPrivacy)
  ) {
    throw new Error(
      "--snapshots and --results are read-only modes and cannot be combined with scan flags",
    );
  }
  return options;
}

function signedInt(value) {
  return `${value >= 0 ? "+" : ""}${group(value)}`;
}

function signedUsd(value) {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(6)}`;
}

function costDelta(value) {
  const text = signedUsd(value);
  if (value > 0) return out.red(text);
  if (value < 0) return out.green(text);
  return out.dim(text);
}

function averageTokensPerSession(totals) {
  return totals.sessions > 0 ? totals.totalTokens / totals.sessions : 0;
}

function renderSessionsRead(result) {
  const ids = [...new Set([...result.newSessionIds, ...result.replacedSessionIds])];
  sub(out.cyan("Sessions read"));
  if (ids.length === 0) {
    console.log(`  ${out.dim("none (no source sessions changed)")}`);
    return;
  }
  const summaries = new Map(result.report.sessions.map((session) => [session.id, session]));
  const newIds = new Set(result.newSessionIds);
  const shown = ids.slice(0, 12);
  for (const id of shown) {
    const session = summaries.get(id);
    const marker = newIds.has(id) ? out.green("new") : out.cyan("updated");
    const title = session?.title ? `  ${out.dim(session.title)}` : "";
    console.log(`  [${marker}] ${out.bold(id)}${title}`);
    console.log(
      `         ${group(session?.calls ?? 0)} calls, ${group(Math.round(session?.totalTokens ?? 0))} tokens, ${usd(session?.headlineUsd ?? 0)}`,
    );
  }
  if (ids.length > shown.length) {
    console.log(`  ${out.dim(`... and ${group(ids.length - shown.length)} more`)}`);
  }
}

function renderReconciliation(result) {
  if (result.reconciliation.length === 0) return;
  sub(out.cyan("Reconciliation"));
  for (const row of result.reconciliation) {
    const kind = row.kind === "missing-from-source" ? "missing from source" : "events changed";
    console.log(
      `  ${out.yellow(row.sessionId)}: ${row.storedEvents} stored, ${row.freshEvents} fresh (${kind})`,
    );
  }
  console.log(
    `  ${result.repaired ? out.green("repaired") : out.yellow("not repaired; run --full --repair to rewrite")}`,
  );
}

function renderChanges(changes) {
  sub(out.cyan("Since last render"));
  const delta = changes.totalsDelta;
  kv("calls", signedInt(delta.calls));
  kv("tokens/sess", signedInt(Math.round(delta.avgTokensPerSession)));
  kv("cost", costDelta(delta.headlineUsd));
}

function renderTrend(result) {
  if (result.snapshotDiff === null) return;
  const diff = result.snapshotDiff;
  const afterSessions = result.snapshot.state.sessionsTracked;
  const beforeSessions = diff.sessions.before;
  const afterTotal = result.report.totals.totalTokens;
  const beforeTotal = afterTotal - diff.totals.totalTokens;
  const beforeAverage = beforeSessions > 0 ? beforeTotal / beforeSessions : 0;
  const afterAverage = afterSessions > 0 ? afterTotal / afterSessions : 0;
  sub(out.cyan(`Trend from snapshot ${diff.fromId}`));
  kv("sessions", signedInt(diff.sessions.delta));
  kv("calls", signedInt(diff.totals.calls));
  kv("tokens/sess", signedInt(Math.round(afterAverage - beforeAverage)));
  kv("cost", costDelta(diff.totals.headlineUsd));
}

function renderWarnings(warnings) {
  for (const warning of warnings) {
    const count = warning.count === undefined ? "" : ` (${warning.count})`;
    console.error(`${err.yellow(`[${warning.code}]`)} ${warning.message}${count}`);
  }
}

function renderResult(result, changes) {
  const totals = result.totals;
  heading(out.cyan(`Scan (${result.mode})`));
  kv("sessions read", group(result.sessionsRead));
  kv("slices replaced", group(result.slicesReplaced));
  kv(
    "tracked",
    `${group(result.report.dataHealth.sessions)} session(s), ${group(result.report.dataHealth.ledger?.eventsTracked ?? 0)} event(s)`,
  );
  kv("usage", `${group(totals.calls)} calls, ${usd(totals.headlineUsd)}`);
  kv(
    "averages",
    `${group(Math.round(averageTokensPerSession(totals)))} tokens/session, ${group(Math.round(totals.avgTokensPerCall))} tokens/call`,
  );
  renderSessionsRead(result);
  renderReconciliation(result);
  if (changes !== undefined) renderChanges(changes);
  renderTrend(result);
  renderWarnings(result.warnings);
}

function renderSnapshots(options) {
  const state = readScanSnapshots(options);
  if (state.snapshots.length === 0) console.log("No snapshots on record.");
  for (const snapshot of state.snapshots) {
    console.log(
      `#${snapshot.id} ${snapshot.at} ${snapshot.scope.mode}: ${snapshot.state.sessionsTracked} sessions, ${snapshot.state.eventsTracked} events, ${snapshot.totals.calls} calls, ${snapshot.totals.totalTokens} tokens, $${snapshot.totals.headlineUsd.toFixed(6)}`,
    );
  }
  if (state.diff !== null) {
    const diff = state.diff;
    console.log(
      `Latest diff ${diff.fromId} → ${diff.toId}: ${diff.sessions.delta >= 0 ? "+" : ""}${diff.sessions.delta} sessions, ${diff.totals.calls >= 0 ? "+" : ""}${diff.totals.calls} calls, ${diff.totals.totalTokens >= 0 ? "+" : ""}${diff.totals.totalTokens} tokens, ${diff.totals.headlineUsd >= 0 ? "+" : ""}$${diff.totals.headlineUsd.toFixed(6)} headline (${diff.totals.observedUsd >= 0 ? "+" : ""}$${diff.totals.observedUsd.toFixed(6)} observed, ${diff.totals.estimatedUsd >= 0 ? "+" : ""}$${diff.totals.estimatedUsd.toFixed(6)} estimated)`,
    );
    for (const row of diff.byModel) {
      console.log(
        `  ${row.provider}/${row.model}: ${row.calls >= 0 ? "+" : ""}${row.calls} calls, ${row.totalTokens >= 0 ? "+" : ""}${row.totalTokens} tokens, ${row.headlineUsd >= 0 ? "+" : ""}$${row.headlineUsd.toFixed(6)}`,
      );
    }
    if (diff.findings.appeared.length > 0)
      console.log(`  appeared: ${diff.findings.appeared.join(", ")}`);
    if (diff.findings.disappeared.length > 0)
      console.log(`  disappeared: ${diff.findings.disappeared.join(", ")}`);
    if (diff.findings.grew.length > 0) console.log(`  grew: ${diff.findings.grew.join(", ")}`);
  }
  if (state.skippedLines > 0)
    console.error(
      `[ledger.snapshot-lines-skipped] ${state.skippedLines} malformed snapshot line(s)`,
    );
}

function renderResults(options) {
  const state = readScanResults(options);
  if (state.changes.length === 0) {
    console.log("No applied changes on record.");
    return;
  }
  console.log(
    `Results from saved ledger events; ${state.daysRequired} days of source history would be needed for a direct read.`,
  );
  for (const result of state.report.results) {
    const row = result.headline;
    const before = row?.before == null ? "n/a" : `$${row.before.toFixed(6)}`;
    const after = row?.after == null ? "n/a" : `$${row.after.toFixed(6)}`;
    console.log(
      `${result.change.rule} (${result.change.at}): ${result.verdict}; cost per ${result.measure} ${before} → ${after}`,
    );
    if (result.range !== null) {
      console.log(
        `  baseline sensitivity: ${(result.range.low * 100).toFixed(1)}% to ${(result.range.high * 100).toFixed(1)}% (${result.range.shortest.toFixed(0)}-${result.range.longest.toFixed(0)} days)`,
      );
    }
  }
  if (state.skippedLines > 0)
    console.error(`[ledger.slice-lines-skipped] ${state.skippedLines} malformed slice line(s)`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function watch(options) {
  const watcher = createScanWatcher(options);
  let stopping = false;
  const stop = (signal) => {
    stopping = true;
    console.error(`\nReceived ${signal}; stopping after the current scan cycle.`);
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    console.log(`Watching OpenCode database every ${options.interval}ms (Ctrl-C to stop)`);
    while (!stopping) {
      const result = watcher.poll();
      if (result.kind === "scan") {
        if (result.fullRescan)
          console.error(
            "[watch.full-rescan] Source was replaced or truncated; scanning all sessions",
          );
        renderResult(result.result, result.changes);
      } else if (result.kind === "warning") {
        console.error(`[watch.warning:${result.warningCount}] ${result.message}`);
      }
      if (!stopping) await delay(options.interval);
    }
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 64;
    return;
  }
  if (options.help) {
    usage();
    return;
  }

  try {
    if (options.snapshots) renderSnapshots(options);
    else if (options.results) renderResults(options);
    else if (options.watch) await watch(options);
    else renderResult(runScan(options));
  } catch (error) {
    console.error(`scan failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
