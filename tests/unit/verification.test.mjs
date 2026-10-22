import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptRisk, resolveVerification, stateForVerdict, verificationModeOf } from "@munin/core";

test("verification mode derives from risk and candidate when not explicit", () => {
  assert.equal(verificationModeOf({ risk: "safe" }), "not-required");
  assert.equal(
    verificationModeOf({ risk: "needs-verification", candidate: { kind: "trim-prompt" } }),
    "replay",
  );
  assert.equal(verificationModeOf({ risk: "needs-verification" }), "manual");
});

test("not-required allows apply; manual and replay fail closed until cleared", () => {
  const safe = resolveVerification({ risk: "safe" }, null);
  assert.equal(safe.state, "not_required");
  assert.equal(safe.canApply, true);

  const manual = resolveVerification({ verification: "manual", risk: "needs-verification" }, null);
  assert.equal(manual.state, "unverified");
  assert.equal(manual.canApply, false);

  const replay = resolveVerification({ verification: "replay", risk: "needs-verification" }, null);
  assert.equal(replay.state, "unverified");
  assert.equal(replay.canApply, false);
  assert.equal(
    resolveVerification(
      { verification: "replay", risk: "needs-verification" },
      { rule: "r", mode: "replay", state: "failed", at: "2026-10-22T00:00:00.000Z" },
    ).canApply,
    false,
  );
});

test("acceptRisk persists manual acceptance through the injected store", () => {
  let data = {};
  const store = {
    load: () => data,
    save: (next) => {
      data = { ...next };
    },
  };

  const accepted = acceptRisk(store, "model-default", "manual", "2026-10-22T12:00:00.000Z");
  assert.equal(accepted.acceptedRiskAt, "2026-10-22T12:00:00.000Z");
  assert.equal(
    resolveVerification(
      { verification: "manual", risk: "needs-verification" },
      store.load()["model-default"],
    ).canApply,
    true,
  );
  assert.equal(stateForVerdict("PASS"), "passed");
  assert.equal(stateForVerdict("FAIL"), "failed");
  assert.equal(stateForVerdict("INCONCLUSIVE"), "inconclusive");
  assert.throws(
    () => acceptRisk(store, "repeat-tool-calls", "replay", "2026-10-22"),
    /manual rules/,
  );
});
