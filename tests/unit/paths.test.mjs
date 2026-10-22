import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePaths, resolvePlatformPaths } from "@munin/local";

test("platform path matrix follows OpenCode's XDG layout", () => {
  const win = resolvePlatformPaths({ platform: "win32", home: "C:\\Users\\Ana", env: {} });
  assert.equal(win.defaultDbPath, "C:\\Users\\Ana\\.local\\share\\opencode\\opencode.db");
  assert.equal(win.stateDir, "C:\\Users\\Ana\\.munin");

  const mac = resolvePlatformPaths({ platform: "darwin", home: "/Users/ana", env: {} });
  assert.equal(mac.defaultDbPath, "/Users/ana/.local/share/opencode/opencode.db");

  const linux = resolvePlatformPaths({ platform: "linux", home: "/home/ana", env: {} });
  assert.equal(linux.defaultDbPath, "/home/ana/.local/share/opencode/opencode.db");

  const absoluteXdg = resolvePlatformPaths({
    platform: "linux",
    home: "/home/ana",
    env: { XDG_DATA_HOME: "/data/xdg" },
  });
  assert.equal(absoluteXdg.defaultDbPath, "/data/xdg/opencode/opencode.db");

  const relativeXdg = resolvePlatformPaths({
    platform: "linux",
    home: "/home/ana",
    env: { XDG_DATA_HOME: "relative/xdg" },
  });
  assert.equal(relativeXdg.defaultDbPath, "/home/ana/.local/share/opencode/opencode.db");

  const emptyEnv = resolvePlatformPaths({
    platform: "win32",
    home: "C:\\Users\\Ana",
    env: { MUNIN_DB: "", MUNIN_DIR: "" },
  });
  assert.equal(emptyEnv.envDbPath, undefined);
  assert.equal(emptyEnv.stateDir, "C:\\Users\\Ana\\.munin");

  // HOME is ignored so Git Bash cannot corrupt Windows paths.
  const gitBash = resolvePaths({
    platform: "win32",
    home: "C:\\Users\\Ana",
    env: { HOME: "/c/Users/Ana", USERPROFILE: "C:\\Users\\Ana" },
  });
  assert.equal(gitBash.defaultDbPath, "C:\\Users\\Ana\\.local\\share\\opencode\\opencode.db");
  assert.equal(gitBash.stateDir, "C:\\Users\\Ana\\.munin");

  const macHome = resolvePaths({
    platform: "darwin",
    home: "/Users/ana",
    env: { HOME: "/somewhere/else" },
  });
  assert.equal(macHome.stateDir, "/Users/ana/.munin");
});
