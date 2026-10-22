# Munin rules and recommendations

This page documents what the current Munin implementation does. It is **not a
claim of exact behavioral parity** with Optimaizr; the parity status and
unsupported integration surfaces are listed in
[`rules-unsupported.md`](./rules-unsupported.md).

## What a rule does

Munin runs rule detectors over locally read, normalized OpenCode usage events.
A detector can produce a finding with evidence, assumptions, a calculation,
confidence, and per-event savings claims. The recommendation layer turns
actionable findings into an action, a traffic-based rationale, allowed actions,
and the user’s saved decision state.

Rules only analyze data. They do not edit OpenCode’s database, conversation
history, prompts, or agent settings. Findings and savings are estimates where
their evidence or assumptions say they are.

## Registry

Rule identifiers are stable strings used in reports and local state. The
registry is `packages/core/src/analyze/rules.ts`.

| Rule                    | Category        | Tier | Verification / replay | Current purpose                                                       |
| ----------------------- | --------------- | ---- | --------------------- | --------------------------------------------------------------------- |
| `pricing-change`        | pricing         | test | manual / none         | Flag a rise in observed effective cost per token. Advisory only.      |
| `cost-spike`            | anomaly         | test | manual / none         | Flag an unusually high-spend day. Advisory only.                      |
| `spend-concentration`   | concentration   | test | manual / none         | Highlight spend dominated by one session. Advisory only.              |
| `cache-churn`           | caching         | try  | replay / token        | Estimate opportunity from low input-side cache reuse.                 |
| `repeat-tool-calls`     | context-bloat   | fix  | not required / none   | Detect repeated read-only tool results within one context.            |
| `repeated-context`      | caching         | try  | replay / token        | Detect shared instruction prefixes resent across sessions.            |
| `prompt-bloat`          | context-bloat   | try  | replay / token        | Estimate instruction overhead using recorded instruction size.        |
| `oversized-input`       | context-bloat   | try  | replay / token        | Flag high-input calls and estimate tokens above the threshold.        |
| `oversized-output`      | context-bloat   | try  | replay / token        | Flag high-output calls and estimate tokens above the threshold.       |
| `oversized-tool-output` | context-bloat   | fix  | not required / none   | Estimate excess captured tool-result size.                            |
| `error-loops`           | retries         | fix  | not required / none   | Detect repeated usage-bearing calls marked with an error stop reason. |
| `model-fit`             | model-selection | try  | replay / token        | Compare coarse per-model cost/output averages.                        |
| `reasoning-effort`      | reasoning       | try  | replay / token        | Flag high reasoning-token share and estimate excess.                  |
| `context-compaction`    | context-bloat   | try  | replay / plan         | Estimate overhead on calls after multiple compaction epochs.          |
| `cold-resume`           | context-bloat   | try  | replay / token        | Estimate rebuild overhead after a long gap within a session.          |
| `heavy-start`           | context-bloat   | try  | replay / token        | Compare a session’s first call with its next two calls.               |
| `model-default`         | model-selection | test | manual / none         | Flag a model used for nearly all calls. Advisory only.                |

`not required` means the proposed change is considered not to affect output
quality. `replay` means a local replay abstraction can assess the finding; the
Phase 4 replay is offline and is not a live model call. `manual` means the user
must validate the change themselves before recording risk acceptance.

## Current detector thresholds and assumptions

The following are the thresholds used by the current implementation. They are
heuristics, not universal definitions of waste:

- **`repeat-tool-calls`:** same read-only tool signature repeated in one main
  context or subagent/compaction epoch; the result must be at least 50 estimated
  tokens. Mutations retire relevant earlier reads.
- **`repeated-context`:** same prefix identity across at least 3 sessions and 10
  calls, with at least 20,000 uncached input tokens.
- **`cache-churn`:** at least 10 calls with at least 2,000 input-side tokens
  each, and aggregate cache hit rate below 35%; estimates 25% of input as
  potentially recoverable.
- **`prompt-bloat`:** at least 6 instruction-bearing calls and 4 calls where
  instruction characters exceed 3.2 times input tokens; characters are
  approximated at 4 per token.
- **`oversized-input`:** at least 3 calls at or above 12,000 input tokens;
  estimated waste is input above 12,000.
- **`oversized-output`:** at least 3 calls at or above 3,000 output tokens;
  estimated waste is output above 3,000.
- **`oversized-tool-output`:** at least 2 calls with tool results above 4,000
  estimated tokens; result tokens are approximated as characters divided by 4.
- **`error-loops`:** at least 3 usage-bearing error calls, with at least two
  calls matching the same session, model, and input-token count. Failed
  attempts without usage are not currently included in this detector.
- **`spend-concentration`:** at least 20 calls and one session holding at least
  65% of window spend. The result is advisory, not proof of waste.
- **`reasoning-effort`:** at least 10 calls with reasoning tokens and average
  reasoning/output share of at least 55%; estimates excess above 35% of output.
- **`cost-spike`:** at least 20 calls across multiple days; the highest-spend
  day must be at least 1.8 times the daily average and at least $0.25 above it.
  The result is advisory.
- **`heavy-start`:** a session needs at least 3 calls; its first call must have
  at least 8,000 input tokens and be at least 1.8 times the average of calls 2
  and 3.
- **`cold-resume`:** a later usage-bearing call follows a 2-hour to 14-day gap,
  has at least 6,000 input tokens, and at least 2 such calls qualify; 35% of
  resumed input is an explicit estimate.
- **`context-compaction`:** at least 5 calls are at context epoch 2 or later;
  15% of their input is an explicit estimate. Plan replay is a mocked,
  caller-injected executor.
- **`pricing-change`:** at least 10 observed-cost calls, with at least 6 for a
  model and at least 3 in each half of its time-ordered sample; compares early
  and late observed cost per token. Advisory only.
- **`model-default`:** at least 20 calls and a top model share of at least 90%;
  its 5% spend figure is advisory sizing, not measured savings.
- **`model-fit`:** at least 25 calls and two models; compares the most expensive
  and cheapest model by average call cost, and assumes 20% of the expensive
  model’s calls can move. It does not establish task equivalence.

## Confidence and overlap

`confidenceOf()` is a qualitative rating based on measured/modelled cost, sample
size, and whether a proposed change could alter token profile. `SAMPLE_THIN` is
10 and `SAMPLE_SOLID` is 50. Confidence is not a probability.

Findings split their dollar claim across affected calls. Report totals
de-overlap claims per call; `overlapWith` and the text report’s overlap line
identify competing rules. Do not add raw finding estimates together as if they
were independent.

## Recommendations and decision state

Recommendations omit advisory findings. They include an action, rationale,
confidence, tier, affected traffic, available actions, and one of these local
statuses: `new`, `viewed`, `applied`, `done`, or `dismissed`. Decisions are
stored in Munin’s state directory, not in OpenCode history.

```bash
npm run analyze -- --findings
npm run analyze -- --findings --json
npm run analyze -- --decide viewed model-fit
```

The `--decide` flag records the user’s decision; it does not execute an
optimization.

## Verification, apply, and undo

```bash
npm run analyze -- --verify-state
npm run analyze -- --accept-risk model-default
```

Only `not-required`, a passing replay, or explicit manual risk acceptance
allows the apply seam to proceed. Failed, inconclusive, and unverified replay
records fail closed.

The core apply/undo API uses injected stores. The config adapter is restricted
to Munin-owned `days` and `tz` settings; the OpenCode database path is not an
apply target. No current rule maps to either setting, so current external-agent
recommendations queue instead of being applied. There is no `apply` or `undo`
CLI command in Phase 4; CLI commands are Phase 6.

Undo journals exact prior Munin config bytes and restores the most recent
pending/applied change. A failed restore stays pending for retry. This is local
Munin config state only.

## Replay

Replay kinds come from rule metadata:

- **Token replay** re-runs the registered pure detector over supplied local
  events, then compares the refreshed wasted-token and per-call claim-window
  totals with the saved finding. A mismatch marks the finding stale.
- **Plan replay** calls a locally injected executor for a canned event slice.
  No built-in plan executor or live model call is included in this phase.

Both return a verdict, refreshed claim, confidence, sample count, and reason;
`recordReplayResult()` writes the mapped record through an injected
`VerificationStore`. Core replay code has no filesystem, environment, or
network access.

## Harness coverage output

`npm run analyze -- --findings --json` and `--report --json` list every
registry rule as `found`, `skipped`, or `error`, including
finding/recommendation counts, verification state, replay kind, and a reason.
The human-readable findings output omits this coverage block. A skipped rule
means its detector returned no finding for this window; the current harness
does not expose each detector’s individual failed threshold.
