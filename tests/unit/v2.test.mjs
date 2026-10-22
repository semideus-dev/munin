import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readDataset } from "@munin/local";
import { createV2FixtureDb } from "../fixtures/opencode-db.mjs";

const fixture = createV2FixtureDb();
after(() => fixture.cleanup());

test("v2 fixture maps sessions, messages, tools and instructions", () => {
  const dataset = readDataset({ db: fixture.dbPath });

  assert.equal(dataset.schema, "v2");
  assert.equal(dataset.sessions.length, 1);
  assert.equal(dataset.messages.length, 2);

  const session = dataset.sessions[0];
  assert.equal(session.project, "alpha-app");
  assert.equal(session.instructions?.chars, "SENTINEL_INSTRUCTION_TEXT".repeat(2).length);
  assert.equal(typeof session.instructions?.prefixHash, "string");
  assert.equal(session.instructions?.prefixHash.length > 0, true);

  const assistant = dataset.messages.find((message) => message.id === "msg-v2-1");
  assert.equal(assistant?.usage?.tokens.input, 111);
  assert.equal(assistant?.usage?.tokens.output, 22);
  assert.equal(assistant?.usage?.tokens.thinking, 3);
  assert.equal(assistant?.usage?.tokens.cacheRead, 44);
  assert.equal(assistant?.usage?.observedUsd, 1.25);

  const tools = assistant?.toolCalls ?? [];
  assert.equal(tools.length, 8);
  const byId = new Map(tools.map((tool) => [tool.id, tool]));

  assert.equal(byId.get("tool-v2-1")?.signature, "Read:/work/alpha-app/src/main.ts#2:9");

  const grepOne = byId.get("tool-v2-grep-1");
  const grepTwo = byId.get("tool-v2-grep-2");
  assert.equal(grepOne?.name, "Grep");
  assert.match(grepOne?.signature ?? "", /SENTINEL_GREP_PATTERN/);
  assert.match(grepOne?.signature ?? "", /\/work\/alpha-app\/src/);
  assert.notEqual(grepOne?.signature, grepTwo?.signature);

  const globOne = byId.get("tool-v2-glob-1");
  const globTwo = byId.get("tool-v2-glob-2");
  assert.equal(globOne?.name, "Glob");
  assert.match(globOne?.signature ?? "", /src\/\*\*\/\*\.ts/);
  assert.match(globOne?.signature ?? "", /\/work\/alpha-app/);
  assert.notEqual(globOne?.signature, globTwo?.signature);

  const editOne = byId.get("tool-v2-edit-1");
  const editTwo = byId.get("tool-v2-edit-2");
  assert.equal(editOne?.name, "Edit");
  assert.equal(editOne?.target, "/work/alpha-app/src/main.ts");
  assert.notEqual(editOne?.signature, editTwo?.signature);
  assert.equal(editOne?.signature.includes("SENTINEL_OLD_TEXT_ONE"), false);
  assert.equal(editTwo?.signature.includes("SENTINEL_OLD_TEXT_TWO"), false);

  const write = byId.get("tool-v2-write-1");
  assert.equal(write?.name, "Write");
  assert.equal(write?.target, "/work/alpha-app/src/written.ts");

  const serialized = JSON.stringify(dataset);
  assert.equal(serialized.includes("SENTINEL_PROMPT_TEXT"), false);
  assert.equal(serialized.includes("SENTINEL_SUMMARY"), false);
  assert.equal(serialized.includes("SENTINEL_TOOL_OUTPUT"), false);
  assert.equal(serialized.includes("SENTINEL_NESTED_TEXT"), false);
  assert.equal(serialized.includes("SENTINEL_OLD_TEXT_ONE"), false);
  assert.equal(serialized.includes("SENTINEL_OLD_TEXT_TWO"), false);
  assert.equal(serialized.includes("SENTINEL_WRITE_CONTENT"), false);
  assert.equal(serialized.includes("SENTINEL_EDIT_OUTPUT"), false);
  assert.equal(serialized.includes("SENTINEL_GREP_OUTPUT"), false);
  assert.equal(serialized.includes("SENTINEL_GLOB_OUTPUT"), false);
});
