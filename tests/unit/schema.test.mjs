import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openReadOnly, readDataset } from "@munin/local";
import { detectSchema } from "@munin/local";
import { createSchemaFixtureDb } from "../fixtures/opencode-db.mjs";

const none = createSchemaFixtureDb("none");
const v1 = createSchemaFixtureDb("v1");
const v2 = createSchemaFixtureDb("v2");
const mixed = createSchemaFixtureDb("mixed");

after(() => {
  none.cleanup();
  v1.cleanup();
  v2.cleanup();
  mixed.cleanup();
});

test("schema detection reports v1/v2/mixed/none correctly", () => {
  const checks = [
    [none.dbPath, "none"],
    [v1.dbPath, "v1"],
    [v2.dbPath, "v2"],
    [mixed.dbPath, "mixed"],
  ];

  for (const [dbPath, expected] of checks) {
    const db = openReadOnly(dbPath);
    try {
      assert.equal(detectSchema(db).schema, expected);
    } finally {
      db.close();
    }
  }
});

test("mixed merge keeps v1-only sessions and uses v2 for shared ids", () => {
  const dataset = readDataset({ db: mixed.dbPath });
  assert.equal(dataset.schema, "mixed");

  const sessionIds = new Set(dataset.sessions.map((session) => session.id));
  assert.equal(sessionIds.has("v1-only-ses"), true);
  assert.equal(sessionIds.has("v2-only-ses"), true);
  assert.equal(sessionIds.has("shared-ses"), true);
  assert.equal(dataset.sessions.filter((session) => session.id === "shared-ses").length, 1);

  const sharedMessages = dataset.messages.filter((message) => message.sessionId === "shared-ses");
  assert.equal(sharedMessages.length, 1);

  assert.equal(dataset.warnings.some((warning) => warning.code === "source.mixed-schema"), true);
});
