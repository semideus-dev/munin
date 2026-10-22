// `munin scan` and `munin live` drive the Phase 5 runtime from the CLI:
// a locked ledger scan with full/incremental modes and view filters, and the
// watch loop as a streaming log. These tests cover the wiring the library
// tests cannot: flags, exit codes, the single-writer lock, and shutdown.
// (docs/plans/phase-6-cli.md, Step 3)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createV2FixtureDb } from "../fixtures/opencode-db.mjs";

const cli = fileURLToPath(new URL("../../apps/cli/dist/cli.js", import.meta.url));
const fixture = createV2FixtureDb();
const root = mkdtempSync(join(tmpdir(), "munin-cli-scan-"));

after(() => {
  fixture.cleanup();
  rmSync(root, { recursive: true, force: true });
});

function freshState(name) {
  const state = join(root, name);
  mkdirSync(state, { recursive: true });
  return state;
}

function env(state) {
  return { ...process.env, MUNIN_DIR: state, MUNIN_DEBUG: "", NO_COLOR: "1" };
}

function run(state, args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: env(state) });
}

function runJson(state, args) {
  const result = run(state, [...args, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("scan runs full then incremental and rebuilds the same totals", () => {
  const state = freshState("idempotent");
  const first = runJson(state, ["scan", "--db", fixture.dbPath, "--full"]);
  assert.equal(first.data.scan.mode, "full");
  assert.equal(first.data.scan.sessionsRead, 1);

  const second = runJson(state, ["scan", "--db", fixture.dbPath]);
  assert.equal(second.data.scan.mode, "incremental");
  assert.deepEqual(second.data.totals, first.data.totals);

  // One snapshot per scan, and the merged ledger still holds each event once.
  const snapshots = readFileSync(join(state, "snapshots.jsonl"), "utf8").trim().split("\n");
  assert.equal(snapshots.length, 2);
  assert.equal(second.data.dataHealth.ledger.eventsTracked, first.data.totals.calls);
});

test("scan --project filters the report but never the ledger", () => {
  const state = freshState("view");
  const full = runJson(state, ["scan", "--db", fixture.dbPath, "--full"]);
  const tracked = full.data.dataHealth.ledger.eventsTracked;
  assert.ok(tracked > 0);

  const view = runJson(state, ["scan", "--db", fixture.dbPath, "--project", "no-such-project"]);
  assert.equal(view.data.totals.calls, 0);
  assert.ok(view.warnings.some((warning) => warning.code === "analysis.no-events"));
  // The ledger still holds every event: filters are a view, not a rewrite.
  assert.equal(view.data.dataHealth.ledger.eventsTracked, tracked);
});

test("scan refuses while another writer holds the lock", () => {
  const state = freshState("locked");
  runJson(state, ["scan", "--db", fixture.dbPath, "--full"]);
  writeFileSync(
    join(state, "scan.lock"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), purpose: "test" }),
  );

  const json = run(state, ["scan", "--db", fixture.dbPath, "--json"]);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  assert.equal(JSON.parse(json.stdout).error.code, "state.lock-held");

  const human = run(state, ["scan", "--db", fixture.dbPath]);
  assert.equal(human.status, 1);
  assert.match(human.stderr, /\[state\.lock-held\]/);
});

test("scan on a missing database exits 1 with source.missing-db", () => {
  const state = freshState("missing");
  const result = run(state, ["scan", "--db", join(state, "nope.db"), "--json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "source.missing-db");
});

test("scan --repair without --full is a usage error", () => {
  const state = freshState("repair");
  const result = run(state, ["scan", "--db", fixture.dbPath, "--repair"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /\[cli\.invalid-value\]/);
});

test("live prints a cycle and exits cleanly on SIGTERM", async () => {
  const state = freshState("live");
  const child = spawn(
    process.execPath,
    [cli, "live", "--db", fixture.dbPath, "--interval", "500"],
    { env: env(state), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const code = await new Promise((resolve) => {
    const waitForCycle = setInterval(() => {
      if (/^\S+ scan /m.test(stdout)) {
        clearInterval(waitForCycle);
        child.kill("SIGTERM");
      }
    }, 50);
    const stop = setTimeout(() => {
      clearInterval(waitForCycle);
      child.kill("SIGTERM");
    }, 5000);
    child.on("close", (exitCode) => {
      clearInterval(waitForCycle);
      clearTimeout(stop);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0, stderr);
  assert.match(stdout, /munin live/);
  assert.match(stdout, /scan (full|incremental)/);
});
