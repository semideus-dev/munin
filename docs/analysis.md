# Munin analysis semantics

How `@munin/core` turns a normalized `Dataset` into priced events, aggregates,
findings, and the report. Every rule here is pinned by tests in `tests/unit/`;
this file explains the vocabulary, not the code paths.

## Event construction

`buildEvents(dataset)` walks the source messages in source order and produces:

- **`CallAttempt`** — every assistant or compaction message. A message with no
  usage (failed call, aborted call) is still an attempt. Failed attempts are
  counted in `dataHealth.failedCalls` and never enter call counts or costs.
- **`UsageEvent`** — an attempt that carried token usage. This is the unit of
  account for everything downstream: one event is one model call.

Each event carries identity (`provider/model`, `variant`, `agent`, `projectId`,
`sessionId`, `turnId`), context facts (`contextEpoch` — incremented at each
compaction, `isSubagent`, `prefixHash`), token counts, tool results
(signature/length only, never text bodies), and a `cost` object.

## Token semantics

| Field             | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `inputTokens`     | Source input minus cached input: the tokens billed at the full input rate. |
| `outputTokens`    | **Priced output**: source output plus reasoning (thinking). See ADR-0007.  |
| `thinkingTokens`  | Reasoning tokens, already included in `outputTokens` — never add it again. |
| `cacheReadTokens` | Input served from cache, billed at the cached rate.                        |
| `cacheWrite5m/1h` | Input charged to cache under the 5-minute and 1-hour TTLs.                 |
| `totalTokens`     | Input + priced output + cache read + cache write.                          |

`billableTokens()` converts source counts into billed counts exactly once;
thinking becomes billed output there and nowhere else.

## Cost basis

Per call (docs/adr/0003-observed-cost-headlines.md):

1. **Observed** — the provider-reported charge the source records. This is the
   headline (`cost.total`), and `cost.basis` is `"observed"`.
2. **Estimated** — no reported charge: the same tokens priced on Munin's dated
   rate cards. `cost.basis` is `"estimated"`.
3. **Unpriced** — no card and no recorded charge: headline `0`,
   `estimatedUsd: null`, `cost.unpriced: true`. Reports list these calls and
   their tokens; they are never counted as `$0` spend (docs/adr/0007).

Session aggregates in the source are reconciled against message sums
(`reconcileAggregates`) and are never billed.

## Aggregate definitions

All aggregate builders are pure and deterministic. `summarize()` produces
`Totals` plus one `SpendBucket[]` per grouping (model, provider, project, day,
session, agent). Buckets are sorted by headline spend, then key, so output is
stable. `byProject` keys on project id and labels with the human project name;
a label behind several ids is reported as a collision and warned.

Days bucket in the caller's time zone (`"UTC"` default, `"local"`, or any IANA
zone), DST-safe.

`sessionSummaries()` gives one row per session with usage-bearing calls. A
subagent session stays its own row linked by `parentSessionId`; nothing rolls
children into parents, so session sums equal the totals exactly once.

`cacheStats()` reports cache traffic globally and per model/provider/session/
day. A hit rate of `read / (input + read + write)`; `null` when there is no
input side. Cache **dollars are always the list-price estimate**, even when a
call's headline basis is observed, because the source reports one number, never
a cache invoice. Zero recorded writes mean `writesRecorded: false`, not a NaN
rate. `instructionContext` groups by `prefixHash + agent + model + variant` —
two agents on one model share nothing at request time.

Projections (`projectionDays`): a window up to 30 days is its own pace; longer
windows divide by the recent-30-day equivalent, measured back from the last
call, never the wall clock.

## Finding contract

A finding exists only with an explanation a user could reproduce. Every
finding carries: the exact affected events; `savings` with `currentUsd` (the
affected headline cost over the window), `windowUsd` (the modelled waste,
clamped to what the affected calls actually spent), `monthlyUsd`/`annualUsd`,
`tokensWasted`, `unpriced`, `pricingAsOf`, confidence with its basis, the
assumptions, and a plain-language `calculation`; `affected` traffic with the
share of window spend; tier (`fix`/`try`/`test`); impact, severity, risk, and
`verification`; `observations` sorted most expensive first; and a `fix`.

- `claimByEvent` splits `windowUsd` across affected calls by cost, so
  overlapping findings combine per call (largest claim) instead of adding.
- Tier decides headline treatment: `fix` is clean waste removal, `try` changes
  what the model receives, `test` is shown as "up to" and never summed.
- Detectors return drafts; `buildFinding` derives the money from the events.
  `findingValidationProblems()` rejects any draft without prose, and a
  detector that throws becomes `analysis.detector-error` — never silence.

The two Phase 3 rules: `repeat-tool-calls` (same read-only call repeated in one
context, compounded by every later call) and `repeated-context` (an identical
instruction prefix re-sent uncached by several sessions on one identity).
Phase 4 adds the rest; deferred rules are listed in the phase plan.

## Data health

`dataHealth` in the report (docs/reports.md) is the audit surface: schema and
sources; session/message/model-call/failed-call/compaction/subagent counts;
warnings; unpriced models with any observed spend; observed coverage; the
session-aggregate reconciliation; project label collisions; detector errors;
and instruction-prefix coverage. A reviewer should be able to trace any
headline number to at least one harness mode (`npm run analyze -- <mode>`)
without writing code.
