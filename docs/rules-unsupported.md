# Unsupported rule actions and parity gaps

This list describes what Munin deliberately does **not** change or verify in
Phase 4. See [`rules.md`](./rules.md) for current detector behavior.

## No external request integration

Munin reads OpenCode history, but it does not own OpenCode’s request or tool
execution path. Therefore it cannot safely:

- intercept an OpenCode request and change its model, reasoning effort, or
  prompt;
- suppress a tool invocation or remove a result from a live agent context;
- rewrite OpenCode settings, session instructions, or its SQLite database.

Those recommendations are shown or queued with manual guidance. The apply
seam only permits Munin-owned `days` and `tz` config keys, and no current rule
maps to those settings. No external change is reported as applied.

## Claude-specific integrations excluded

The rebuild excludes the reference’s Claude Code mod rewrites and its
`statuslineOn` / `guardOn` apply targets, hooks, and setup behavior. They have
no Munin equivalent and are not represented as supported actions. The current
17 detector identifiers remain in the registry; this exclusion concerns
integration/action surfaces, not an invented replacement rule.

## Replay and verification limits

- No live API replay, credentials, or network-based quality test is performed.
- Token replay re-runs a local detector on local events. Plan replay requires a
  caller-injected local/fake executor; this phase does not ship a production
  plan executor.
- Manual `--accept-risk` records the user’s acceptance; it is not an automated
  quality measurement.
- Failed, inconclusive, and missing replay results do not pass the apply gate.

## Reference-parity gap

The registry identifiers match the 17 names in the reference. The Phase 3
`repeat-tool-calls` and `repeated-context` detectors have their earlier
regression fixtures. The other 15 detectors in
`packages/core/src/analyze/rules/ported.ts` currently use the Munin thresholds
and estimates documented in `rules.md`; they have **not all been audited
line-by-line against the corresponding reference functions and reference
fixtures**. In particular, model comparability and the heuristic dollar/token
shares must not be presented as proven reference parity. Exact port auditing is
still required before marking Phase 4 complete.

The harness reports a rule as `skipped` when its detector returns no finding
for the current data window, and as `error` if the detector failed. For now,
the reason is detector-level rather than a detailed list of each unmet
threshold.
