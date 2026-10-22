import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { loadConfig, readDataset } from "@munin/local";

test("integration: read real local OpenCode database when present", { skip: !existsSync(loadConfig().dbPath) }, () => {
  const dataset = readDataset();

  assert.equal(dataset.schema === "v2" || dataset.schema === "mixed", true);
  assert.equal(dataset.sessions.length > 0, true);

  const modelCalls = dataset.messages.filter(
    (message) => message.type === "assistant" || message.type === "compaction",
  ).length;
  assert.equal(modelCalls > 0, true);

  assert.equal(dataset.warnings.some((warning) => warning.code === "source.unreadable"), false);
});
