/**
 * `munin live`: the Phase 5 watch loop as a streaming log.
 *
 * One poll per interval. A changed database produces one compact cycle line;
 * an unchanged tick stays quiet. Findings are deliberately not reprinted here:
 * this is a live log, not a report. Warnings and full rescans go to stderr
 * under the diagnostics rules.
 */
import { MuninError, WARNING_CODES } from "@munin/core";
import { createScanWatcher, type WatchPollResult } from "@munin/local";
import { flagValue, type ParsedArgs } from "./args.js";
import { isJson, loadEnvironment } from "./data.js";
import { group, tokens, usd } from "./render.js";
import { scanOptions } from "./scan-support.js";
import { err, out } from "./styles.js";

const DEFAULT_INTERVAL_MS = 2000;
const MIN_INTERVAL_MS = 500;

function intervalOf(flags: ParsedArgs["flags"]): number {
  const raw = flagValue(flags, "interval");
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new MuninError({
      code: "cli.invalid-value",
      kind: "usage",
      message: `--interval must be a whole number of milliseconds: ${raw}`,
    });
  }
  return Math.max(MIN_INTERVAL_MS, value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signedInt(value: number): string {
  return `${value >= 0 ? "+" : ""}${group(value)}`;
}

function signedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(6)}`;
}

function costDelta(value: number): string {
  const text = signedUsd(value);
  if (value > 0) return out.red(text);
  if (value < 0) return out.green(text);
  return out.dim(text);
}

function clock(): string {
  return new Date().toISOString().slice(11, 19);
}

function averageTokensPerSession(result: {
  report: { totals: { sessions: number; totalTokens: number } };
}): number {
  const totals = result.report.totals;
  return totals.sessions > 0 ? totals.totalTokens / totals.sessions : 0;
}

function renderScan(poll: Extract<WatchPollResult, { kind: "scan" }>): void {
  const result = poll.result;
  const newCount = result.newSessionIds.length;
  const updatedCount = result.replacedSessionIds.length;
  const delta = poll.changes?.totalsDelta;
  const parts = [
    `${out.dim(clock())} ${out.bold("scan")} ${result.mode}`,
    `${out.green(`${signedInt(newCount)} new`)}, ${out.blue(`${group(updatedCount)} updated`)}, ${group(result.sessionsRead)} read`,
    `${group(result.totals.calls)} calls${delta === undefined ? "" : ` (${signedInt(delta.calls)})`}`,
    `${usd(result.totals.headlineUsd)}${delta === undefined ? "" : ` (${costDelta(delta.headlineUsd)})`}`,
    `${tokens(averageTokensPerSession(result))} tok/sess${delta === undefined ? "" : ` (${signedInt(Math.round(delta.avgTokensPerSession))})`}`,
  ];
  console.log(parts.join(` ${out.dim("|")} `));
}

function renderLiveJson(poll: WatchPollResult): void {
  if (poll.kind === "scan") {
    process.stdout.write(
      `${JSON.stringify({
        type: "scan",
        mode: poll.result.mode,
        fullRescan: poll.fullRescan,
        sessionsRead: poll.result.sessionsRead,
        newSessionIds: poll.result.newSessionIds,
        replacedSessionIds: poll.result.replacedSessionIds,
        totals: poll.result.totals,
        changes: poll.changes ?? null,
        warnings: poll.result.report.dataHealth.warnings,
      })}\n`,
    );
  } else if (poll.kind === "warning") {
    process.stdout.write(
      `${JSON.stringify({
        type: "warning",
        message: poll.message,
        warningCount: poll.warningCount,
      })}\n`,
    );
  }
}

export async function runLive(args: ParsedArgs): Promise<void> {
  const options = scanOptions(args);
  const interval = intervalOf(args.flags);
  const json = isJson(args);
  const watcher = createScanWatcher(options);
  let stopping = false;
  const seen = new Set<string>();

  /** Print a warning once per process: a persistent condition must not spam. */
  const warn = (text: string): void => {
    if (seen.has(text)) return;
    seen.add(text);
    console.error(err.yellow(text));
  };

  const stop = (signal: string): void => {
    stopping = true;
    if (!json) console.error(`${out.dim(`received ${signal}; stopping after this cycle`)}`);
  };
  const onInt = (): void => stop("SIGINT");
  const onTerm = (): void => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  try {
    if (!json) {
      const config = loadEnvironment(args);
      console.log(
        `  ${out.bold("munin live")} ${out.dim(`| watching ${config.dbPath} every ${interval}ms (Ctrl-C to stop)`)}`,
      );
    }
    while (!stopping) {
      const poll = watcher.poll();
      if (json) {
        renderLiveJson(poll);
      } else if (poll.kind === "scan") {
        if (poll.fullRescan) {
          warn(
            `[${WARNING_CODES.watchFullRescan}] source was replaced or truncated; scanning all sessions`,
          );
        }
        for (const warning of poll.result.report.dataHealth.warnings) {
          const suffix =
            warning.count !== undefined && warning.count > 1 ? ` (x${warning.count})` : "";
          warn(`[${warning.code}] ${warning.message}${suffix}`);
        }
        renderScan(poll);
      } else if (poll.kind === "warning") {
        warn(poll.message);
      }
      if (!stopping) await delay(interval);
    }
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
