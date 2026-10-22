import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireScanLock } from "@munin/local";

const dir = mkdtempSync(join(tmpdir(), "munin-lock-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("lock refuses a live holder, releases ownership, and recovers a dead pid", () => {
  const path = join(dir, "scan.lock");
  const lock = acquireScanLock(path, "test");
  assert.throws(() => acquireScanLock(path, "second"), /holds the lock/);
  lock.release();

  writeFileSync(path, JSON.stringify({
    pid: 2_147_483_647, startedAt: "2020-01-01T00:00:00.000Z", purpose: "killed process",
  }));
  const recovered = acquireScanLock(path, "recovered", { maxAgeMs: 1 });
  assert.match(recovered.warning, /Removed stale scan lock/);
  recovered.release();
});
