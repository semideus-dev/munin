// The shared application service is the one read path behind both the CLI and
// the desktop. These tests pin its contract: DTOs forward report numbers
// untouched, reads never scan or write, privacy-sensitive bodies never cross
// the boundary, and runtime failures keep their existing codes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BANNED_KEYS, MuninError } from "@munin/core";
import { createMuninService, toScanError, toServiceError } from "@munin/application";
import {
  createV1FixtureDb,
  createTextFileFixture,
  createV2FixtureDb,
} from "../fixtures/opencode-db.mjs";

const cleanup = [];
after(() => {
  for (const fn of cleanup) fn();
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixture(builder) {
  const value = builder();
  cleanup.push(() => value.cleanup());
  return value;
}

const clock = () => new Date("2026-01-02T03:04:05.000Z");

function readOptions(dbPath, stateDir) {
  return { db: dbPath, stateDir };
}

function walk(value, visit, path = "dto") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visit(key, path);
      walk(child, visit, `${path}.${key}`);
    }
  }
}

function assertNoBannedKeys(dto, label) {
  walk(dto, (key, path) => {
    assert.equal(BANNED_KEYS.has(key), false, `${label}: banned key "${key}" at ${path}`);
  });
}

function assertJsonSafe(dto, label) {
  const roundTripped = JSON.parse(JSON.stringify(dto));
  assert.deepEqual(roundTripped, dto, `${label} must survive JSON serialisation`);
}

function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A v1 database with four identical read calls: one repeated-tool-call finding. */
function createRepeatedReadFixture() {
  const dir = tempDir("munin-app-findings-");
  const dbPath = join(dir, "opencode-v1.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, title TEXT,
      directory TEXT, agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      type TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, seq INTEGER NOT NULL,
      type TEXT NOT NULL, data TEXT NOT NULL, cost REAL
    );
  `);
  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("p1", "/work/demo");
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, title, directory, agent, model, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "ses-1",
    "p1",
    null,
    "repeat read",
    "/work/demo",
    "build",
    JSON.stringify({ providerID: "openai", id: "gpt-4.1" }),
    1_700_000_000_000,
    1_700_000_500_000,
  );
  for (let index = 0; index < 4; index += 1) {
    const messageId = `msg-${index}`;
    db.prepare(
      "INSERT INTO message (id, session_id, seq, type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      messageId,
      "ses-1",
      index,
      "assistant",
      1_700_000_000_000 + index * 1000,
      1_700_000_000_000 + index * 1000 + 500,
    );
    db.prepare(
      "INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      `tool-${index}`,
      messageId,
      1,
      "tool",
      JSON.stringify({
        id: `t-${index}`,
        name: "read",
        state: {
          input: { path: "/work/demo/a.ts", offset: 0, limit: 200 },
          status: "ok",
          content: "x".repeat(400),
        },
      }),
      null,
    );
    db.prepare(
      "INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      `step-${index}`,
      messageId,
      2,
      "step-finish",
      JSON.stringify({
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        model: { providerID: "openai", id: "gpt-4.1" },
        finish: "stop",
        time: { completed: 1_700_000_000_000 + index * 1000 + 900 },
      }),
      0,
    );
  }
  db.close();
  return dbPath;
}

test("overview, usage and findings forward report numbers without recalculation", async () => {
  const source = fixture(createV2FixtureDb);
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService({ now: clock });
  const read = readOptions(source.dbPath, stateDir);

  const report = await service.getFullReport(read);
  const overview = await service.getOverview(read);
  const usage = await service.getUsage(read);
  const findings = await service.getFindings(read);
  const sessions = await service.getSessions(read);

  assert.deepEqual(overview.totals, report.totals);
  assert.deepEqual(overview.window, report.window);
  assert.deepEqual(overview.health, report.dataHealth);
  assert.equal(overview.timeZone, report.timeZone);
  assert.equal(overview.pricing.asOf, report.pricingAsOf);
  assert.equal(overview.pricing.version, report.pricingVersion);
  assert.deepEqual(overview.savings.fix, report.savings.fix);
  assert.deepEqual(overview.savings.try, report.savings.try);
  assert.deepEqual(overview.savings.test, report.savings.test);
  assert.deepEqual(overview.savings.all, report.savings.all);
  assert.equal(overview.savings.tokensWasted, report.savings.tokensWasted);
  assert.equal(overview.cost.headlineUsd, report.totals.headlineUsd);
  assert.equal(overview.cost.observedUsd, report.totals.observedUsd);
  assert.equal(overview.cost.estimatedUsd, report.totals.estimatedUsd);

  assert.deepEqual(usage.totals, report.totals);
  assert.deepEqual(usage.byModel, report.byModel);
  assert.deepEqual(usage.byProvider, report.byProvider);
  assert.deepEqual(usage.byProject, report.byProject);
  assert.deepEqual(usage.byAgent, report.byAgent);
  assert.deepEqual(usage.byDay, report.byDay);
  assert.deepEqual(usage.bySession, report.bySession);
  assert.deepEqual(usage.cache, report.cache);
  assert.deepEqual(usage.sessions, report.sessions);
  assert.deepEqual(sessions, report.sessions);

  assert.deepEqual(findings.findings, report.findings);
  assert.deepEqual(findings.recommendations, report.recommendations);
  assert.deepEqual(findings.savings, report.savings);

  const top = report.recommendations[0];
  if (top === undefined) {
    assert.equal(overview.topFinding, null);
  } else {
    assert.equal(overview.topFinding.rule, top.rule);
    assert.equal(overview.topFinding.windowUsd, top.windowUsd);
    assert.equal(overview.topFinding.monthlyUsd, top.monthlyUsd);
    assert.equal(overview.topFinding.affectedCalls, top.affectedCalls);
  }

  for (const [label, dto] of [
    ["overview", overview],
    ["usage", usage],
    ["findings", findings],
  ]) {
    assertJsonSafe(dto, label);
    assertNoBannedKeys(dto, label);
  }
});

test("thinking is priced output and is never added twice", async () => {
  const source = fixture(createV2FixtureDb);
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService({ now: clock });
  const overview = await service.getOverview(readOptions(source.dbPath, stateDir));
  const totals = overview.totals;
  const mix = overview.tokenMix;

  assert.ok(totals.thinkingTokens > 0, "fixture must exercise thinking tokens");
  assert.equal(mix.inputTokens, totals.inputTokens);
  assert.equal(mix.outputTokens, totals.outputTokens);
  assert.equal(mix.thinkingTokens, totals.thinkingTokens);
  assert.equal(mix.cacheReadTokens, totals.cacheReadTokens);
  assert.equal(mix.cacheWriteTokens, totals.cacheWriteTokens);
  assert.equal(
    mix.totalTokens,
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
  );
  assert.notEqual(
    mix.totalTokens,
    totals.inputTokens +
      totals.outputTokens +
      totals.thinkingTokens +
      totals.cacheReadTokens +
      totals.cacheWriteTokens,
    "thinking must not be counted a second time",
  );
  assert.equal(overview.efficiency.thinkingShare, totals.thinkingShare);
});

test("session detail separates billable calls from failed attempts and leaks no bodies", async () => {
  const base = fixture(createV1FixtureDb);
  const copyDir = tempDir("munin-app-session-");
  const dbPath = join(copyDir, "opencode-v1.db");
  copyFileSync(base.dbPath, dbPath);
  {
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO message (id, session_id, seq, type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("msg-failed", "ses-v1-1", 9, "assistant", 1_700_000_060_000, 1_700_000_061_000);
    db.prepare(
      "INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "part-failed",
      "msg-failed",
      1,
      "step-finish",
      JSON.stringify({
        finish: "error",
        error: { type: "api_error" },
        time: { completed: 1_700_000_061_000 },
      }),
      null,
    );
    db.close();
  }
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService({ now: clock });
  const read = readOptions(dbPath, stateDir);

  const report = await service.getFullReport(read);
  assert.equal(report.sessions.length, 1);
  const sessionId = report.sessions[0].id;
  const detail = await service.getSessionDetail(sessionId, read);
  assert.ok(detail);
  assert.equal(detail.session.id, sessionId);

  const failed = detail.attempts.filter((attempt) => attempt.hasUsage === false);
  assert.equal(failed.length, 1, "failed attempt must remain distinct from a priced call");
  assert.ok(failed[0].id.startsWith("msg-failed"));
  assert.equal(failed[0].errorType, "api_error");
  assert.equal(
    detail.events.some((event) => event.id.startsWith("msg-failed")),
    false,
    "a failed attempt is not a usage event",
  );
  assert.equal(detail.events.length, report.totals.calls);
  for (const event of detail.events) {
    assert.equal(event.type, "assistant");
    assert.ok(event.inputTokens >= 0);
    assert.ok(event.cost.basis === "observed" || event.cost.basis === "estimated");
  }

  // The v1 fixture deliberately contains these strings in tool/text/summary
  // parts. None of them may survive any read DTO.
  const serialized = JSON.stringify([
    detail,
    await service.getOverview(read),
    await service.getUsage(read),
    await service.getFindings(read),
    report,
  ]);
  for (const leak of [
    "assistant text should be stripped",
    "summary should be stripped",
    "tool output payload should not survive",
    "sensitive tool output",
  ]) {
    assert.equal(serialized.includes(leak), false, `leaked: ${leak}`);
  }
  assertJsonSafe(detail, "session detail");
  assertNoBannedKeys(detail, "session detail");
});

test("finding detail keeps report fields and joins claims to calls", async () => {
  const dbPath = createRepeatedReadFixture();
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService({ now: clock });
  const read = readOptions(dbPath, stateDir);

  const list = await service.getFindings(read);
  assert.ok(list.findings.length >= 1, "fixture must produce a finding");
  const finding = list.findings[0];
  const detail = await service.getFinding(finding.rule, read);
  assert.ok(detail);
  assert.deepEqual(detail.finding, finding);
  assert.equal(detail.recommendation?.rule ?? finding.rule, finding.rule);
  assert.equal(detail.claims.length, finding.claimByEvent.length);
  detail.claims.forEach((claim, index) => {
    assert.equal(claim.eventId, finding.claimByEvent[index].eventId);
    assert.equal(claim.usd, finding.claimByEvent[index].usd);
    assert.equal(claim.provider, "openai");
    assert.equal(claim.model, "gpt-4.1");
    assert.equal(claim.totalTokens, 1100);
    assert.ok(Number.isFinite(Date.parse(claim.ts)));
  });
  assert.equal(await service.getFinding("no-such-rule", read), null);
  assertJsonSafe(detail, "finding detail");
});

test("reads never write the source database, never scan, and are memoised", async () => {
  const source = fixture(createV1FixtureDb);
  const stateDir = join(tempDir("munin-app-state-"), "state");
  assert.equal(existsSync(stateDir), false);
  const service = createMuninService({ now: clock });
  const read = readOptions(source.dbPath, stateDir);
  const digest = hashOf(source.dbPath);

  await service.getOverview(read);
  await service.getSourceStatus(read);
  await service.getFindings(read);
  await service.getUsage(read);
  await service.getSessions(read);
  const report = await service.getFullReport(read);
  const sessionId = report.sessions[0].id;
  await service.getSessionDetail(sessionId, read);
  await service.getActivity(read);
  await service.getHealth(read);

  assert.equal(hashOf(source.dbPath), digest, "source database bytes changed");
  if (existsSync(stateDir)) {
    assert.deepEqual(readdirSync(stateDir, { recursive: true }), [], "reads created ledger state");
  }

  // Repeated navigation returns the memoised context, not a rescan.
  const first = await service.getOverview(read);
  const second = await service.getOverview(read);
  assert.deepEqual(second.totals, first.totals);

  // A source change invalidates the cache on the next read only.
  const db = new DatabaseSync(source.dbPath);
  db.prepare(
    "INSERT INTO message (id, session_id, seq, type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("msg-cache", "ses-v1-1", 10, "assistant", 1_700_000_070_000, 1_700_000_071_000);
  db.prepare(
    "INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "part-cache",
    "msg-cache",
    1,
    "step-finish",
    JSON.stringify({
      tokens: { input: 7, output: 3, reasoning: 1, cache: { read: 0, write: 0 } },
      model: { providerID: "openai", id: "gpt-4.1" },
      finish: "stop",
      time: { completed: 1_700_000_072_000 },
    }),
    0.05,
  );
  db.close();
  const refreshed = await service.getOverview(read);
  assert.equal(refreshed.totals.calls, first.totals.calls + 1);
});

test("missing and unreadable sources are explicit states, not crashes", async () => {
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const missingDir = tempDir("munin-app-missing-");
  const service = createMuninService({ now: clock });
  const missing = readOptions(join(missingDir, "nope.db"), stateDir);

  await assert.rejects(service.getOverview(missing), (error) => {
    assert.ok(error instanceof MuninError);
    assert.equal(error.code, "source.missing-db");
    assert.equal(error.kind, "source");
    return true;
  });
  const status = await service.getSourceStatus(missing);
  assert.equal(status.status, "missing");
  const health = await service.getHealth(missing);
  assert.equal(health.source.status, "missing");
  assert.equal(health.data, null);
  const activity = await service.getActivity(missing);
  assert.equal(activity.snapshots.length, 0);
  assert.equal(activity.latestDiff, null);

  const text = fixture(createTextFileFixture);
  const unreadable = await service.getOverview(readOptions(text.dbPath, stateDir));
  assert.equal(unreadable.source.status, "ready");
  assert.equal(unreadable.totals.calls, 0);
  assert.equal(unreadable.health.clean, false);
  assert.ok(unreadable.health.warnings.length >= 1);
});

test("explicit scans update activity and lock contention keeps its code", async () => {
  const source = fixture(createV2FixtureDb);
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService({ now: clock });
  const read = readOptions(source.dbPath, stateDir);

  const scan = await service.runScan(read);
  assert.equal(scan.mode, "full");
  assert.ok(scan.status === "success" || scan.status === "warning");
  assert.ok(scan.snapshotId > 0);
  assert.ok(scan.totals.calls > 0);

  const activity = await service.getActivity(read);
  assert.equal(activity.status, scan.status);
  assert.equal(activity.lastScan?.snapshotId, scan.snapshotId);
  assert.equal(activity.snapshots.length, 1);
  assert.equal(activity.latestSnapshot?.id, scan.snapshotId);
  assert.deepEqual(activity.results.changes, []);
  assert.equal(activity.latestDiff, null);
  assertJsonSafe(activity, "activity");

  writeFileSync(
    join(stateDir, "scan.lock"),
    `${JSON.stringify({ pid: process.pid, startedAt: clock().toISOString(), purpose: "test" })}\n`,
  );
  await assert.rejects(service.runScan(read), (error) => {
    assert.ok(error instanceof MuninError);
    assert.equal(error.code, "state.lock-held");
    return true;
  });
  const failed = await service.getActivity(read);
  assert.equal(failed.status, "error");
  assert.equal(failed.lastError?.code, "state.lock-held");

  rmSync(join(stateDir, "scan.lock"));
  const recovered = await service.runScan(read);
  assert.ok(recovered.snapshotId > scan.snapshotId);
  assert.equal((await service.getActivity(read)).status, recovered.status);
});

test("monitoring is opt-in, single-instance and idempotent", async () => {
  const source = fixture(createV2FixtureDb);
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService({ now: clock });
  const read = readOptions(source.dbPath, stateDir);

  const before = await service.getActivity(read);
  assert.equal(before.monitoring.enabled, false);

  const started = await service.startMonitoring({ ...read, intervalMs: 500 });
  assert.equal(started.enabled, true);
  assert.equal(started.intervalMs, 500);
  assert.ok(started.startedAt !== null);

  const again = await service.startMonitoring({ ...read, intervalMs: 500 });
  assert.equal(again.enabled, true);
  assert.equal(
    again.startedAt,
    started.startedAt,
    "a second start must not create a second watcher",
  );

  await assert.rejects(service.startMonitoring({ ...read, intervalMs: 1.5 }), /whole number/);

  const stopped = await service.stopMonitoring();
  assert.equal(stopped.enabled, false);
  const stoppedAgain = await service.stopMonitoring();
  assert.equal(stoppedAgain.enabled, false);
  assert.equal((await service.getActivity(read)).monitoring.enabled, false);
});

test("service errors are safe and keep existing codes", () => {
  assert.deepEqual(
    toServiceError(new MuninError({ code: "source.missing-db", kind: "source", message: "gone" })),
    { code: "source.missing-db", kind: "source", message: "gone" },
  );
  const unknown = toServiceError(new Error("secret /home/someone/path"));
  assert.equal(unknown.code, "internal");
  assert.equal(unknown.kind, "internal");
  assert.equal(unknown.message.includes("secret"), false);
  assert.equal("stack" in unknown, false);

  assert.equal(
    toScanError(new Error("Another Munin scan holds the lock: /x")).code,
    "state.lock-held",
  );
  const sourceError = toScanError(new Error("[source.missing-db] Database not found: /x"));
  assert.equal(sourceError.code, "source.missing-db");
  assert.equal(sourceError.kind, "source");
  assert.equal(sourceError.message, "Database not found: /x");
});

test("privacy status runs the existing ledger validator and describes storage", async () => {
  const source = fixture(createV2FixtureDb);
  const stateDir = join(tempDir("munin-app-state-"), "state");
  const service = createMuninService();
  const read = readOptions(source.dbPath, stateDir);

  const empty = await service.getPrivacyStatus(read);
  assert.equal(empty.network, "none");
  assert.equal(empty.ledger.audit, "empty");
  assert.equal(empty.ledger.eventsJournal, false);
  assert.ok(empty.bannedKeys.includes("prompt"));
  assert.ok(Number.isFinite(Date.parse(empty.checkedAt)));
  assertNoBannedKeys(empty.ledger, "privacy ledger");

  await service.runScan(read);
  const audited = await service.getPrivacyStatus(read);
  assert.equal(audited.ledger.eventsJournal, true);
  assert.equal(audited.ledger.snapshotsJournal, true);
  assert.equal(audited.ledger.audit, "pass");
  assertJsonSafe(audited, "privacy");
});
