import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "@munin/local";

const stateDir = mkdtempSync(join(tmpdir(), "munin-config-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));

test("database precedence is flag, env, settings, default", () => {
  const settingsPath = join(stateDir, "config.json");
  writeFileSync(settingsPath, JSON.stringify({ db: "from-settings.db" }));
  const base = { stateDir, env: {} };

  const fromSettings = loadConfig(base);
  assert.equal(fromSettings.dbOrigin, "settings");
  assert.equal(fromSettings.dbPath, join(stateDir, "from-settings.db"));

  const fromEnv = loadConfig({ ...base, env: { MUNIN_DB: "/tmp/from-env.db" } });
  assert.equal(fromEnv.dbOrigin, "env");
  assert.equal(fromEnv.dbPath, "/tmp/from-env.db");

  const fromFlag = loadConfig({
    ...base,
    env: { MUNIN_DB: "/tmp/from-env.db" },
    db: "/tmp/from-flag.db",
  });
  assert.equal(fromFlag.dbOrigin, "flag");
  assert.equal(fromFlag.dbPath, "/tmp/from-flag.db");

  rmSync(settingsPath);
  const fromDefault = loadConfig(base);
  assert.equal(fromDefault.dbOrigin, "default");
  assert.ok(fromDefault.dbPath.endsWith(join("opencode", "opencode.db")));
});
