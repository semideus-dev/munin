import assert from "node:assert/strict";
import { test } from "node:test";
import { costHeadline } from "@munin/core";

test("headline cost follows the observed then estimated basis", () => {
  assert.deepEqual(costHeadline(0.5, 0.9), {
    total: 0.5,
    basis: "observed",
    unpriced: false,
  });

  // A reported zero is a real observation, not a missing value.
  assert.deepEqual(costHeadline(0, 0.9), {
    total: 0,
    basis: "observed",
    unpriced: false,
  });

  assert.deepEqual(costHeadline(null, 0.9), {
    total: 0.9,
    basis: "estimated",
    unpriced: false,
  });

  assert.deepEqual(costHeadline(null, null), {
    total: 0,
    basis: "estimated",
    unpriced: true,
  });
});
