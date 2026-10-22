import assert from "node:assert/strict";
import { after, test } from "node:test";
import { normalizeOpenCodeV1 } from "@munin/core";
import { openReadOnly, readV1Rows } from "@munin/local";
import { createV1FixtureDb } from "../fixtures/opencode-db.mjs";

const fixture = createV1FixtureDb();
after(() => fixture.cleanup());

test("v1 reader maps one message with two step-finish parts into two model calls", () => {
  const db = openReadOnly(fixture.dbPath);
  try {
    const rows = readV1Rows(db);
    const dataset = normalizeOpenCodeV1({
      sessions: rows.sessions,
      messages: rows.messages,
      parts: rows.parts,
      sourcePath: fixture.dbPath,
    });

    assert.equal(dataset.schema, "v1");
    assert.equal(dataset.sessions.length, 1);
    assert.equal(dataset.messages.length, 2);

    const first = dataset.messages[0];
    const second = dataset.messages[1];

    assert.equal(first.id, "msg-v1-1#part-step-1");
    assert.equal(second.id, "msg-v1-1#part-step-2");

    assert.deepEqual(first.usage?.tokens, {
      input: 100,
      output: 20,
      thinking: 5,
      cacheRead: 10,
      cacheWrite: 0,
    });
    assert.equal(first.usage?.observedUsd, 0.25);

    assert.deepEqual(second.usage?.tokens, {
      input: 50,
      output: 10,
      thinking: 2,
      cacheRead: 5,
      cacheWrite: 0,
    });
    assert.equal(second.usage?.observedUsd, 0.1);

    assert.equal(first.toolCalls?.length, 1);
    assert.equal(first.toolCalls?.[0]?.id, "tool-1");
    assert.equal(first.toolCalls?.[0]?.name, "Read");

    assert.equal(second.toolCalls?.length, 1);
    assert.equal(second.toolCalls?.[0]?.id, "tool-2");
    assert.equal(second.toolCalls?.[0]?.name, "Bash");
    assert.equal(second.toolCalls?.[0]?.isError, true);

    const serialized = JSON.stringify(dataset);
    assert.equal(serialized.includes("state.content"), false);
    assert.equal(serialized.includes("sensitive tool output"), false);
    assert.equal(serialized.includes("assistant text should be stripped"), false);
    assert.equal(serialized.includes("summary should be stripped"), false);
  } finally {
    db.close();
  }
});
