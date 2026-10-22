import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendFileSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildReport } from "@munin/core";
import { createScanWatcher, readDataset, runScan } from "@munin/local";
import { createSchemaFixtureDb } from "../fixtures/opencode-db.mjs";

const dir = mkdtempSync(join(tmpdir(), "munin-scan-test-"));
const fixture = createSchemaFixtureDb("v2");
after(() => {
  fixture.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function stateDir(name) {
  return join(dir, name);
}

function addSession(id) {
  const db = new DatabaseSync(fixture.dbPath);
  const at = Date.now();
  const model = JSON.stringify({ providerID: "openai", id: "gpt-4.1" });
  db.prepare(
    `INSERT INTO session_v2 (
    id, project_id, parent_id, title, directory, agent, model, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
    time_created, time_updated
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "proj-v2",
    null,
    id,
    "/work/alpha-app",
    "build",
    model,
    0.001,
    100,
    20,
    0,
    0,
    0,
    at,
    at,
  );
  db.prepare(
    `INSERT INTO session_message
    (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `message-${id}`,
    id,
    "assistant",
    1,
    at,
    at,
    JSON.stringify({
      agent: "build",
      finish: "stop",
      model: { providerID: "openai", id: "gpt-4.1" },
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.001,
    }),
  );
  db.close();
}

test("full and repeated scans rebuild the same totals and append one snapshot each", () => {
  const state = stateDir("idempotent");
  const before = statSync(fixture.dbPath);
  const first = runScan({ db: fixture.dbPath, stateDir: state, full: true });
  const second = runScan({ db: fixture.dbPath, stateDir: state });
  const after = statSync(fixture.dbPath);
  const batchReport = buildReport(readDataset({ db: fixture.dbPath }));
  assert.equal(first.mode, "full");
  assert.equal(second.mode, "incremental");
  assert.deepEqual(first.totals, batchReport.totals);
  assert.deepEqual(second.totals, first.totals);
  assert.equal(
    second.report.dataHealth.ledger.eventsTracked,
    first.report.dataHealth.ledger.eventsTracked,
  );
  assert.equal(readFileSync(join(state, "snapshots.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("full reconciliation reports changed sessions and --repair rewrites the journal", () => {
  const state = stateDir("repair");
  runScan({ db: fixture.dbPath, stateDir: state, full: true });
  const db = new DatabaseSync(fixture.dbPath);
  const old = JSON.parse(
    db.prepare("SELECT data FROM session_message WHERE id = ?").get("msg-v2-1").data,
  );
  old.tokens.input += 1;
  db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(
    JSON.stringify(old),
    "msg-v2-1",
  );
  db.close();

  const drift = runScan({ db: fixture.dbPath, stateDir: state, full: true });
  assert.equal(
    drift.reconciliation.some((row) => row.kind === "events-changed"),
    true,
  );
  assert.equal(drift.repaired, false);

  const nextDb = new DatabaseSync(fixture.dbPath);
  const changed = JSON.parse(
    nextDb.prepare("SELECT data FROM session_message WHERE id = ?").get("msg-v2-1").data,
  );
  changed.tokens.input += 1;
  nextDb
    .prepare("UPDATE session_message SET data = ? WHERE id = ?")
    .run(JSON.stringify(changed), "msg-v2-1");
  nextDb.close();
  const repaired = runScan({ db: fixture.dbPath, stateDir: state, full: true, repair: true });
  assert.equal(repaired.repaired, true);
  const lines = readFileSync(join(state, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, repaired.report.dataHealth.ledger.sessionsTracked);
});

test("watch polling discovers updates and a new watcher resumes the persisted cursor", () => {
  const state = stateDir("watch");
  runScan({ db: fixture.dbPath, stateDir: state, full: true });
  const watcher = createScanWatcher({ db: fixture.dbPath, stateDir: state });
  assert.equal(watcher.poll().kind, "scan");
  assert.equal(watcher.poll().kind, "unchanged");

  addSession("during-watch");
  const discovered = watcher.poll();
  assert.equal(discovered.kind, "scan");
  assert.equal(discovered.result.newSessionIds.includes("during-watch"), true);

  addSession("during-downtime");
  const restarted = createScanWatcher({ db: fixture.dbPath, stateDir: state }).poll();
  assert.equal(restarted.kind, "scan");
  assert.equal(restarted.result.newSessionIds.includes("during-downtime"), true);
});

test("privacy mode refuses a contaminated journal before snapshot or cursor commit", () => {
  const state = stateDir("privacy");
  runScan({ db: fixture.dbPath, stateDir: state, full: true });
  const cursorPath = join(state, "cursors.json");
  const snapshotsPath = join(state, "snapshots.jsonl");
  const cursorBefore = readFileSync(cursorPath, "utf8");
  const snapshotsBefore = readFileSync(snapshotsPath, "utf8");
  appendFileSync(
    join(state, "events.jsonl"),
    `${JSON.stringify({ schema: "munin.slice/1", prompt: "should never persist" })}\n`,
  );

  assert.throws(
    () => runScan({ db: fixture.dbPath, stateDir: state, checkPrivacy: true }),
    /Privacy check rejected events\.jsonl/,
  );
  assert.equal(readFileSync(cursorPath, "utf8"), cursorBefore);
  assert.equal(readFileSync(snapshotsPath, "utf8"), snapshotsBefore);
});
