import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDataset } from "@munin/local";
import { copyFixtureDb, createTextFileFixture, createV2FixtureDb } from "../fixtures/opencode-db.mjs";

const fixture = createV2FixtureDb();
const copy = copyFixtureDb(fixture.dbPath);
const textFile = createTextFileFixture();
const unreadableDir = join(tmpdir(), `munin-unreadable-${Date.now()}`);
mkdirSync(unreadableDir, { recursive: true });

after(() => {
  fixture.cleanup();
  copy.cleanup();
  textFile.cleanup();
});

test("readDataset does not mutate sqlite file bytes", () => {
  const before = createHash("sha256").update(readFileSync(copy.dbPath)).digest("hex");
  readDataset({ db: copy.dbPath });
  const afterHash = createHash("sha256").update(readFileSync(copy.dbPath)).digest("hex");
  assert.equal(afterHash, before);
});

test("missing and invalid inputs degrade to warnings", () => {
  const missing = readDataset({ db: join(tmpdir(), "munin-no-such-file.db") });
  assert.equal(missing.warnings[0]?.code, "source.missing-db");

  const nonSqlite = readDataset({ db: textFile.dbPath });
  assert.equal(nonSqlite.warnings[0]?.code, "source.unreadable");

  const unreadable = readDataset({ db: unreadableDir });
  assert.equal(unreadable.warnings[0]?.code, "source.unreadable");

  chmodSync(unreadableDir, 0o755);
});
