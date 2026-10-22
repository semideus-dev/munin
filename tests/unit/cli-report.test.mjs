// CLI read-only commands must render the same report the analysis harness
// already reaches. These tests pin the two front ends together: run the CLI
// and scripts/analyze-local.mjs over one fixture database and compare the JSON
// slices digit for digit (docs/plans/phase-6-cli.md, Step 2).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createV2FixtureDb } from "../fixtures/opencode-db.mjs";

const cli = fileURLToPath(new URL("../../apps/cli/dist/cli.js", import.meta.url));
const harness = fileURLToPath(new URL("../../scripts/analyze-local.mjs", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "munin-cli-report-"));
const fixture = createV2FixtureDb();

const baseEnv = {
  ...process.env,
  MUNIN_DIR: stateDir,
  MUNIN_DEBUG: "",
  NO_COLOR: "1",
};

after(() => {
  fixture.cleanup();
  rmSync(stateDir, { recursive: true, force: true });
});

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: baseEnv,
  });
}

function cliJson(args) {
  const result = run(cli, [...args, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function harnessJson(args) {
  const result = run(harness, ["--json", ...args, "--db", fixture.dbPath]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("profile totals, window and savings match the analyze harness", () => {
  const ours = cliJson(["profile", "--db", fixture.dbPath]);
  const theirs = harnessJson(["--totals"]);
  assert.deepEqual(ours.data.window, theirs.window);
  assert.deepEqual(ours.data.totals, theirs.totals);
  assert.deepEqual(ours.data.savings, theirs.savings);
});

test("sessions match the harness session list", () => {
  const ours = cliJson(["sessions", "--db", fixture.dbPath]);
  const theirs = harnessJson(["--sessions"]);
  assert.deepEqual(ours.data.sessions, theirs.sessions);
});

test("scan findings and recommendations match the harness", () => {
  const ours = cliJson(["scan", "--db", fixture.dbPath]);
  const theirs = harnessJson(["--findings"]);
  assert.deepEqual(ours.data.findings, theirs.findings);
  assert.deepEqual(ours.data.recommendations, theirs.recommendations);
});

test("show <rule> renders exactly the harness finding", () => {
  const database = createFindingsDb();
  try {
    const findings = JSON.parse(
      run(harness, ["--json", "--findings", "--db", database.dbPath]).stdout,
    ).findings;
    assert.equal(findings.length, 1, "the fixture triggers exactly one finding");
    const rule = findings[0].rule;

    const result = run(cli, ["show", rule, "--db", database.dbPath, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.data.finding, findings[0]);
  } finally {
    database.cleanup();
  }
});

test("missing database exits 1 with source.missing-db and no stack", () => {
  const missing = join(stateDir, "does-not-exist.db");

  const human = run(cli, ["sessions", "--db", missing]);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /\[source\.missing-db\]/);
  assert.doesNotMatch(human.stderr, /\n\s+at /);

  const json = run(cli, ["sessions", "--db", missing, "--json"]);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: false,
    error: {
      code: "source.missing-db",
      message: `Database not found: ${missing}`,
    },
  });
});

test("show without a rule exits 64 with a usage error", () => {
  const result = run(cli, ["show", "--db", fixture.dbPath]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /\[cli\.missing-argument\]/);
});

test("privacy explains storage without reading a database", () => {
  const result = run(cli, ["privacy"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /No analytics, telemetry or crash reporting/);
});

/** A small v1 database whose repeated Read calls trigger `repeat-tool-calls`. */
function createFindingsDb() {
  const dir = mkdtempSync(join(tmpdir(), "munin-cli-findings-"));
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
  return {
    dbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
