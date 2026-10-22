import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const cli = fileURLToPath(new URL("../../apps/cli/dist/cli.js", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "munin-cli-"));
const baseEnv = {
  ...process.env,
  MUNIN_DIR: stateDir,
  MUNIN_DB: join(stateDir, "opencode.db"),
  MUNIN_DEBUG: "",
  NO_COLOR: "1",
};

after(() => rmSync(stateDir, { recursive: true, force: true }));

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
  });
}

test("help groups and environment are present", () => {
  const result = run(["help"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  for (const group of ["Start here", "Change things", "Look closer", "About"]) {
    assert.match(result.stdout, new RegExp(`  ${group}`));
  }
  assert.match(result.stdout, /Environment/);
  assert.ok(result.stdout.includes(stateDir));
  assert.doesNotMatch(result.stdout, /munin card/);
});

test("help all reveals stretch commands and command help lists flags", () => {
  const all = run(["help", "all"]);
  assert.equal(all.status, 0);
  assert.match(all.stdout, /munin card/);
  assert.match(all.stdout, /munin simulate <rule>/);

  const command = run(["scan", "--help"]);
  assert.equal(command.status, 0);
  assert.match(command.stdout, /--full/);
  assert.match(command.stdout, /--repair/);

  const profile = run(["profile", "--help"]);
  assert.equal(profile.status, 0);
  assert.match(profile.stdout, /munin - your usage, waste and the biggest win/);
  assert.doesNotMatch(profile.stdout, /Start here/);
});

test("unknown command exits 64 with no stack", () => {
  const result = run(["nonsense"]);
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command "nonsense"/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("MUNIN_DEBUG=1 puts the stack on stderr only", () => {
  const result = run(["nonsense"], { MUNIN_DEBUG: "1" });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /MuninError/);
  assert.match(result.stderr, /\n\s+at /);
});

test("--json failure is one document and no stack", () => {
  const result = run(["nonsense", "--json"], { MUNIN_DEBUG: "1" });
  assert.equal(result.status, 64);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: {
      code: "cli.unknown-command",
      message: 'Unknown command "nonsense". Run "munin help" to list commands.',
    },
  });
});

test("recognised but unwired commands exit 2 with the JSON contract", () => {
  const result = run(["apply", "--json"]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(JSON.parse(result.stdout).error.code, "cli.not-implemented");
});

test("--version is unchanged", () => {
  const result = run(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0.1.0\n");
  assert.equal(result.stderr, "");
});
