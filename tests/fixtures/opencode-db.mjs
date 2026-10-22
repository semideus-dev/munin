import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function tempDb(prefix, name) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, name);
  return {
    dir,
    dbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function copyFixtureDb(sourcePath, prefix = "munin-copy-") {
  const fixture = tempDb(prefix, "fixture.db");
  copyFileSync(sourcePath, fixture.dbPath);
  return fixture;
}

export function createTextFileFixture(content = "not a sqlite database") {
  const fixture = tempDb("munin-text-fixture-", "not-sqlite.txt");
  writeFileSync(fixture.dbPath, content, "utf8");
  return fixture;
}

export function createV1FixtureDb() {
  const fixture = tempDb("munin-v1-fixture-", "opencode-v1.db");
  const db = new DatabaseSync(fixture.dbPath);

  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      title TEXT,
      directory TEXT,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      cost REAL
    );
  `);

  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("proj-1", "/work/demo-app");
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, title, directory, agent, model, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "ses-v1-1",
    "proj-1",
    null,
    "Fixture Session",
    "/work/demo-app",
    "zed",
    JSON.stringify({ providerID: "openai", id: "gpt-4.1", variant: "default" }),
    1_700_000_000_000,
    1_700_000_050_000,
  );

  db.prepare(
    `INSERT INTO message (id, session_id, seq, type, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("msg-v1-1", "ses-v1-1", 1, "assistant", 1_700_000_001_000, 1_700_000_040_000);

  db.prepare(`INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?);`).run(
    "part-tool-1",
    "msg-v1-1",
    1,
    "tool",
    JSON.stringify({
      id: "tool-1",
      name: "read",
      state: {
        input: { path: "/work/demo-app/src/index.ts", offset: 0, limit: 200 },
        status: "ok",
        content: "tool output payload should not survive",
      },
    }),
    null,
  );

  db.prepare(`INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?);`).run(
    "part-step-1",
    "msg-v1-1",
    2,
    "step-finish",
    JSON.stringify({
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
      model: { providerID: "openai", id: "gpt-4.1", variant: "default" },
      finish: "stop",
      time: { completed: 1_700_000_010_000 },
      text: "assistant text should be stripped",
    }),
    0.25,
  );

  db.prepare(`INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?);`).run(
    "part-tool-2",
    "msg-v1-1",
    3,
    "tool",
    JSON.stringify({
      id: "tool-2",
      name: "shell",
      state: {
        input: { command: "echo hello" },
        status: "error",
        content: "sensitive tool output",
      },
    }),
    null,
  );

  db.prepare(`INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?);`).run(
    "part-step-2",
    "msg-v1-1",
    4,
    "step-finish",
    JSON.stringify({
      tokens: { input: 50, output: 10, reasoning: 2, cache: { read: 5, write: 0 } },
      model: { providerID: "openai", id: "gpt-4.1", variant: "default" },
      finish: "stop",
      time: { completed: 1_700_000_030_000 },
      summary: "summary should be stripped",
    }),
    0.1,
  );

  db.close();
  return fixture;
}

export function createV2FixtureDb() {
  const fixture = tempDb("munin-v2-fixture-", "opencode-v2.db");
  const db = new DatabaseSync(fixture.dbPath);

  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT,
      directory TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE instruction_state (
      session_id TEXT PRIMARY KEY,
      epoch_start INTEGER NOT NULL,
      through_seq INTEGER NOT NULL,
      initial_values TEXT NOT NULL,
      current_values TEXT NOT NULL
    );
    CREATE TABLE instruction_blob (
      hash TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const modelJson = JSON.stringify({ providerID: "openai", id: "gpt-4.1", variant: "high" });

  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("proj-v2", "/work/alpha-app");

  db.prepare(
    `INSERT INTO session_v2 (
      id, project_id, parent_id, title, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "ses-v2-1",
    "proj-v2",
    null,
    "Alpha Session",
    "/work/alpha-app",
    "subagent-alpha",
    modelJson,
    1.25,
    111,
    22,
    3,
    44,
    0,
    1_700_100_000_000,
    1_700_100_500_000,
  );

  const assistantData = JSON.stringify({
    agent: "subagent-alpha",
    finish: "stop",
    model: { providerID: "openai", id: "gpt-4.1", variant: "high" },
    tokens: { input: 111, output: 22, reasoning: 3, cache: { read: 44, write: 0 } },
    cost: 1.25,
    text: "SENTINEL_PROMPT_TEXT",
    summary: "SENTINEL_SUMMARY",
    content: [
      { type: "text", text: "SENTINEL_NESTED_TEXT" },
      {
        type: "tool",
        id: "tool-v2-1",
        name: "read",
        state: {
          input: { path: "/work/alpha-app/src/main.ts", offset: 2, limit: 9 },
          status: "ok",
          content: "SENTINEL_TOOL_OUTPUT",
        },
      },
    ],
    time: { completed: 1_700_100_040_000 },
  });

  const compactionData = JSON.stringify({
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    summary: "SENTINEL_COMPACTION_SUMMARY",
    recent: "SENTINEL_RECENT",
  });

  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg-v2-1", "ses-v2-1", "assistant", 1, 1_700_100_010_000, 1_700_100_040_000, assistantData);

  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("msg-v2-2", "ses-v2-1", "compaction", 2, 1_700_100_050_000, 1_700_100_060_000, compactionData);

  const blobValue = "SENTINEL_INSTRUCTION_TEXT".repeat(2);
  db.prepare("INSERT INTO instruction_blob (hash, value) VALUES (?, ?)").run("h1", blobValue);
  db.prepare(
    "INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values) VALUES (?, ?, ?, ?, ?)",
  ).run("ses-v2-1", 0, 2, "{}", JSON.stringify({ system: "h1" }));

  db.close();
  return fixture;
}

export function createSchemaFixtureDb(kind) {
  if (kind === "none") {
    const fixture = tempDb("munin-schema-none-", "none.db");
    const db = new DatabaseSync(fixture.dbPath);
    db.exec("CREATE TABLE misc (id TEXT PRIMARY KEY);");
    db.close();
    return fixture;
  }

  if (kind === "v1") {
    return createV1FixtureDb();
  }

  if (kind === "v2") {
    return createV2FixtureDb();
  }

  const fixture = tempDb("munin-schema-mixed-", "mixed.db");
  const db = new DatabaseSync(fixture.dbPath);

  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      title TEXT,
      directory TEXT,
      agent TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      cost REAL
    );

    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT,
      directory TEXT NOT NULL,
      agent TEXT,
      model TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE instruction_state (
      session_id TEXT PRIMARY KEY,
      epoch_start INTEGER NOT NULL,
      through_seq INTEGER NOT NULL,
      initial_values TEXT NOT NULL,
      current_values TEXT NOT NULL
    );
    CREATE TABLE instruction_blob (
      hash TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run("proj-mixed", "/work/mixed");

  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, title, directory, agent, model, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "shared-ses",
    "proj-mixed",
    null,
    "Shared in v1",
    "/work/mixed",
    "zed",
    JSON.stringify({ providerID: "openai", id: "gpt-4", variant: "low" }),
    1,
    2,
  );

  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, title, directory, agent, model, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "v1-only-ses",
    "proj-mixed",
    null,
    "V1 Only",
    "/work/mixed",
    "zed",
    JSON.stringify({ providerID: "openai", id: "gpt-4", variant: "low" }),
    3,
    4,
  );

  db.prepare("INSERT INTO message (id, session_id, seq, type, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)").run(
    "msg-v1-only",
    "v1-only-ses",
    1,
    "assistant",
    3,
    4,
  );

  db.prepare("INSERT INTO part (id, message_id, seq, type, data, cost) VALUES (?, ?, ?, ?, ?, ?)").run(
    "part-v1-only",
    "msg-v1-only",
    1,
    "step-finish",
    JSON.stringify({ tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
    0,
  );

  db.prepare(
    `INSERT INTO session_v2 (
      id, project_id, parent_id, title, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "shared-ses",
    "proj-mixed",
    null,
    "Shared in v2",
    "/work/mixed",
    "agent-v2",
    JSON.stringify({ providerID: "openai", id: "gpt-4.1", variant: "high" }),
    0,
    2,
    2,
    0,
    0,
    0,
    5,
    6,
  );

  db.prepare(
    `INSERT INTO session_v2 (
      id, project_id, parent_id, title, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "v2-only-ses",
    "proj-mixed",
    null,
    "V2 Only",
    "/work/mixed",
    "agent-v2",
    JSON.stringify({ providerID: "openai", id: "gpt-4.1", variant: "high" }),
    0,
    3,
    3,
    0,
    0,
    0,
    7,
    8,
  );

  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg-v2-shared",
    "shared-ses",
    "assistant",
    1,
    5,
    6,
    JSON.stringify({ tokens: { input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }),
  );

  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "msg-v2-only",
    "v2-only-ses",
    "assistant",
    1,
    7,
    8,
    JSON.stringify({ tokens: { input: 3, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }),
  );

  db.close();
  return fixture;
}
