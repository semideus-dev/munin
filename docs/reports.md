# Munin report format

`buildReport(dataset, options)` (in `@munin/core`) turns one normalized Phase 2
dataset into one serialisable object. `formatVersion` is `1`; bump it on any
breaking shape change. Every field below is JSON-safe: no functions, Maps,
Sets, Date objects, or clock-dependent values. Two runs on one dataset produce
byte-identical JSON.

## Options

| Option      | Default            | Meaning                                             |
| ----------- | ------------------ | --------------------------------------------------- |
| `zone`      | `"UTC"`            | Time zone day buckets use.                          |
| `detectors` | the standard rules | Finding registry to run (see `analysis/findings/`). |

## Top-level fields

| Field            | Meaning                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `method`         | One paragraph naming the accounting authority (message level), the cost basis rules (observed then estimated), the pricing date, the day time zone, and that finding dollars are modelled waste. |
| `pricingAsOf`    | Catalogue date every list-price estimate rests on (`2026-10-22`).                                                                                                                                |
| `pricingVersion` | Catalogue revision, `1`. Bump when cards change meaningfully.                                                                                                                                    |
| `timeZone`       | The zone exactly as passed.                                                                                                                                                                      |
| `window`         | `{ start, end, days }` from the data itself, never the clock.                                                                                                                                    |
| `totals`         | Global counters and costs (docs/analysis.md, Step 3 semantics).                                                                                                                                  |
| `byModel` …      | `SpendBucket[]` per model, provider, project, day, session, agent, sorted by headline spend then key.                                                                                            |
| `cache`          | `cacheStats()`: global traffic, four breakdowns, shared-prefix reuse. Cache dollars are always the list-price estimate, even on observed-basis calls.                                            |
| `sessions`       | One `SessionSummary` per session with usage-bearing calls. Children are never rolled into parents, so session sums equal the totals.                                                             |
| `findings`       | Detector findings, serialised (below).                                                                                                                                                           |
| `savings`        | De-overlapped recoverable amounts (below).                                                                                                                                                       |
| `dataHealth`     | What a reviewer needs to trust the numbers (below).                                                                                                                                              |

Individual calls are **not** in a report. Use the harness `--events` mode or
fetch events separately (Phase 7 dashboard).

## Findings

A report finding is a detector finding with only the non-function, non-Map
fields kept:

- `rule`, `category`, `title`, `detail`, `why`, `tier` (`fix`, `try`, `test`),
  `impact`, `severity`, `risk`, `verification`, `advisory`,
- `savings`: the `SavingsEstimate` — affected headline cost (`currentUsd`),
  modelled waste clamped to it (`windowUsd`), the window/projection day
  counts, `monthlyUsd`/`annualUsd`, `tokensWasted`, `unpriced`,
  `pricingAsOf`, confidence with its basis, assumptions, and the plain-language
  `calculation` a reviewer can redo by hand,
- `affected`: calls, models, projects, agents, `share` of window spend, and
  `sampleEventIds` for drill-down,
- `observations`: concrete instances, most expensive first,
- `fix`, `candidate` (when the rule offers one),
- `claimByEvent`: the findings' split of `windowUsd` across affected calls by
  cost, as `{ eventId, usd }[]` sorted by `usd` descending then event id.

The `affects(event)` predicate from the runtime finding is not serialised: its
exact membership is carried by `claimByEvent`.

## Savings

Each tier is de-overlapped: overlapping findings claim the same call, so each
call counts once, at its largest claim.

| Field                          | Meaning                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `fix` / `try` / `test`         | One tier each: `tiers`, `claimedCalls`, `windowUsd`, `monthlyUsd`, `annualUsd`.                                |
| `all`                          | `fix + try + test` de-overlapped together. A floor on the total possible.                                      |
| `tokensWasted`                 | Physical waste, summed per finding **without** de-overlap: two findings can count different waste on one call. |
| `pricedTokensWasted`           | The priced share of that sum.                                                                                  |
| `unpricedTokensWasted`         | Token-only waste from findings whose dollars are withheld.                                                     |
| `unpricedFindings`             | Non-advisory findings reporting tokens alone.                                                                  |
| `windowDays`, `projectionDays` | The observed span and the days daily rates were divided by.                                                    |

Monthly and annual figures scale the window amount by `30/projectionDays` and
`365/projectionDays`. A finding that is `unpriced` contributes zero dollars
anywhere in this section — its tokens still appear.

## Data health

| Field                    | Meaning                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `sources`      | Source schema (`v1`/`v2`/`mixed`/`none`) and what was actually read.                                                                                            |
| `sessions`               | Source sessions, including any without usage-bearing calls.                                                                                                     |
| `subagentSessions`       | Sessions the totals classify as subagents.                                                                                                                      |
| `messages`               | All stored messages, including non-model ones.                                                                                                                  |
| `modelCalls`             | Assistant + compaction attempts, including failures.                                                                                                            |
| `failedCalls`            | Attempts with no usage; they never become priced events.                                                                                                        |
| `compactions`            | Compaction attempts, including failed ones.                                                                                                                     |
| `warnings`               | Phase 2 read warnings plus Phase 3 `price.*` and `analysis.*` ones.                                                                                             |
| `unpricedModels`         | Cardless models: `calls`, `unpricedCalls`, and the observed spend the source did record on them (nonzero `observedUsd` with no card is the anomaly to look at). |
| `observedCoverage`       | Share of calls whose headline basis is `observed`.                                                                                                              |
| `reconciliation`         | Session aggregate vs message sums: `checkedSessions`, `mismatchSessions`, `largestDelta`, `mismatches`.                                                         |
| `projectLabelCollisions` | One human label behind several project ids.                                                                                                                     |
| `detectorErrors`         | Rules that threw. Their findings are absent — never silence.                                                                                                    |
| `instruction`            | Instruction-prefix coverage: `sessions`, `sessionsWithInstructions`, `calls`, `callsWithPrefix`.                                                                |

## Example

```bash
npm run analyze -- --report --json > /tmp/munin-report.json
node -e "const r=require('/tmp/munin-report.json'); \
  console.log(r.formatVersion, r.totals.calls, r.savings.fix.windowUsd)"
```
