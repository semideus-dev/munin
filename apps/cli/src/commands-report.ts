/**
 * Read-only report commands.
 *
 * Every handler loads the shared report through `data.ts` and renders fields it
 * already carries. Nothing here re-runs analysis or writes state, so the
 * harness and the CLI stay on one report-building path.
 */
import {
  BANNED_KEYS,
  MuninError,
  PRICING_AS_OF,
  PRICING_VERSION,
  topCalls,
  type MuninReport,
  type Recommendation,
  type ReportFinding,
  type SpendBucket,
  type UsageEvent,
} from "@munin/core";
import {
  inspectSourceDatabase,
  runScan as runSourceScan,
  type MuninPaths,
  type ScanResult,
} from "@munin/local";
import { flagValue, type ParsedArgs } from "./args.js";
import { isJson, loadData, loadEnvironment, positiveInteger } from "./data.js";
import { scanFailure, scanOptions } from "./scan-support.js";
import {
  emitJson,
  group,
  heading,
  kv,
  pct,
  printWarnings,
  sub,
  table,
  tokens,
  usd,
} from "./render.js";
import { out } from "./styles.js";

const KIND_OF_WORK_LIMIT = 10;

function tierStyle(tier: string): (text: string) => string {
  if (tier === "fix") return out.green;
  if (tier === "try") return out.yellow;
  return out.blue;
}

function emptyNotice(database: string, zone: string): void {
  console.log("");
  console.log(`  ${out.bold("munin")} ${out.dim("| no usage found")}`);
  kv("database", database);
  kv("time zone", zone);
  console.log("");
}

function eventTotalTokens(event: UsageEvent): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheWrite5mTokens +
    event.cacheWrite1hTokens
  );
}

/* ---------- shared renderers ---------- */

function printFindings(findings: readonly ReportFinding[], verbose: boolean): void {
  if (findings.length === 0) {
    console.log("  none");
    return;
  }
  for (const finding of findings) {
    console.log("");
    console.log(
      `  ${tierStyle(finding.tier)(`[${finding.tier}]`)} ${out.bold(finding.title)}  ${out.dim(finding.rule)}`,
    );
    console.log(
      `    ${out.dim("severity")} ${finding.severity}  ${out.dim("confidence")} ${finding.savings.confidence}  ${out.dim("verification")} ${finding.verification}  ${out.dim("advisory")} ${finding.advisory ? "yes" : "no"}`,
    );
    kv("detail", finding.detail);
    kv("why", finding.why);
    kv(
      "affected",
      `${group(finding.affected.calls)} calls, models ${finding.affected.models.join(", ") || "none"}, share ${pct(finding.affected.share)}`,
    );
    kv(
      "savings",
      `window ${usd(finding.savings.windowUsd)} | monthly ${usd(finding.savings.monthlyUsd)} | tokens ${tokens(finding.savings.tokensWasted)}`,
    );
    if (finding.savings.unpriced) console.log(`    ${out.yellow("unpriced: token-only")}`);
    kv("fix", finding.fix);
    if (verbose) {
      kv("evidence", `${finding.savings.evidence.kind}: ${finding.savings.evidence.basis}`);
      kv("calculation", finding.savings.calculation);
      for (const assumption of finding.savings.assumptions) kv("assumption", assumption);
      if (finding.overlapWith !== undefined && finding.overlapWith.length > 0) {
        kv("overlap", `shares claimed calls with ${finding.overlapWith.join(", ")}`);
      }
    }
    if (finding.observations.length > 0) {
      kv("observations", `${finding.observations.length} (first 5 shown)`);
      for (const observation of finding.observations.slice(0, 5)) {
        console.log(`      ${observation}`);
      }
    }
  }
}

function printRecommendations(recommendations: readonly Recommendation[]): void {
  if (recommendations.length === 0) {
    console.log("  none");
    return;
  }
  for (const recommendation of recommendations) {
    console.log(
      `  ${tierStyle(recommendation.tier)(`[${recommendation.tier}]`)} ${recommendation.action}  ${out.dim(recommendation.rule)}`,
    );
    kv("rationale", recommendation.rationale);
    kv(
      "confidence",
      `${recommendation.confidence} | ${usd(recommendation.windowUsd)} window | ${group(recommendation.affectedCalls)} calls`,
    );
    kv("actions", recommendation.actions.join(", "));
  }
}

function printDataHealth(report: MuninReport): void {
  const health = report.dataHealth;
  kv("schema", health.schema);
  kv(
    "sources",
    `${group(health.sessions)} sessions, ${group(health.messages)} messages, ${group(health.modelCalls)} model calls (failed ${group(health.failedCalls)}, compactions ${group(health.compactions)})`,
  );
  kv(
    "reconciliation",
    `${group(health.reconciliation.checkedSessions)} checked, ${group(health.reconciliation.mismatchSessions)} mismatch, largest delta ${group(health.reconciliation.largestDelta)} tokens`,
  );
  kv(
    "instruction coverage",
    `${health.instruction.sessionsWithInstructions}/${health.instruction.sessions} sessions, ${health.instruction.callsWithPrefix}/${health.instruction.calls} calls`,
  );
  kv("project label collisions", String(health.projectLabelCollisions.length));
  kv("unpriced models", String(health.unpricedModels.length));
  kv("detector errors", String(health.detectorErrors.length));
  kv("warnings", String(health.warnings.length));
}

function printBucketLevel(label: string, buckets: readonly SpendBucket[]): void {
  sub(label);
  if (buckets.length === 0) {
    console.log("  none");
    return;
  }
  const rows = buckets
    .slice(0, KIND_OF_WORK_LIMIT)
    .map((row) => [
      row.label ?? row.key,
      pct(row.spendShare),
      group(row.calls),
      tokens(row.totalTokens),
      usd(row.headlineUsd),
    ]);
  table(["key", "share", "calls", "tokens", "cost"], rows, [
    "left",
    "right",
    "right",
    "right",
    "right",
  ]);
}

/* ---------- profile ---------- */

function biggestWin(report: MuninReport):
  | (Pick<ReportFinding, "rule" | "title" | "tier" | "detail" | "why" | "fix"> & {
      confidence: ReportFinding["savings"]["confidence"];
      monthlyUsd: number;
      affectedCalls: number;
    })
  | null {
  const candidates = report.findings
    .filter((finding) => !finding.advisory && finding.savings.monthlyUsd > 0)
    .sort(
      (left, right) =>
        right.savings.monthlyUsd - left.savings.monthlyUsd || left.rule.localeCompare(right.rule),
    );
  const finding = candidates[0];
  if (finding === undefined) return null;
  return {
    rule: finding.rule,
    title: finding.title,
    tier: finding.tier,
    detail: finding.detail,
    why: finding.why,
    fix: finding.fix,
    confidence: finding.savings.confidence,
    monthlyUsd: finding.savings.monthlyUsd,
    affectedCalls: finding.affected.calls,
  };
}

function nextStep(report: MuninReport): {
  rule: string;
  action: string;
  rationale: string;
  tier: string;
  windowUsd: number;
} | null {
  const recommendation = report.recommendations[0];
  if (recommendation === undefined) return null;
  return {
    rule: recommendation.rule,
    action: recommendation.action,
    rationale: recommendation.rationale,
    tier: recommendation.tier,
    windowUsd: recommendation.windowUsd,
  };
}

export function profileData(report: MuninReport): {
  window: MuninReport["window"];
  totals: MuninReport["totals"];
  savings: MuninReport["savings"];
  biggestWin: ReturnType<typeof biggestWin>;
  nextStep: ReturnType<typeof nextStep>;
} {
  return {
    window: report.window,
    totals: report.totals,
    savings: report.savings,
    biggestWin: biggestWin(report),
    nextStep: nextStep(report),
  };
}

function savingsRow(label: string, amount: string, note: string, paint: (text: string) => string) {
  console.log(`    ${out.bold(label.padEnd(22))} ${paint(amount).padEnd(14)} ${out.dim(note)}`);
}

function printProfile(report: MuninReport, data: ReturnType<typeof profileData>): void {
  const totals = report.totals;
  const savings = report.savings;
  console.log("");
  console.log(`  ${out.bold("munin")} ${out.dim("| profile")}`);
  console.log(
    `  ${report.window.start ?? "-"} to ${report.window.end ?? "-"}  (${report.window.days.toFixed(2)} days)`,
  );
  console.log("");
  console.log(
    `  Observed ${usd(totals.observedUsd)} in this window ${out.dim("·")} ${group(totals.calls)} calls ${out.dim("·")} ${tokens(totals.totalTokens)} tokens`,
  );
  console.log(
    `  ${out.dim(`billed = what the source recorded (coverage ${pct(totals.observedCoverage)}); headline ${usd(totals.headlineUsd)}`)}`,
  );
  console.log("");
  console.log(`  ${out.bold("Savings found")}`);
  savingsRow(
    "Clear waste",
    `${usd(savings.fix.monthlyUsd)}/mo`,
    "fix it, nothing to lose",
    (text) => out.green(text),
  );
  savingsRow(
    "Likely, if you try",
    `${savings.try.monthlyUsd > 0 ? "+" : ""}${usd(savings.try.monthlyUsd)}/mo`,
    "changes what the model does",
    (text) => out.yellow(text),
  );
  savingsRow(
    "Up to, if you test",
    `${usd(savings.test.monthlyUsd)}/mo`,
    savings.test.claimedCalls === 0 ? "(no test-tier findings)" : "trade-offs from your own usage",
    (text) => out.blue(text),
  );
  console.log("");
  if (data.biggestWin === null) {
    console.log(`  ${out.dim("Biggest win  none: no waste found in this window.")}`);
  } else {
    const win = data.biggestWin;
    console.log(
      `  ${out.bold("Biggest win")}  ${win.title} ${out.dim(`· ${win.tier} · ${win.confidence} confidence`)}`,
    );
    console.log(`    ${win.detail}`);
    console.log(`    ${out.dim(`fix: ${win.fix}`)}`);
  }
  console.log("");
  console.log(`  ${out.bold("Where it goes")}`);
  for (const provider of report.byProvider.slice(0, 5)) {
    console.log(
      `    ${provider.key.padEnd(18)} ${pct(provider.spendShare).padStart(8)}  ${usd(provider.headlineUsd)}`,
    );
  }
  console.log("");
  if (data.nextStep === null) {
    console.log(`  ${out.dim("Next step  nothing to act on right now.")}`);
  } else {
    console.log(
      `  ${out.bold("Next step")}  ${data.nextStep.action} ${out.dim(`· ${data.nextStep.rule}`)}`,
    );
    console.log(`    ${out.dim(data.nextStep.rationale)}`);
  }
  console.log("");
}

export function runProfile(args: ParsedArgs): void {
  const data = loadData(args);
  if (isJson(args)) return emitJson(profileData(data.report), data.warnings);
  printWarnings(data.warnings);
  if (data.report.totals.calls === 0) return emptyNotice(data.config.dbPath, data.tz);
  printProfile(data.report, profileData(data.report));
}

/* ---------- scan ---------- */

function scanData(result: ScanResult): Record<string, unknown> {
  const report = result.report;
  return {
    window: report.window,
    totals: report.totals,
    savings: report.savings,
    findings: report.findings,
    recommendations: report.recommendations,
    dataHealth: report.dataHealth,
    scan: {
      mode: result.mode,
      sessionsRead: result.sessionsRead,
      slicesReplaced: result.slicesReplaced,
      newSessionIds: result.newSessionIds,
      replacedSessionIds: result.replacedSessionIds,
      reconciliation: result.reconciliation,
      repaired: result.repaired,
      cursor: result.cursor,
      snapshot: result.snapshot,
      snapshotDiff: result.snapshotDiff,
    },
  };
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

function printSessionsRead(result: ScanResult): void {
  const ids = [...new Set([...result.newSessionIds, ...result.replacedSessionIds])];
  sub("Sessions read");
  if (ids.length === 0) {
    console.log(`  ${out.dim("none (no source sessions changed)")}`);
    return;
  }
  const summaries = new Map(result.report.sessions.map((session) => [session.id, session]));
  const newIds = new Set(result.newSessionIds);
  const shown = ids.slice(0, 12);
  for (const id of shown) {
    const session = summaries.get(id);
    const marker = newIds.has(id) ? out.green("new") : out.blue("updated");
    const title = session?.title ? `  ${out.dim(session.title)}` : "";
    console.log(`  ${out.dim("[")}${marker}${out.dim("]")} ${out.bold(id)}${title}`);
    if (session !== undefined) {
      console.log(
        `         ${group(session.calls)} calls, ${tokens(session.totalTokens)}, ${usd(session.headlineUsd)}`,
      );
    }
  }
  if (ids.length > shown.length) {
    console.log(`  ${out.dim(`... and ${group(ids.length - shown.length)} more`)}`);
  }
}

function printReconciliation(result: ScanResult): void {
  if (result.reconciliation.length === 0) return;
  sub("Reconciliation");
  for (const row of result.reconciliation) {
    const kind = row.kind === "missing-from-source" ? "missing from source" : "events changed";
    console.log(
      `  ${out.yellow(row.sessionId)}: ${group(row.storedEvents)} stored, ${group(row.freshEvents)} fresh (${kind})`,
    );
  }
  console.log(
    `  ${result.repaired ? out.green("repaired") : out.yellow("not repaired; run --full --repair to rewrite")}`,
  );
}

function printTrend(result: ScanResult): void {
  const diff = result.snapshotDiff;
  if (diff === null) return;
  const afterSessions = result.snapshot.state.sessionsTracked;
  const beforeSessions = diff.sessions.before;
  const afterTotal = result.snapshot.totals.totalTokens;
  const beforeTotal = afterTotal - diff.totals.totalTokens;
  const afterAverage = afterSessions > 0 ? afterTotal / afterSessions : 0;
  const beforeAverage = beforeSessions > 0 ? beforeTotal / beforeSessions : 0;
  sub(`Trend from snapshot ${diff.fromId}`);
  kv("sessions", signedInt(diff.sessions.delta));
  kv("calls", signedInt(diff.totals.calls));
  kv("tokens/sess", signedInt(Math.round(afterAverage - beforeAverage)));
  kv("cost", costDelta(diff.totals.headlineUsd));
}

function printScanSummary(result: ScanResult): void {
  const report = result.report;
  heading(`Scan (${result.mode})`);
  kv("sessions read", group(result.sessionsRead));
  kv("slices replaced", group(result.slicesReplaced));
  kv(
    "tracked",
    `${group(report.dataHealth.sessions)} sessions, ${group(report.dataHealth.ledger?.eventsTracked ?? 0)} events`,
  );
  kv("usage", `${group(report.totals.calls)} calls, ${usd(report.totals.headlineUsd)} headline`);
  printSessionsRead(result);
  printReconciliation(result);
  printTrend(result);
}

export function runScan(args: ParsedArgs): void {
  const options = scanOptions(args);
  let result: ScanResult;
  try {
    result = runSourceScan(options);
  } catch (error) {
    throw scanFailure(error);
  }
  if (isJson(args)) return emitJson(scanData(result), result.report.dataHealth.warnings);
  printWarnings(result.report.dataHealth.warnings);

  const report = result.report;
  const config = loadEnvironment(args);
  printScanSummary(result);
  if (report.totals.calls === 0) {
    emptyNotice(config.dbPath, report.timeZone);
    return;
  }
  const verbose = args.flags.why !== undefined;

  heading("Spend");
  kv("database", config.dbPath);
  kv(
    "window",
    `${report.window.start ?? "-"} .. ${report.window.end ?? "-"} (${report.window.days.toFixed(2)} days)`,
  );
  kv("calls", `${group(report.totals.calls)} calls, ${group(report.totals.sessions)} sessions`);
  kv(
    "costs",
    `observed ${usd(report.totals.observedUsd)} | estimated ${usd(report.totals.estimatedUsd)} | headline ${out.bold(usd(report.totals.headlineUsd))}`,
  );
  kv(
    "tokens",
    `${tokens(report.totals.totalTokens)} total, avg ${group(Math.round(report.totals.avgTokensPerCall))}/call`,
  );

  heading("Findings");
  printFindings(report.findings, verbose);

  heading("Recommendations");
  printRecommendations(report.recommendations);

  heading("Data health");
  printDataHealth(report);
}

/* ---------- why ---------- */

export function whyData(report: MuninReport): {
  window: MuninReport["window"];
  totals: MuninReport["totals"];
  byProvider: MuninReport["byProvider"];
  byModel: MuninReport["byModel"];
  byProject: MuninReport["byProject"];
  byKindOfWork: MuninReport["byAgent"];
} {
  return {
    window: report.window,
    totals: report.totals,
    byProvider: report.byProvider,
    byModel: report.byModel,
    byProject: report.byProject,
    byKindOfWork: report.byAgent,
  };
}

export function runWhy(args: ParsedArgs): void {
  const data = loadData(args);
  if (isJson(args)) return emitJson(whyData(data.report), data.warnings);
  printWarnings(data.warnings);
  const report = data.report;
  if (report.totals.calls === 0) return emptyNotice(data.config.dbPath, data.tz);

  const depth = positiveInteger(args.flags, "depth") ?? 2;
  const requests = positiveInteger(args.flags, "requests") ?? 3;

  heading("Where the money goes");
  kv("total", `${usd(report.totals.headlineUsd)}  ${group(report.totals.calls)} calls`);
  if (depth >= 1) printBucketLevel("by provider", report.byProvider);
  if (depth >= 2) printBucketLevel("by model", report.byModel);
  if (depth >= 3) printBucketLevel("by project", report.byProject);
  if (depth >= 4) printBucketLevel("by kind of work", report.byAgent);

  const top = topCalls(data.priced.events, requests).byCost;
  sub(`top ${requests} calls by cost`);
  table(
    ["event", "ts", "model", "tokens", "cost"],
    top.map((event) => [
      event.id,
      event.ts,
      `${event.provider}/${event.model}`,
      tokens(eventTotalTokens(event)),
      usd(event.cost.total),
    ]),
    ["left", "left", "left", "right", "right"],
  );
}

/* ---------- sessions ---------- */

export function runSessions(args: ParsedArgs): void {
  const data = loadData(args);
  const report = data.report;
  if (isJson(args)) {
    return emitJson(
      { window: report.window, totals: report.totals, sessions: report.sessions },
      data.warnings,
    );
  }
  printWarnings(data.warnings);
  if (report.totals.calls === 0) return emptyNotice(data.config.dbPath, data.tz);

  const top = positiveInteger(args.flags, "top") ?? 10;
  const sessions = [...report.sessions]
    .sort((left, right) => right.headlineUsd - left.headlineUsd || left.id.localeCompare(right.id))
    .slice(0, top);

  heading("Sessions");
  kv(
    "window",
    `${report.window.start ?? "-"} .. ${report.window.end ?? "-"} (${report.window.days.toFixed(2)} days)`,
  );
  kv(
    "calls",
    `${group(report.totals.calls)} calls across ${group(report.totals.sessions)} sessions`,
  );
  table(
    ["#", "session", "project", "agent", "calls", "tokens", "cache hit", "cost"],
    sessions.map((session, index) => [
      String(index + 1),
      session.id,
      session.project,
      session.agents.join("+") || "-",
      group(session.calls),
      tokens(session.totalTokens),
      pct(session.cacheHitRate),
      usd(session.headlineUsd),
    ]),
    ["right", "left", "left", "left", "right", "right", "right", "right"],
  );

  heading("Cache story");
  const cache = report.cache;
  kv("hit rate", pct(cache.hitRate));
  kv(
    "traffic",
    `input ${tokens(cache.inputTokens)} | read ${tokens(cache.readTokens)} | write ${tokens(cache.writeTokens)}`,
  );
  kv(
    "cost",
    `read ${usd(cache.estimatedReadUsd)} | write ${usd(cache.estimatedWriteUsd)} | share of estimate ${pct(cache.shareOfEstimate)}`,
  );

  heading("Cold returns");
  const cold = report.findings.find((finding) => finding.rule === "cold-resume");
  if (cold === undefined) {
    console.log("  none");
  } else {
    console.log(`  ${out.bold(cold.title)}  ${out.dim(cold.rule)}`);
    kv("detail", cold.detail);
    kv(
      "savings",
      `monthly ${usd(cold.savings.monthlyUsd)} | tokens ${tokens(cold.savings.tokensWasted)}`,
    );
    kv("fix", cold.fix);
    for (const observation of cold.observations.slice(0, 5)) {
      console.log(`      ${observation}`);
    }
  }
}

/* ---------- tokens ---------- */

export function runTokens(args: ParsedArgs): void {
  const data = loadData(args);
  const report = data.report;
  const top = topCalls(data.priced.events, 10);
  if (isJson(args)) {
    return emitJson(
      {
        window: report.window,
        totals: report.totals,
        byModel: report.byModel,
        byProvider: report.byProvider,
        topByCost: top.byCost,
        topByTokens: top.byTokens,
      },
      data.warnings,
    );
  }
  printWarnings(data.warnings);
  if (report.totals.calls === 0) return emptyNotice(data.config.dbPath, data.tz);

  heading("Token analytics");
  kv("total", `${tokens(report.totals.totalTokens)} over ${group(report.totals.calls)} calls`);
  kv(
    "input side",
    `input ${tokens(report.totals.inputTokens)} | cache read ${tokens(report.totals.cacheReadTokens)} | cache write ${tokens(report.totals.cacheWriteTokens)}`,
  );
  kv(
    "output",
    `${tokens(report.totals.outputTokens)} (thinking ${tokens(report.totals.thinkingTokens)}, share ${pct(report.totals.thinkingShare)})`,
  );
  kv("average", `${group(Math.round(report.totals.avgTokensPerCall))} tokens/call`);

  sub("top calls by cost");
  table(
    ["event", "ts", "model", "tokens", "cost"],
    top.byCost.map((event) => [
      event.id,
      event.ts,
      `${event.provider}/${event.model}`,
      tokens(eventTotalTokens(event)),
      usd(event.cost.total),
    ]),
    ["left", "left", "left", "right", "right"],
  );
  sub("top calls by tokens");
  table(
    ["event", "ts", "model", "tokens", "cost"],
    top.byTokens.map((event) => [
      event.id,
      event.ts,
      `${event.provider}/${event.model}`,
      tokens(eventTotalTokens(event)),
      usd(event.cost.total),
    ]),
    ["left", "left", "left", "right", "right"],
  );
}

/* ---------- waste ---------- */

export function runWaste(args: ParsedArgs): void {
  const data = loadData(args);
  const report = data.report;
  const findings = report.findings.filter((finding) => !finding.advisory);
  if (isJson(args)) {
    return emitJson(
      { savings: report.savings, findings, recommendations: report.recommendations },
      data.warnings,
    );
  }
  printWarnings(data.warnings);
  if (report.totals.calls === 0) return emptyNotice(data.config.dbPath, data.tz);

  heading("Waste");
  const savings = report.savings;
  kv(
    "recoverable",
    `fix ${usd(savings.fix.monthlyUsd)}/mo | try ${usd(savings.try.monthlyUsd)}/mo | up to ${usd(savings.test.monthlyUsd)}/mo (never summed)`,
  );
  printFindings(findings, args.flags.why !== undefined);
}

/* ---------- show ---------- */

export function runShow(args: ParsedArgs): void {
  const rule = args.positional[0];
  if (rule === undefined) {
    throw new MuninError({
      code: "cli.missing-argument",
      kind: "usage",
      message: "show requires a rule, for example: munin show cold-resume",
    });
  }
  const data = loadData(args);
  const finding = data.report.findings.find((row) => row.rule === rule);
  if (finding === undefined) {
    throw new MuninError({
      code: "rules.unknown-rule",
      kind: "usage",
      message: `Unknown rule "${rule}". Run "munin waste" to list rules.`,
    });
  }
  if (isJson(args)) return emitJson({ rule, finding }, data.warnings);
  printWarnings(data.warnings);

  heading(`Show ${rule}`);
  printFindings([finding], true);

  if (finding.claimByEvent.length > 0) {
    const eventsById = new Map(data.priced.events.map((event) => [event.id, event]));
    sub(
      `claimed calls (first ${Math.min(finding.claimByEvent.length, 10)} of ${group(finding.claimByEvent.length)})`,
    );
    table(
      ["event", "ts", "model", "tokens", "claim"],
      finding.claimByEvent.slice(0, 10).map((claim) => {
        const event = eventsById.get(claim.eventId);
        return [
          claim.eventId,
          event?.ts ?? "-",
          event === undefined ? "-" : `${event.provider}/${event.model}`,
          event === undefined ? "-" : tokens(eventTotalTokens(event)),
          usd(claim.usd),
        ];
      }),
      ["left", "left", "left", "right", "right"],
    );
  }
}

/* ---------- providers ---------- */

export function providersData(
  database: string,
  databaseState: string,
  paths: MuninPaths,
): Record<string, unknown> {
  return {
    database,
    databaseState,
    stateDir: paths.stateDir,
    settingsPath: paths.settingsPath,
    schemas: ["v1", "v2", "mixed"],
    readers: [
      "opencode-v1: session, message and part tables",
      "opencode-v2: session_v2, session_message and tool tables",
      "instructions: instruction-prefix shape and hash",
    ],
    neverReads: ["prompt text", "completions", "tool output", "file contents"],
    pricing: { asOf: PRICING_AS_OF, version: PRICING_VERSION },
  };
}

export function runProviders(args: ParsedArgs): void {
  const config = loadEnvironment(args);
  const state = inspectSourceDatabase(config.dbPath);
  const data = providersData(config.dbPath, state.kind, config.paths);
  if (isJson(args)) return emitJson(data, []);
  printWarnings(config.warnings);

  heading("Providers");
  kv("database", `${config.dbPath} (${state.kind})`);
  kv("state", config.paths.stateDir);
  kv("settings", config.paths.settingsPath);
  kv("schema", "v1 and v2 OpenCode tables, merged when both exist");
  kv("reads", "sessions, messages, tool call metadata, instruction-prefix shape");
  kv("never reads", "prompt text, completions, tool output, file contents");
  kv("pricing", `${PRICING_AS_OF} v${PRICING_VERSION}`);
}

/* ---------- privacy ---------- */

export function privacyData(paths: MuninPaths): Record<string, unknown> {
  return {
    network: "none",
    reads: [
      "OpenCode database (read-only): sessions, messages, tool metadata, instruction-prefix shape",
    ],
    neverReads: ["prompt text", "completions", "tool output", "file contents"],
    stores: [
      `${paths.stateDir} - Munin's derived ledger, snapshots, cursors and settings`,
      `${paths.settingsPath} - days and time zone, written only by apply/undo`,
    ],
    bannedKeys: [...BANNED_KEYS].sort(),
    retention: `Until you delete ${paths.stateDir}`,
  };
}

export function runPrivacy(args: ParsedArgs): void {
  const config = loadEnvironment(args);
  const data = privacyData(config.paths);
  if (isJson(args)) return emitJson(data, []);
  printWarnings(config.warnings);

  console.log("");
  console.log(`  ${out.bold("munin")} ${out.dim("| data handling")}`);
  console.log("");
  kv("Network", "None. No analytics, telemetry or crash reporting.");
  kv("Reads", "OpenCode database, read-only: sessions, messages, tool metadata, prefix shape.");
  kv("Never reads", "Prompt text, completions, tool output, file contents.");
  kv("Stores", `${config.paths.stateDir} (derived state) and ${config.paths.settingsPath}.`);
  kv("Prefix hash", "One-way; it cannot reconstruct a prompt.");
  kv("Retention", `Until you delete ${config.paths.stateDir}.`);
  console.log("");
  console.log(`  ${out.bold("Banned from stored and serialised data")}`);
  for (const line of renderBannedKeys([...BANNED_KEYS].sort())) {
    console.log(`    ${out.dim(line)}`);
  }
  console.log("");
}

function renderBannedKeys(keys: readonly string[]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const key of keys) {
    if (line === "") line = key;
    else if (line.length + 2 + key.length <= 64) line += `, ${key}`;
    else {
      lines.push(line);
      line = key;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
