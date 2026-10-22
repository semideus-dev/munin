import assert from "node:assert/strict";
import { after, test } from "node:test";
import { advanceCursor } from "@munin/core";
import { openReadOnly, readDataset, readV1Rows, readV2Rows } from "@munin/local";
import { createSchemaFixtureDb } from "../fixtures/opencode-db.mjs";

const v1 = createSchemaFixtureDb("v1");
const v2 = createSchemaFixtureDb("v2");
const mixed = createSchemaFixtureDb("mixed");
after(() => {
  v1.cleanup();
  v2.cleanup();
  mixed.cleanup();
});

test("absent watermarks preserve full reads and per-schema watermarks filter mixed history", () => {
  const full = readDataset({ db: v1.dbPath });
  const noCursor = readDataset({ db: v1.dbPath, watermarks: { v1: null, v2: null } });
  assert.deepEqual(noCursor, full);

  const db = openReadOnly(mixed.dbPath);
  try {
    const v1Rows = readV1Rows(db, { watermarkMs: 3, overlapMs: 0 });
    const v2Rows = readV2Rows(db, { watermarkMs: 7, overlapMs: 0 });
    assert.deepEqual(v1Rows.sessions.map((session) => session.id), ["v1-only-ses"]);
    assert.equal(v1Rows.messages.length, 1);
    assert.equal(v1Rows.parts.length, 1);
    assert.deepEqual(v2Rows.sessions.map((session) => session.id), ["v2-only-ses"]);
    assert.equal(v2Rows.messages.length, 1);
  } finally {
    db.close();
  }
});

test("default overlap re-reads recently updated sessions in both schemas", () => {
  const db1 = openReadOnly(v1.dbPath);
  const db2 = openReadOnly(v2.dbPath);
  try {
    assert.equal(readV1Rows(db1, { watermarkMs: 1_700_000_070_000 }).sessions.length, 1);
    assert.equal(readV1Rows(db1, { watermarkMs: 1_700_000_070_000, overlapMs: 10_000 }).sessions.length, 0);
    assert.equal(readV2Rows(db2, { watermarkMs: 1_700_100_520_000 }).sessions.length, 1);
    assert.equal(readV2Rows(db2, { watermarkMs: 1_700_100_520_000, overlapMs: 10_000 }).sessions.length, 0);
  } finally {
    db1.close();
    db2.close();
  }
});

test("mixed-schema transition forces a full read and emits one counted warning", () => {
  const dataset = readDataset({
    db: mixed.dbPath,
    previousSchema: "v1",
    watermarks: { v1: 5, v2: 100 },
  });
  assert.deepEqual(new Set(dataset.sessions.map((session) => session.id)), new Set(["shared-ses", "v1-only-ses", "v2-only-ses"]));
  assert.deepEqual(dataset.warnings.find((warning) => warning.code === "source.schema-changed"), {
    code: "source.schema-changed",
    message: "Source schema changed from v1 to mixed; reading all sessions for this pass",
    count: 1,
  });
});

test("cursor advances to fully read per-schema high watermarks and refuses partial reads", () => {
  const at = "2026-10-23T12:00:00.000Z";
  const nowMs = Date.parse(at);
  const first = advanceCursor(null, {
    v1: { sessions: [{ time_updated: nowMs - 100 }, { time_updated: nowMs - 50 }] },
  }, "v1", at);
  assert.equal(first.v1, nowMs - 50);
  assert.equal(first.v2, null);

  const mixedCursor = advanceCursor(first, {
    v1: { sessions: [{ time_updated: nowMs - 25 }] },
    v2: { sessions: [{ time_updated: nowMs - 10 }] },
  }, "mixed", at);
  assert.equal(mixedCursor.v1, nowMs - 25);
  assert.equal(mixedCursor.v2, nowMs - 10);
  assert.throws(() => advanceCursor(mixedCursor, {
    v1: { sessions: [{ time_updated: nowMs }], failedSessionIds: ["partial"] },
    v2: { sessions: [] },
  }, "mixed", at), /selected session read failed/);
});
