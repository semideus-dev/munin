import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLE_SOLID, SAMPLE_THIN, confidenceOf } from "@munin/core";

test("confidenceOf uses thin/solid sample thresholds and token-profile stability", () => {
  const thin = confidenceOf({ measured: true, sample: SAMPLE_THIN - 1, tokenProfileStable: true });
  assert.equal(thin.level, "low");
  assert.match(thin.basis, new RegExp(`fewer than ${SAMPLE_THIN} calls`));

  const unstable = confidenceOf({ measured: true, sample: SAMPLE_SOLID, tokenProfileStable: false });
  assert.equal(unstable.level, "medium");
  assert.match(unstable.basis, /fix changes how the model responds/);

  const solid = confidenceOf({ measured: true, sample: SAMPLE_SOLID, tokenProfileStable: true });
  assert.equal(solid.level, "high");
  assert.match(solid.basis, /high because only future traffic is assumed/);
});

test("confidenceOf is low when cost was never measured", () => {
  const c = confidenceOf({ measured: false, sample: 1000, tokenProfileStable: true });
  assert.equal(c.level, "low");
  assert.match(c.basis, /cost was never measured/);
});
