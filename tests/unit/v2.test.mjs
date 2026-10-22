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
  assert.equal(assistant?.toolCalls?.length, 1);
  assert.equal(assistant?.toolCalls?.[0]?.signature, "Read:/work/alpha-app/src/main.ts#2:9");

  const serialized = JSON.stringify(dataset);
  assert.equal(serialized.includes("SENTINEL_PROMPT_TEXT"), false);
  assert.equal(serialized.includes("SENTINEL_SUMMARY"), false);
  assert.equal(serialized.includes("SENTINEL_TOOL_OUTPUT"), false);
});
