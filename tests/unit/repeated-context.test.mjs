import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEvents,
  detectFindings,
  detectRepeatedContext,
  REPEATED_CONTEXT_THRESHOLDS,
} from "@munin/core";

const MINUTE = 60_000;
function at(index) {
  return new Date(1737244800000 + index * MINUTE).toISOString(); // 2026-01-19T00:00Z
}

/**
 * Sessions sharing one instruction prefix on one agent, model and variant:
 * `calls` calls in total on the prefix, distributed across `sessions`, each
 * carrying `input` uncached tokens. Nothing else is in the dataset unless
 * `decoy` adds one outside the identity.
 */
function fixture({ sessions, calls, input, prefixHash = "ph-1", decoy = false }) {
  const list = [];
  const messages = [];
  for (let s = 0; s < sessions; s += 1) {
    list.push({
      id: `s${s + 1}`,
      projectId: "p1",
      project: "munin",
      agent: "build",
      model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
      schema: "v2",
      instructions: { keys: ["sys"], chars: 400, prefixHash },
      timeCreated: at(0),
      timeUpdated: at(calls + 1),
    });
    // calls distributed round-robin: s1 gets the first remainder.
    const own = Math.floor(calls / sessions) + (s < calls % sessions ? 1 : 0);
    for (let c = 0; c < own; c += 1) {
      const index = s + c * sessions + 1;
      messages.push({
        id: `m${index}`,
        sessionId: `s${s + 1}`,
        seq: c,
        type: "assistant",
        timeCreated: at(index),
        usage: { tokens: { input, output: 100, thinking: 0, cacheRead: 0, cacheWrite: 0 } },
        stopReason: "stop",
      });
    }
  }
  // A decoy call outside the identity: same prefix hash never shared.
  if (decoy) {
    list.push({
      id: "sd",
      projectId: "p1",
      project: "munin",
      agent: "explore",
      model: { provider: "ollama-cloud", model: "gpt-oss:120b" },
      schema: "v2",
      instructions: { keys: ["sys"], chars: 400, prefixHash: `ph-other` },
      timeCreated: at(0),
      timeUpdated: at(calls + 2),
    });
    messages.push({
      id: "md",
      sessionId: "sd",
      seq: 0,
      type: "assistant",
      timeCreated: at(calls + 1),
      usage: { tokens: { input: input, output: 100, thinking: 0, cacheRead: 0, cacheWrite: 0 } },
      stopReason: "stop",
    });
  }
  return { schema: "v2", sessions: list, messages, warnings: [], sources: ["fixture"] };
}

function detected(dataset) {
  const { findings, errors } = detectFindings(buildEvents(dataset).events, [
    { rule: "repeated-context", run: detectRepeatedContext },
  ]);
  assert.equal(errors.length, 0);
  return findings;
}

function usd(actual, expected, label = "usd") {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${label}: expected $${expected}, got $${actual} (difference ${actual - expected})`,
  );
}

test("repeated-context fires at 3 sessions and 10 calls, and not below either threshold", () => {
  assert.deepEqual(REPEATED_CONTEXT_THRESHOLDS, {
    sessions: 3,
    calls: 10,
    uncachedInputTokens: 20_000,
  });

  // At the thresholds: 3 sessions, 10 calls x 2200 = 22,000 uncached input.
  // Saving = 22,000 x ($0.15/M - $0.014/M) = $0.002992 on the card in force.
  const firing = detected(fixture({ sessions: 3, calls: 10, input: 2200 }));
  assert.equal(firing.length, 1);
  const s = firing[0].savings;
  usd(s.windowUsd, (22_000 * (0.15 - 0.014)) / 1_000_000, "windowUsd");
  usd(s.windowUsd, 0.002992, "windowUsd (same number)");
  usd(s.tokensWasted, 22_000, "tokensWasted");
  usd(s.currentUsd, (10 * (2200 * 0.15 + 100 * 0.6)) / 1_000_000, "currentUsd");
  // try tier: quality changes, so it never counts in the fix headline by itself.
  assert.equal(firing[0].tier, "try");
  assert.equal(firing[0].verification, "replay");
  assert.match(s.assumptions[1], /one-time longer-TTL write cost is not deducted/);
  assert.match(firing[0].detail, /22,000/);

  // Two sessions on one prefix do not fire, whatever the volume.
  assert.deepEqual(detected(fixture({ sessions: 2, calls: 5, input: 2200, decoy: false })), []);

  // Enough sessions and volume but only 9 calls on the prefix: below the bar.
  assert.deepEqual(detected(fixture({ sessions: 3, calls: 3, input: 2500 })), []);

  // 10 calls across 3 sessions but 19,990 uncached input: below the token bar.
  assert.deepEqual(detected(fixture({ sessions: 3, calls: 10, input: 1999 })), []);
});

test("a finding's affects() matches exactly its claimed event ids", () => {
  const findings = detected(fixture({ sessions: 3, calls: 10, input: 2200, decoy: true }));
  assert.equal(findings.length, 1);
  const finding = findings[0];

  const claimed = [...finding.claimByEvent.keys()].sort();
  assert.equal(claimed.length, 10);
  // Claims are split evenly: every affected call costs the same here.
  usd(finding.claimByEvent.get(claimed[0]), 0.002992 / 10, "even claim");
  for (const id of claimed) {
    assert.equal(finding.affects({ id }), true, `affects ${id}`);
    assert.match(id, /^m\d+$/); // the decoy message `md` is never claimed
  }
  assert.equal(finding.affects({ id: "md" }), false);
  assert.equal(finding.claimByEvent.has("md"), false);
  // ...and the decoy does not push the saving above its own arithmetic.
  usd(finding.savings.windowUsd, 0.002992, "window still the group's saving");
});
