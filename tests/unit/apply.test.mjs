import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFinding, undoLatestChange } from "@munin/core";

function setup(overrides = {}) {
  const state = {
    config: { days: 7 },
    bytes: '{\n  "days": 7,\n  "keep": true\n}\n',
    reads: [],
    writes: [],
    manifest: [],
  };
  const configStore = {
    read(key) {
      state.reads.push(key);
      return Object.hasOwn(state.config, key)
        ? { exists: true, value: state.config[key] }
        : { exists: false };
    },
    write(key, snapshot) {
      state.writes.push([key, snapshot]);
      if (snapshot.exists) state.config[key] = snapshot.value;
      else delete state.config[key];
      state.bytes = `${JSON.stringify(state.config)}\n`;
    },
    snapshot: () => state.bytes,
    restoreSnapshot: (snapshot) => {
      state.bytes = snapshot;
      state.config = snapshot === null ? {} : JSON.parse(snapshot);
    },
  };
  const changes = { load: () => state.manifest, append: (entry) => state.manifest.push(entry) };
  const input = {
    finding: {
      rule: "fixture-rule",
      fix: "Adjust the analysis window",
      verification: "not-required",
    },
    verification: {
      state: "not_required",
      mode: "not-required",
      canApply: true,
      headline: "No verification required.",
      guidance: null,
      record: null,
    },
    dataHealth: { clean: true, reconciliation: { mismatchSessions: 0 } },
    configStore,
    changes,
    at: "2026-10-22T12:00:00.000Z",
    confirmed: true,
    configChange: { rule: "fixture-rule", key: "days", value: 30 },
    ...overrides,
  };
  return { input, state };
}

test("apply journals the full prior value and writes exactly the declared key", () => {
  const { input, state } = setup();
  const result = applyFinding(input);

  assert.equal(result.kind, "applied");
  assert.deepEqual(state.reads, ["days", "days"]);
  assert.deepEqual(state.writes, [["days", { exists: true, value: 30 }]]);
  assert.equal(state.config.days, 30);
  assert.equal(state.manifest.length, 2);
  assert.deepEqual(state.manifest[0], {
    id: "2026-10-22T12:00:00.000Z:fixture-rule:0",
    rule: "fixture-rule",
    at: "2026-10-22T12:00:00.000Z",
    previousBytes: '{\n  "days": 7,\n  "keep": true\n}\n',
    keys: ["days"],
    previous: { days: { exists: true, value: 7 } },
    values: { days: { exists: true, value: 30 } },
    status: "pending",
  });
  assert.equal(state.manifest[1].status, "applied");
});

test("reapplying the same setting is idempotent", () => {
  const { input, state } = setup();
  assert.equal(applyFinding(input).kind, "applied");
  assert.equal(applyFinding(input).kind, "already-applied");
  assert.equal(state.manifest.length, 2);
  assert.equal(state.writes.length, 1);
});

test("external changes queue without touching config or manifest", () => {
  const { input, state } = setup({
    configChange: undefined,
    finding: { rule: "external-rule", fix: "Change the external model", verification: "replay" },
    verification: {
      state: "unverified",
      mode: "replay",
      canApply: false,
      headline: "Not verified.",
      guidance: "Run replay verification first.",
      record: null,
    },
  });
  const result = applyFinding(input);
  assert.equal(result.kind, "queued");
  assert.match(result.reason, /No pre-request integration is installed/);
  assert.equal(result.next, "Run replay verification first.");
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.manifest, []);
});

test("dirty or unverified snapshots refuse before any store write", () => {
  const dirty = setup({ dataHealth: { clean: false, reconciliation: { mismatchSessions: 0 } } });
  assert.equal(applyFinding(dirty.input).kind, "refused");
  assert.deepEqual(dirty.state.reads, []);
  assert.deepEqual(dirty.state.writes, []);

  const mismatch = setup({ dataHealth: { clean: true, reconciliation: { mismatchSessions: 1 } } });
  const refused = applyFinding(mismatch.input);
  assert.equal(refused.kind, "refused");
  assert.match(refused.reason, /1 open mismatch/);
  assert.deepEqual(mismatch.state.reads, []);

  const unverified = setup({
    verification: {
      state: "unverified",
      mode: "replay",
      canApply: false,
      headline: "Not verified.",
      guidance: "Replay is required.",
      record: null,
    },
  });
  assert.equal(applyFinding(unverified.input).kind, "refused");
  assert.deepEqual(unverified.state.writes, []);
});

test("a config change declared for another rule is refused", () => {
  const { input, state } = setup({ configChange: { rule: "other-rule", key: "days", value: 30 } });
  const result = applyFinding(input);
  assert.equal(result.kind, "refused");
  assert.match(result.reason, /not declared for this rule/);
  assert.deepEqual(state.reads, []);
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.manifest, []);
});

test("dry-run and missing confirmation do not access injected stores", () => {
  const dryRun = setup({ dryRun: true });
  assert.equal(applyFinding(dryRun.input).kind, "dry-run");
  assert.deepEqual(dryRun.state.reads, []);
  assert.deepEqual(dryRun.state.writes, []);
  assert.deepEqual(dryRun.state.manifest, []);

  const unconfirmed = setup({ confirmed: false });
  assert.equal(applyFinding(unconfirmed.input).kind, "confirmation-required");
  assert.deepEqual(unconfirmed.state.reads, []);
  assert.deepEqual(unconfirmed.state.writes, []);
});

test("store failures return their cause and preserve the prepared journal entry", () => {
  const { input, state } = setup({
    configStore: {
      read: () => ({ exists: true, value: 7 }),
      snapshot: () => '{"days":7}\n',
      write: () => {
        throw new Error("read-only config store");
      },
      restoreSnapshot: () => {},
    },
  });
  const result = applyFinding(input);
  assert.equal(result.kind, "failed");
  assert.match(result.cause, /read-only config store/);
  assert.equal(state.manifest.length, 1);
  assert.equal(state.manifest[0].status, "pending");
});

test("undo restores the exact prior config bytes, even after a manual mutation", () => {
  const { input, state } = setup();
  assert.equal(applyFinding(input).kind, "applied");
  state.bytes = '{"days":999,"manual":"mutation"}\n';
  state.config = { days: 999, manual: "mutation" };

  const undone = undoLatestChange({
    configStore: input.configStore,
    changes: input.changes,
    at: "2026-10-22T12:10:00.000Z",
    confirmed: true,
  });

  assert.equal(undone.kind, "undone");
  assert.equal(state.bytes, '{\n  "days": 7,\n  "keep": true\n}\n');
  assert.deepEqual(undone.entry.restoredKeys, ["days"]);
  assert.equal(undone.entry.restoredAt, "2026-10-22T12:10:00.000Z");
  assert.deepEqual(undone.remainingPending, []);
});

test("multiple undos restore in reverse apply order", () => {
  const { input, state } = setup();
  assert.equal(applyFinding(input).kind, "applied");
  const afterFirst = state.bytes;
  const second = {
    ...input,
    at: "2026-10-22T12:01:00.000Z",
    configChange: { rule: "fixture-rule", key: "days", value: 60 },
  };
  assert.equal(applyFinding(second).kind, "applied");

  const undoSecond = undoLatestChange({
    configStore: input.configStore,
    changes: input.changes,
    at: "2026-10-22T12:10:00.000Z",
    confirmed: true,
  });
  assert.equal(undoSecond.kind, "undone");
  assert.equal(state.bytes, afterFirst);
  assert.deepEqual(undoSecond.remainingPending, ["2026-10-22T12:00:00.000Z:fixture-rule:0"]);

  const undoFirst = undoLatestChange({
    configStore: input.configStore,
    changes: input.changes,
    at: "2026-10-22T12:11:00.000Z",
    confirmed: true,
  });
  assert.equal(undoFirst.kind, "undone");
  assert.equal(state.bytes, '{\n  "days": 7,\n  "keep": true\n}\n');
  assert.deepEqual(undoFirst.remainingPending, []);
});

test("partial undo failure remains pending and is reported", () => {
  const { input, state } = setup();
  assert.equal(applyFinding(input).kind, "applied");
  const failingStore = {
    ...input.configStore,
    restoreSnapshot() {
      throw new Error("restore failed");
    },
  };
  const result = undoLatestChange({
    configStore: failingStore,
    changes: input.changes,
    at: "2026-10-22T12:10:00.000Z",
    confirmed: true,
  });
  assert.equal(result.kind, "failed");
  assert.match(result.cause, /restore failed/);
  assert.deepEqual(result.remainingPending, ["2026-10-22T12:00:00.000Z:fixture-rule:0"]);
  assert.equal(state.manifest.at(-1).status, "undo-pending");
});
