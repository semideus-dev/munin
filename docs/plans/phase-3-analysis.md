# Phase 3 plan: analysis engine, pricing and reporting

Status: complete (closed 2026-10-22)
Owner: team
Scope: turn the Phase 2 source model into priced events, deterministic
aggregates, cache analysis, two repeated-work detectors, the finding/savings
contract, and one structured report. No CLI product commands, ledger, live
monitoring, dashboard, apply/undo, or replay.

Closure note: Steps 0 through 9 are complete. The engine prices every call
(observed headline, dated list-price estimate, token-only unpriced),
aggregates deterministically, analyzes cache reuse, runs two repeated-work
detectors under a full explanation contract, and emits a byte-identical
structured report with data health. The harness
(`npm run analyze -- --<mode>`) reaches every report number without code.
Exit checklist results are marked below against the verification runs of
2026-10-22 (snapshot `munin-phase3-exit.db`; counts drift with the live
database, the invariants do not).
Estimated effort: 10 to 12 hours

## Goal

Turn `Dataset` records into accurate usage and cost analysis that both the CLI
and the dashboard can read. Phase 3 ends when the engine can answer, from real
local history:

- how many billable calls and sessions were read;
- how many tokens of each kind were used;
- what was observed, what the same tokens would cost at dated list prices, and
  what could not be priced;
- which sessions, models, providers, projects, and days the spend sits in;
- how cache reads and writes behaved;
- which repeated work is visible, with tokens, dollars, evidence, and a
  calculation a human can check.

Project exit criterion (`docs/project.md`):

> Known fixtures produce deterministic totals and every cost/savings estimate
> has an explainable calculation.

Definition of done:

- A pure `buildEvents(dataset)` function turns Phase 2 records into priced
  `UsageEvent`s with no filesystem, clock, or network access.
- The price registry is dated, unit-explicit (USD per 1,000,000 tokens), and
  reports unpriced models instead of treating them as free.
- Totals, sessions, models, providers, projects, and days reconcile with SQL on
  a stable snapshot.
- Cache reads and writes are reported separately. No division by zero when no
  writes exist.
- Two detectors run end to end: `repeat-tool-calls` and `repeated-context`.
- Every finding carries evidence, confidence, assumptions, a calculation, the
  affected calls, and a per-call claim map for de-overlapping totals.
- `buildReport()` returns one deterministic, JSON-serialisable object with
  totals, breakdowns, cache, findings, savings, and data health.
- `scripts/analyze-local.mjs` makes every figure verifiable by hand.
- New tests pass; the existing 12 tests still pass.
- The source database and `MUNIN_DIR` stay untouched.

## Current situation (2026-10-22)

Phase 1 and Phase 2 are complete. The workspace has `packages/core`,
`packages/local`, and `apps/cli`, builds with npm, and has 12 passing tests
(`71e5de0 feat: finished phase 2`).

### What Phase 2 produced

`readDataset()` returns a `Dataset` with:

- sessions with project, parent, model, agent, instructions, and aggregate
  usage kept only for reconciliation;
- assistant, user, compaction, lifecycle, and synthetic messages;
- provider-reported token counts and observed cost per model call;
- tool names, signatures, targets, result character counts, and error status;
- instruction keys, character totals, and a prefix hash;
- warning-only reconciliation against session aggregates.

On a 2026-10-22 snapshot: 22 sessions, 4 subagent sessions, 1,196 usage-bearing
model calls, 16 failed assistant attempts with no usage, and 10 sessions with
aggregate drift. Totals drift because the database is live; always snapshot
before comparing.

### What already exists but is unused

The Phase 1 domain model already contains the analysis contracts:

- `UsageEvent`, `TokenCounts`, `CostCalculation`, `CostBasis`, `Evidence`;
- `costHeadline()` in `core/domain/cost.ts` (observed wins, then estimated,
  otherwise unpriced);
- `ModelRef`, `ToolCall`, `TaskKind`, `WorkloadCategory`.

No code constructs a `UsageEvent`, applies a price, or aggregates anything yet.

### Phase 2 gaps that Phase 3 must close first

These are small, but each one would silently corrupt Phase 3 numbers:

1. **Tool signatures use Claude field names.** OpenCode sends `grep` with
   `pattern` and `include`, `glob` with `pattern`, and `edit` with `oldString`.
   The current mapper reads `regex`, `include_pattern`, `glob`, and `old_text`,
   so OpenCode grep calls collapse to `Grep:|`, glob calls to `Glob:`, and edits
   to `Edit:path#`. Repeated-work detection would count false repeats.
2. **OpenCode output excludes reasoning.** On the snapshot,
   `deepseek-v4.1-flash-free` reports 282,565 output tokens and 307,293
   reasoning tokens. Reasoning is billed as output but is stored separately, so
   the priced output count is `tokens.output + tokens.reasoning`, with
   `thinkingTokens` as the subset. This must be asserted.
3. **The harness counts subagents by agent name.** `--summary` looks for an
   agent named "subagent"; OpenCode uses `explore` and records the relationship
   in `parent_id`. The report must use `session.parentId`.
4. **`prefixHash` does not include agent or model.** Phase 2's plan says it
   hashes instructions plus agent, provider, model, and variant; the
   implementation hashes only instruction keys and blob hashes. Phase 3 must
   group cache identity by `prefixHash + agent + model + variant`, and the
   Phase 2 doc must be corrected.
5. **`docs/readers.md` was never written and Phase 2 had no exit record.**
   Both are paperwork gaps, not code gaps.
6. **Project labels are basenames.** The live database has several project ids
   for the same worktree (`munin`, `nexus`). Phase 3 groups by project id and
   reports label collisions as data health; path canonicalisation is deferred.

### Local pricing facts verified for this plan

The local history is unusual: most traffic is free or needs an explicit card.

- `opencode/deepseek-v4.1-flash-free`: 542 calls, observed cost `$0`. Needs an
  explicit `$0` card. The current prefix matcher must not be allowed to resolve
  a `-free` id to a paid sibling.
- `ollama-cloud/gpt-oss:120b`: 654 calls, observed cost `$0.759757726`.
  Ollama publishes `$0.15` input, `$0.014` cached input, `$0.60` output per
  million tokens. At those rates the estimated cost is exactly
  `$0.759757726`, delta `0`. This is the strongest real-world validation
  available for token mapping and cache-read pricing.
- `ollama-cloud/glm-5.3-flash`, `ollama-cloud/kimi-k3`, and
  `opencode/glm-5.3-flash-free` appear once each with no usage. They exercise
  failed/empty calls, not spend.
- `glm-5.3-flash-free` would wrongly prefix-match the paid `glm-5.3-flash`
  card without a free guard. The guard and an explicit `$0` card are both
  required.

## Scope decisions

- **Priced events live in `@munin/core`.** The builder takes a `Dataset` and
  returns events plus warnings. It never opens a database or reads the clock.
- **Observed cost headlines; list-price estimate is secondary.** This follows
  ADR-0003. A report always carries both, labelled, never one ambiguous total.
- **Estimated cost comes only from dated rate cards.** No effective rate is
  inferred from an observed total. An unpriced model stays unpriced and is
  listed in data health.
- **`-free` model ids never prefix-match a paid card.** Longest exact match
  wins; a free id needs an explicit `$0` card or it is unpriced.
- **Canonical tokens, not vendor JSON.** `costForTokens()` takes Munin's
  `TokenCounts`; vendor-specific `normalizeUsage()` is not used internally.
- **One billable event per message with usage.** Failed attempts with no usage
  are kept separately for Phase 4's `error-loops` rule, not counted as free
  calls.
- **Two detectors now, the rest in Phase 4.** Phase 3 ships
  `repeat-tool-calls` and `repeated-context`, plus the finding contract. Phase 4
  adds the 17-rule registry, recommendations, apply/undo, and replay.
- **Savings on unpriced traffic are token-only.** `windowUsd` is zero,
  `unpriced` is true, and the wasted tokens are still reported. Never call an
  unpriced call free.
- **The report is a contract, not a screen.** It is plain JSON with a format
  version. Terminal, HTML, and dashboard rendering are later phases.
- **No ledger, live polling, apply, dashboard, or other readers.**

## Data flow

```text
Dataset (Phase 2)
  |
  +-- reconcileAggregates() ---------------------> data health
  |
  +-- buildEvents()
  |     +-- assistant/compaction with usage -----> UsageEvent (priced)
  |     +-- assistant/compaction without usage --> CallAttempt (failure)
  |     +-- turns, context epochs, subagents
  |     +-- observed + estimated + headline cost
  |
  +-- summarize() / sessionSummaries() / cacheStats()
  |     +-- totals, by model/provider/project/day/session
  |
  +-- detectFindings()
  |     +-- repeat-tool-calls
  |     +-- repeated-context
  |
  +-- buildReport()
        +-- totals + breakdowns + cache + findings + savings + data health
```

## Deliverables

| Deliverable                        | Where                                                    | Proof                        |
| ---------------------------------- | -------------------------------------------------------- | ---------------------------- |
| Dated pricing registry and aliases | `core/pricing/*`                                         | `pricing.test.mjs`           |
| Canonical token cost math          | `core/pricing/cost.ts`                                   | `pricing.test.mjs`           |
| Priced events and attempts         | `core/analyze/build.ts`                                  | `build-events.test.mjs`      |
| Totals and breakdowns              | `core/analyze/summary.ts`, `sessions.ts`                 | `summary.test.mjs`           |
| Cache analysis                     | `core/analyze/cache.ts`                                  | `cache.test.mjs`             |
| Finding and savings contract       | `core/domain/finding.ts`, `core/analyze/findings.ts`     | `findings.test.mjs`          |
| Repeated tool-call detector        | `core/analyze/findings/repeat-tool-calls.ts`             | `repeat-tool-calls.test.mjs` |
| Repeated-context detector          | `core/analyze/findings/repeated-context.ts`              | `repeated-context.test.mjs`  |
| Structured report                  | `core/report/report.ts`                                  | `report.test.mjs`            |
| Development harness                | `scripts/analyze-local.mjs`                              | Manual audit below           |
| Documentation                      | `docs/analysis.md`, `docs/pricing.md`, `docs/reports.md` | Review                       |

## Steps

### Step 0: Close the Phase 2 dependencies (45 min)

Files:

- `packages/core/src/normalize/tools.ts`
- `packages/core/src/normalize/opencode-v2.ts` (comments only)
- `scripts/read-local.mjs` (subagent count)
- `tests/unit/v1.test.mjs`, `tests/unit/v2.test.mjs`
- `docs/readers.md` (new)
- `docs/plans/phase-2-readers.md`, `docs/plans/README.md`, `docs/project.md`

Work:

- Read both field spellings when building signatures:
  - `Grep`: `pattern` or `regex`; `include` or `include_pattern`; include the
    `path` so the same pattern in two directories is not a repeat.
  - `Glob`: `pattern` or `glob`; include the `path`.
  - `Edit`: `oldString` or `old_text`; include a short, stable hash of the old
    text so two different edits to one file differ. Never put the old text in
    the signature: it is source code, and the signature is serialised.
  - `Read`, `WebFetch`, `Bash`, `LS`: keep the current rules, with `path`
    fallbacks where they exist.
- Canonicalise the OpenCode tool names Phase 3 classifies:
  `write` to `Write`, `search` to `Search`, `find` to `Find`, `exec` to `Bash`,
  `execute` to `Execute`, `print_tree` to `PrintTree`. Leave unknown names raw.
- Set `target` from `path` or `filePath` for every file tool, including write.
- Fix the harness `subagentCount` to count sessions with `parentId`, not agent
  names.
- Add fixture assertions:
  - an OpenCode grep signature contains its pattern and path;
  - two globs with different patterns differ;
  - two edits to one file with different old text differ;
  - a write retires earlier reads (test in Phase 3 Step 6).
- Write `docs/readers.md`: reader API, V1/V2 mapping, mixed-schema policy,
  instruction hash scope, text stripping, read-only guarantees, manual
  commands.
- Correct the Phase 2 plan's instruction-hash paragraph: the implementation
  hashes instruction keys and blob hashes, not agent, provider, model, or
  variant.
- Confirm Phase 2 is marked complete in its plan, the plans README, and
  `docs/project.md`; keep the closure commit and the remaining documentation
  debt noted there.

Verify by hand:

```bash
npm test
npm run reader -- --summary
npm run reader -- --summary --json | grep -o '"subagent[^,]*'
```

Expected: tests pass; the harness reports 4 subagent sessions on the current
history; no `Grep:|`, `Glob:`, or `Edit:path#` signatures appear in `--json`.

Done when: the signatures distinguish real work, subagents are counted from
`parent_id`, and Phase 2 has one status.

Step 0 status: complete on 2026-10-22. `docs/readers.md` now exists, tool
signatures read both field spellings and carry path/hash identities, and the
reader harness counts subagent sessions from `parentId`. The 12 existing tests
still pass, and a 23-session local snapshot reports 4 subagent sessions with no
collapsed `Grep:|`, `Glob:`, or `Edit:path#` signatures.

### Step 1: Pricing registry and cost math (1.5 h)

Files:

- `packages/core/src/pricing/types.ts`
- `packages/core/src/pricing/providers.ts`
- `packages/core/src/pricing/catalogue/anthropic.ts`
- `packages/core/src/pricing/catalogue/openai.ts`
- `packages/core/src/pricing/catalogue/google.ts`
- `packages/core/src/pricing/catalogue/open.ts`
- `packages/core/src/pricing/catalogue/ollama.ts`
- `packages/core/src/pricing/resolve.ts`
- `packages/core/src/pricing/cost.ts`
- `packages/core/src/pricing/index.ts`
- `packages/core/src/index.ts`
- `packages/core/src/diagnostics.ts` (`price.*` codes)
- `tests/unit/pricing.test.mjs`

Work:

- Port `RateCard`, `ModelPrice`, `ProviderCachePolicy`, `SERVER_TOOLS`, and
  `PROVIDERS` from `optimaizr/packages/core/src/pricing.ts`. Keep the dated card
  shape: `from`, optional `until`, per-million rates, optional cached and write
  rates, long-context bands, off-peak factors.
- Add `PRICING_AS_OF = "2026-10-22"` and `PRICING_VERSION = 1`.
- Port the model catalogue by provider. Keep the reference's 2026-10-19 cards
  and label them as ported. Do not silently freshen prices.
- Add the models observed locally, with sources:
  - `ollama-cloud` provider policy: read multiplier derived from the explicit
    cached rate, write 1.0, batch 1.0.
  - `gpt-oss:120b`: input 0.15, cached 0.014, output 0.60, context 131,072.
  - `gpt-oss:20b`: input 0.07, cached 0.035, output 0.30.
  - `deepseek-v4.1-flash`: input 0.30, cached 0.006, output 1.20, off-peak 0.5
    outside 12:00-18:00 UTC on weekdays and all weekend.
  - `glm-5.3-flash`: input 0.15, cached 0.03, output 0.50.
  - `glm-5.3`: input 1.40, cached 0.26, output 4.40.
  - `kimi-k3`: input 3.00, cached 0.30, output 15.00.
  - `opencode/deepseek-v4.1-flash-free`: explicit `$0` card.
  - `opencode/glm-5.3-flash-free`: explicit `$0` card.
- Resolver rules:
  - exact id, then lowercase id;
  - strip platform prefixes (`us.`, `eu.`, `apac.`) and vendor prefixes already
    handled by the reference;
  - longest prefix match for date-suffixed ids;
  - **free guard:** an id containing `-free` or ending in `:free` resolves only
    to an exact card;
  - return `{ price, matchedBy }` so data health can explain the match.
- Cost math from canonical tokens:
  - `costForTokens(tokens: TokenCounts, modelId, options)`.
  - `options`: `at` (call timestamp), `speed`, `batch`, `promptTokens`.
  - Resolve the rate card by date; apply long-context, fast, batch, and
    off-peak rules in the same order as the reference.
  - `cacheWrite` is treated as the 5-minute TTL; `cacheWrite1h = 0` because
    Phase 2 stores one aggregate.
  - `estimateCost({ tokens, model, observedUsd, at, ... })` returns a
    `CostCalculation`: per-category estimate, `observedUsd`, `estimatedUsd`,
    `total` from `costHeadline`, `basis`, `unpriced`.
  - A finite observed zero is a real observed zero. A missing observed cost
    with a card is `estimated`. Missing cost and no card is `unpriced`.
- Use the **price card's provider** for cache multipliers, never the source
  provider string. A gateway named `opencode` or `ollama-cloud` must not change
  how the underlying model prices cache.
- Add warnings: `price.unpriced-model` (aggregated by model, with calls and
  observed spend). Keep `source.missing-cost` for the Phase 2 count.

Verify by hand:

```bash
node --test tests/unit/pricing.test.mjs
```

Expected: a synthetic 1M-token call on `gpt-oss:120b` costs `$0.75` input-side
plus output at `$0.60`; a missing card is unpriced, not `$0`; an observed zero
is `basis: "observed"`; a dated call selects the card in force; a
`glm-5.3-flash-free` id never resolves to `glm-5.3-flash`.

Done when: every local model either has a card or appears in the unpriced list,
and the cost math is independent of any vendor JSON shape.

### Step 2: Priced events and attempts (1.5 h)

Files:

- `packages/core/src/domain/analysis.ts` (`PricedDataset`, `CallAttempt`, `Window`)
- `packages/core/src/analyze/build.ts`
- `packages/core/src/analyze/turns.ts`
- `packages/core/src/index.ts`
- `tests/unit/build-events.test.mjs`

Work:

- `CallAttempt` covers every assistant or compaction message, including failed
  ones. Fields: id, sessionId, ts, type, model ref, agent, usage if present,
  observed cost if present, stop reason, error type, turn id. Failed attempts
  are data health and Phase 4 input, not billable events.
- `UsageEvent` is built only for attempts with usage. This keeps calls and cost
  averages honest and prevents "no tokens" from looking free.
- Map:
  - `id`: message id.
  - `source`: `"opencode"`.
  - `schema`: session schema.
  - provider/model/variant: message model, then session model, then `unknown`.
  - `ts`: message time created; `endTs`: completed time; `latencyMs` when both
    exist and the difference is non-negative.
  - session, project id and label, parent session id, agent.
  - `inputTokens`: source input (already uncached).
  - `outputTokens`: source output **plus** source thinking.
  - `thinkingTokens`: source thinking (a subset of priced output).
  - `cacheReadTokens`: source cache read.
  - `cacheWrite5mTokens`: source cache write; `cacheWrite1hTokens`: 0.
  - tools, instruction keys, instruction chars, prefix hash.
  - `isSubagent`: `session.parentId !== undefined`.
  - `contextEpoch`: number of compaction messages earlier in the session.
  - `turnId` and `turnStartedAt`: the most recent `user` message at or before
    the call.
  - `category`, `taskKind`: left undefined; Phase 4 derives them.
  - `cost`: `estimateCost(...)`.
- Window: first event time, last end time or event time, elapsed days
  (`max(1, diff / 86_400_000)`). Empty input gives a zero window and an
  `analysis.no-events` warning.
- Stable ordering: timestamp, then session id, then event id. No `Date.now()`.
- Warnings: carry Phase 2 warnings unchanged; add one `price.unpriced-model`
  per model with calls and observed spend; add `analysis.no-events` when empty.
- Do not mutate the input `Dataset`.

Tests:

1. One assistant, one compaction, one user: context epoch after compaction,
   turn assignment, subagent flag, parent link.
2. Output plus thinking is priced output; thinking is the subset.
3. Observed zero stays observed; missing observed with a card is estimated;
   missing card is unpriced.
4. Failed attempts with no usage are counted separately and are not events.
5. Empty dataset and missing model fall back without throwing.
6. Serialised events contain no text, tool output, or prompt fields.

Verify by hand:

```bash
node --test tests/unit/build-events.test.mjs
npm run analyze -- --events --json
```

Expected: event count equals Phase 2 `modelCalls`; failed attempts equal the
assistant rows without `tokens`; the sum of event observed cost equals the
dataset observed cost.

Done when: every model call has a cost basis and no failed attempt is billed.

### Step 3: Totals, sessions, models, providers, projects, days (1.5 h)

Files:

- `packages/core/src/analyze/summary.ts`
- `packages/core/src/analyze/sessions.ts`
- `packages/core/src/analyze/day.ts`
- `tests/unit/summary.test.mjs`

Work:

- `summarize(events, options)` returns:
  - calls, sessions, turns, subagent sessions;
  - input, output (priced output including thinking), thinking, cache read,
    cache write, total tokens;
  - headline cost, observed cost, API-equivalent estimate, unpriced calls and
    models, observed coverage;
  - cache hit rate, thinking share, average tokens and cost per call;
  - buckets by model, provider, project, day, session, and agent.
- Bucket fields: calls, tokens by category, observed/estimated/headline cost,
  share of spend, cache hit rate, unpriced flag, models/providers present.
- `byDay` uses UTC by default; accept `"local"` or an IANA zone. Never slice a
  raw ISO string for a non-UTC zone; use `Intl.DateTimeFormat.formatToParts`.
- `sessionSummaries(events, sessions)` returns per session: title, project,
  parent, subagent flag, agent, model(s), first/last time, calls, turns, tokens,
  costs, cache hit rate, compactions, observed coverage.
- Subagent sessions stay separate and roll up only by explicit `parentId`.
  Never add a child's cost into the parent and then total both.
- Group projects by `projectId`; display `project` label. If one label maps to
  more than one id, add `analysis.project-label-collision` to data health.
- Top calls by headline cost and by tokens, with stable ties.
- All ordering is deterministic: cost desc, then key asc, then id asc.

Tests:

1. Known fixture totals exact.
2. Day bucketing in UTC and one DST-affected IANA zone, with fixed timestamps.
3. Subagent counted once and flagged.
4. Cache hit rate with zero cache writes; no NaN.
5. Unpriced calls excluded from the API-equivalent total, included in observed
   and headline.
6. Project label collision reported once, with the ids.

Verify by hand:

```bash
node --test tests/unit/summary.test.mjs
npm run analyze -- --totals
npm run analyze -- --models
```

Expected: bucket sums equal totals; session sums equal totals; model calls sum
to the event count.

Done when: every bucket can be added back to the total without a remainder.

### Step 4: Cache read/write analysis (45 min)

Files:

- `packages/core/src/analyze/cache.ts`
- `tests/unit/cache.test.mjs`

Work:

- Global: read tokens, write tokens, input tokens, hit rate
  (`read / (input + read + write)`), estimated read cost, estimated write cost,
  cache share of spend, and the 5m/1h write split.
- By model, provider, session, and day: read/write tokens, hit rate, estimated
  cache cost, and change over the window.
- Instruction context: sessions with instructions, total instruction chars,
  distinct prefix hashes, sessions sharing a prefix. Group cache identity by
  `prefixHash + agent + model + variant`, not `prefixHash` alone.
- Cost basis: per-category cache cost is always the list-price estimate. Label
  it `estimated`; never present it as observed. The observed total remains a
  single source figure.
- Zero writes: report `writesRecorded: false` and a zero write cost, not a NaN
  or a division error.
- Do not claim that a low hit rate is waste. That is Phase 4's `cache-churn`
  rule.

Tests:

1. Known cache multipliers on a synthetic Anthropic card.
2. Zero writes and zero input-side tokens.
3. Hit rate formula and cache cost exact.
4. Prefix grouping separates models and agents.

Verify by hand:

```bash
node --test tests/unit/cache.test.mjs
npm run analyze -- --cache
```

Expected on the snapshot: cache read total equals SQL; cache write is `0` with
`writesRecorded: false`.

Done when: cache numbers are descriptive, labelled estimated, and never double
count with the headline.

### Step 5: Finding and savings contract (1 h)

Files:

- `packages/core/src/domain/finding.ts`
- `packages/core/src/analyze/findings.ts`
- `packages/core/src/analyze/projection.ts`
- `tests/unit/findings.test.mjs`
- `docs/adr/0007-canonical-tokens-and-unpriced-savings.md` (decision record)

Work:

- Port the finding shape from the reference:
  `rule`, `category`, `title`, `detail`, `why`, `tier`, `savings`, `affected`,
  `impact`, `severity`, `risk`, `verification`, `observations`, `fix`,
  `claimByEvent`, `candidate`.
- `SavingsEstimate` additions for Munin:
  - `tokensWasted: number`;
  - `unpriced: boolean`;
  - `pricingAsOf: string`.
- Build rules:
  - `currentUsd` is the headline cost of the affected calls.
  - `windowUsd` is the modelled waste, clamped to affected spend.
  - `monthlyUsd` and `annualUsd` project the window at the recent pace.
  - `claimByEvent` splits the window figure across affected calls by cost; when
    cost is zero, split evenly.
  - `assumptions` includes the clamp explanation when it fires.
  - `calculation` is a plain-language formula with the units and the rate card
    date.
  - `unpriced` is true when any affected call has no card and no observed cost;
    in that case `windowUsd` is zero and `tokensWasted` still reports the
    physical waste.
- `recoverableWindow(findings)` and `recoverableByEvent(findings)` de-overlap
  findings per call. Only `fix` tier counts in the headline; `try` and `test`
  are separate.
- Detector failures return `AnalysisError[]`, not silence. A crashed detector
  must not look like a clean `$0`.
- `projectionDays`: use the recent 30-day pace for windows longer than 30 days,
  measured back from the last call. This is deterministic for a fixed dataset.

Tests:

1. Exact savings arithmetic on a known event.
2. Clamp when modelled waste exceeds affected spend.
3. Two findings on one call de-overlap to the larger claim.
4. Unpriced finding has tokens, zero dollars, and `unpriced: true`.
5. A finding without a calculation or assumptions fails validation.
6. Detector error is reported with the rule name.

Verify by hand:

```bash
node --test tests/unit/findings.test.mjs
```

Expected: every assertion names the exact dollar and token figures, not just
"greater than zero".

Done when: no finding can exist without an explanation a user could reproduce.

### Step 6: Repeated-work detectors (1.5 h)

Files:

- `packages/core/src/analyze/findings/repeat-tool-calls.ts`
- `packages/core/src/analyze/findings/repeated-context.ts`
- `packages/core/src/analyze/findings/index.ts`
- `tests/unit/repeat-tool-calls.test.mjs`
- `tests/unit/repeated-context.test.mjs`

Work:

- Define contexts for repeated reads:
  `sessionId + (isSubagent ? turnId : "main") + contextEpoch`. A subagent starts
  empty, so its reads are not repeats of the parent. A read after a compaction
  is not a repeat.
- Tool classification:
  - read-only: `Read`, `Grep`, `Glob`, `WebFetch`, `LS`, `Search`, `Find`,
    `PrintTree`;
  - mutating: `Edit`, `Write`, `Bash`, `Execute`, `Subagent`;
  - neutral: `Question`, `Skill`, and lifecycle tools;
  - unknown: treat as mutating, so repeats are under-counted, never
    over-counted.
- Retire earlier reads:
  - an edit or write to a file retires reads of that file;
  - any mutation retires searches, globs, fetches, and tree listings;
  - an errored mutation does not retire anything.
- Duplicate threshold: same signature seen before in the context and a result
  of at least 50 tokens (`resultChars / 4`, matching the reference).
- Cost of a duplicate:
  `result tokens * input rate * (write5m multiplier + remaining calls in context * cache read multiplier) / 1_000_000`.
  The rate and multipliers come from the price card, not the source provider.
- Emit a finding when at least one duplicate exists. USD may be zero for a `$0`
  card; tokens are still reported. On unpriced traffic, set `unpriced`.
- `repeated-context`:
  - group events by `prefixHash + agent + model + variant`;
  - require at least 3 sessions, at least 10 calls, and at least 20,000 uncached
    input tokens;
  - saving = `uncached input * input rate * (1 - cache-read multiplier) / 1e6`;
  - evidence `inferred`; assumption: a longer cache TTL would capture the
    prefix. State that the one-time longer-TTL write cost is not deducted.
- Both findings carry the exact affected event ids and a sample of
  observations, most expensive first.

Tests:

1. A duplicate read in one context: exact tokens, exact USD, exact remaining-call
   factor.
2. A read after an edit to that file is not a repeat; a read after a compaction
   is not a repeat; a subagent read is not a repeat of the main session.
3. An errored read is not counted; an unknown tool retires reads.
4. A `$0` card yields a token-only finding; an unpriced card yields
   `unpriced: true`.
5. Repeated context fires at 3 sessions and 10 calls, and not below either
   threshold.
6. A finding's `affects()` matches exactly its claimed event ids.

Verify by hand:

```bash
node --test tests/unit/repeat-tool-calls.test.mjs tests/unit/repeated-context.test.mjs
npm run analyze -- --findings
npm run analyze -- --findings --json
```

Expected on the snapshot: at least one `repeat-tool-calls` finding.
`repeated-context` may legitimately return null if no prefix reaches all three
thresholds; the JSON should show the thresholds it checked. Each finding prints
its calculation and assumptions; the repeat-read finding's event ids all belong
to the same session and context epoch.

Done when: a reviewer can pick one duplicate from the JSON, recompute its
tokens and dollars, and get the same number.

### Step 7: Structured report (45 min)

Files:

- `packages/core/src/domain/report.ts`
- `packages/core/src/report/report.ts`
- `tests/unit/report.test.mjs`
- `docs/reports.md` (new)

Work:

- `buildReport(dataset, options)` returns:
  - `formatVersion`: `1`;
  - `pricingAsOf`, `pricingVersion`, `timeZone`;
  - `window`;
  - `totals`;
  - `byModel`, `byProvider`, `byProject`, `byDay`, `bySession`;
  - `cache`;
  - `findings` (serialisable: `claimByEvent` becomes a sorted array of
    `{ eventId, usd }`);
  - `savings`: recoverable window, monthly, annual, priced and unpriced splits,
    `tokensWasted`;
  - `dataHealth`: schema, sources, session/message/model-call/failed-call/
    compaction/subagent counts, warnings, unpriced models with observed spend,
    observed coverage, reconciliation summary, project label collisions,
    detector errors, instruction coverage.
- Include `method`: one paragraph naming the accounting authority (message
  level), the cost basis rules (observed then estimated), the pricing date, the
  day time zone, and the fact that category costs are estimates.
- No functions, Maps, dates, or locale strings in the report. Stable ordering
  everywhere. Two runs on one dataset must produce byte-identical JSON.
- Do not include individual events in the report. The harness has `--events`
  for inspection; the dashboard will fetch events separately in Phase 7.

Tests:

1. A fixture report matches a stored snapshot byte for byte.
2. Bucket sums equal totals; session sums equal totals; priced plus unpriced
   calls equals total calls.
3. Findings in the report equal detector output, with `claimByEvent` converted
   to an array.
4. JSON.stringify succeeds and contains no `"[object"` or function values.
5. Empty dataset produces a valid report with `analysis.no-events`.

Verify by hand:

```bash
node --test tests/unit/report.test.mjs
npm run analyze -- --report --json > /tmp/munin-report.json
node -e "const r=require('/tmp/munin-report.json'); console.log(r.formatVersion, r.totals.calls, r.savings.windowUsd)"
```

Expected: valid JSON, reconciling sums, a format version, and no clock-dependent
field.

Done when: the CLI and the dashboard could both render from this object without
recomputing anything.

### Step 8: Analysis harness and manual audit (1 h)

Files:

- `scripts/analyze-local.mjs`
- root `package.json` (`"analyze": "npm run build && node scripts/analyze-local.mjs"`)

Modes:

| Flag              | Output                                                     |
| ----------------- | ---------------------------------------------------------- |
| `--totals`        | calls, sessions, tokens, observed/estimated/headline costs |
| `--models`        | per model: calls, tokens, costs, unpriced, share           |
| `--sessions`      | per session: calls, tokens, cost, cache, subagent flag     |
| `--cache`         | cache read/write, hit rate, prefix reuse                   |
| `--findings`      | findings with calculation, assumptions, evidence           |
| `--report`        | full report                                                |
| `--events`        | priced events and failed attempts (debug)                  |
| `--session <id>`  | one session's events and summary                           |
| `--tz <zone>`     | day bucketing (`UTC` default)                              |
| `--db <path>`     | database path                                              |
| `--json`          | JSON on stdout, warnings on stderr                         |
| `--check-privacy` | fail on banned keys in the serialised output               |

Presentation: plain ASCII, no em dashes, no box drawing, warnings on stderr,
exit `0` on success, `1` on runtime failure, `64` on usage errors.

Verify by hand:

```bash
npm run analyze -- --totals
npm run analyze -- --models
npm run analyze -- --cache
npm run analyze -- --findings
npm run analyze -- --report --json > /tmp/munin-report.json
npm run analyze -- --check-privacy
```

Expected: every mode works against the default database; `--json` stdout parses
on its own; a missing database exits `1`; an unknown flag exits `64`.

Done when: every number in the report can be reached by at least one harness
mode without writing code.

### Step 9: Documentation and exit review (30 min)

Files:

- `docs/analysis.md` (new): event construction, token semantics, cost basis,
  aggregate definitions, finding contract, data health.
- `docs/pricing.md` (new): rate-card provenance, units, the local model cards,
  free/unpriced policy, how to update a price.
- `docs/reports.md` (new): report format version and field meanings.
- `docs/adr/0007-canonical-tokens-and-unpriced-savings.md` (new): canonical
  tokens, priced output including reasoning, unpriced findings as token-only.
- `docs/diagnostics.md`: add `price.*` and `analysis.*` codes.
- `docs/plans/phase-3-analysis.md` (this file): status and exit record.
- `docs/project.md`: Phase 3 status line.

Exit checklist:

- [x] `npm run typecheck`, `npm run build`, and `npm test` are green. (76 tests pass.)
- [x] The 12 existing tests still pass, plus the new Phase 3 tests. (76 total: the 12 Phase 1 tests unchanged; Phase 3 adds 69 across its step suites.)
- [x] `buildEvents` and `buildReport` are pure and clock-free. (Report byte-identity test; projection measured back from last call.)
- [x] Fixture totals are deterministic and exact. (Exact dollar/token assertions across pricing, build, summary, cache, findings suites.)
- [x] Observed totals match SQL on a snapshot. (2026-10-22 exit snapshot: calls 1,563, input 7,478,956, priced output 1,079,026, cache read 102,092,792, write 0, observed $0.759757726 — all exact.)
- [x] `gpt-oss:120b` estimated cost equals observed cost on the snapshot. (654 calls, delta `0`.)
- [x] Unpriced models are listed, never counted as `$0` spend. (None unpriced on local history; fixture coverage in cache/summary suites.)
- [x] Free model ids never resolve to paid cards. (Exact-$0-card-only resolution, `glm-5.3-flash-free` vs paid `glm-5.3-flash`.)
- [x] Every finding has evidence, assumptions, and a calculation. (Enforced by `findingValidationProblems`; detector suite asserts exact text frames.)
- [x] Cache writes of zero are reported as "not recorded", not NaN. (`writesRecorded: false`; hit rate `null` shape.)
- [x] Report JSON is byte-identical across two runs on one dataset. (Snapshot test + `shasum` match on the exit snapshot.)
- [x] No prompt text, tool output, or compaction summary appears in any output. (`--check-privacy` ok on live and snapshot; banned keys incl. `prompt`, `oldString`.)
- [x] The source database and `MUNIN_DIR` are unchanged after a run. (Hash match; fresh state dir stays empty.)
- [x] Docs record the pricing date, the accounting authority, and the deferred rules. (`docs/analysis.md`, `docs/pricing.md`, `docs/reports.md`, ADR-0007, diagnostics rows, this section.)

## How to verify by hand

### 1. Make a stable snapshot

The live database changes while OpenCode runs. Every comparison below uses one
snapshot.

```bash
DB="$HOME/.local/share/opencode/opencode.db"
SNAP="/tmp/munin-phase3-snapshot.db"
rm -f "$SNAP"
sqlite3 "$DB" ".backup '$SNAP'"
```

On Windows, use `sqlite3.exe` with the same `.backup` command, or copy
`opencode.db`, `-wal`, and `-shm` while OpenCode is closed.

### 2. Totals against SQL

```bash
npm run analyze -- --db "$SNAP" --totals
```

Compare with:

```bash
sqlite3 "$SNAP" "
  SELECT count(*),
         sum(cast(json_extract(data,'\$.tokens.input') as integer)),
         sum(cast(json_extract(data,'\$.tokens.output') as integer)),
         sum(cast(json_extract(data,'\$.tokens.reasoning') as integer)),
         sum(cast(json_extract(data,'\$.tokens.cache.read') as integer)),
         sum(cast(json_extract(data,'\$.tokens.cache.write') as integer)),
         sum(cast(json_extract(data,'\$.cost') as real))
  FROM session_message
  WHERE type IN ('assistant','compaction')
    AND json_extract(data,'\$.tokens') IS NOT NULL;"
```

Expected: calls, input, output, thinking, cache read, cache write, and observed
cost match exactly. The harness's "priced output tokens" equals SQL output plus
thinking; the report must say which number it is showing.

The 16 assistant rows with no `tokens` are failed attempts. They must show under
data health, not in the call count or the cost.

### 3. Model breakdown and the estimate check

```bash
npm run analyze -- --db "$SNAP" --models
```

Expected on the 2026-10-22 snapshot:

| Model                               | Calls | Observed    | Estimated   | Note               |
| ----------------------------------- | ----- | ----------- | ----------- | ------------------ |
| `ollama-cloud/gpt-oss:120b`         | 654   | 0.759757726 | 0.759757726 | delta `0`          |
| `opencode/deepseek-v4.1-flash-free` | 542   | 0           | 0           | explicit `$0` card |

Three one-off calls (`ollama-cloud/glm-5.3-flash`, `ollama-cloud/kimi-k3`,
`opencode/glm-5.3-flash-free`) have no usage and must appear under failed
attempts, not in this table.

The exact counts drift with the live database. The important invariant is the
`gpt-oss:120b` delta of `0`. It proves input, cache read, output, and the rate
card all line up. If it is nonzero, stop and check the token mapping before
trusting any other figure.

### 4. One session, end to end

Pick the largest session from `--sessions`, then:

```bash
npm run analyze -- --db "$SNAP" --session <session-id>
npm run analyze -- --db "$SNAP" --session <session-id> --json
```

Compare calls, tokens, and observed cost with:

```bash
sqlite3 "$SNAP" "
  SELECT count(*),
         sum(cast(json_extract(data,'\$.tokens.input') as integer)),
         sum(cast(json_extract(data,'\$.tokens.output') as integer)) + sum(cast(json_extract(data,'\$.tokens.reasoning') as integer)),
         sum(cast(json_extract(data,'\$.cost') as real))
  FROM session_message
  WHERE session_id = '<session-id>'
    AND type IN ('assistant','compaction')
    AND json_extract(data,'\$.tokens') IS NOT NULL;"
```

Expected: identical. A subagent session must be marked as such and must not be
added into its parent's totals.

### 5. Cache

```bash
npm run analyze -- --db "$SNAP" --cache
```

Compare:

```bash
sqlite3 "$SNAP" "
  SELECT sum(cast(json_extract(data,'\$.tokens.cache.read') as integer)),
         sum(cast(json_extract(data,'\$.tokens.cache.write') as integer))
  FROM session_message
  WHERE type IN ('assistant','compaction')
    AND json_extract(data,'\$.tokens') IS NOT NULL;"
```

Expected: read total matches; write is `0`; the harness prints "no cache writes
recorded" rather than a NaN hit rate. On the local history the read share of the
input side is about 92%, which is plausible for long agent sessions, but the
snapshot is the authority.

### 6. Recompute one finding by hand

```bash
npm run analyze -- --db "$SNAP" --findings --json > /tmp/munin-findings.json
```

Pick a `repeat-tool-calls` finding. Read:

- `savings.calculation`;
- `savings.assumptions`;
- `savings.tokensWasted`;
- `affected.sampleEventIds`;
- `claimByEvent` (or `claims` in the report).

Open one affected event with `--session <id> --json`, find the duplicate tool
signature, and recompute:

```text
result tokens = resultChars / 4
usd = result tokens * input rate * (write multiplier + remaining calls * read multiplier) / 1e6
```

Expected: the recomputed dollars match the finding. If the model has no card,
the finding must have `unpriced: true`, `windowUsd: 0`, and a nonzero
`tokensWasted`. That is a pass, not a failure.

For `repeated-context`, the check is:

```text
usd = uncached input on the recurring prefix * input rate * (1 - read multiplier) / 1e6
```

### 7. Determinism

```bash
npm run analyze -- --db "$SNAP" --report --json > /tmp/report-a.json
npm run analyze -- --db "$SNAP" --report --json > /tmp/report-b.json
shasum -a 256 /tmp/report-a.json /tmp/report-b.json
```

Expected: the two hashes are identical. On Windows use `Get-FileHash`. If the
hashes differ, a clock, locale, Map iteration order, or unstable sort leaked in.

### 8. Privacy and no writes

```bash
npm run analyze -- --db "$SNAP" --check-privacy
```

The check fails on banned keys such as `text`, `summary`, `content`, `state`,
`output`, `prompt`, and `oldString`. Titles, paths, hashes, and counts are
allowed. Add one value-level sentence: an edit's old text must never appear in
the serialised output, only its hash in the `Edit:` signature.

No-write proof:

```bash
before=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
npm run analyze -- --db "$SNAP" --report >/dev/null
after=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
test "$before" = "$after" && echo "database unchanged"
```

State directory proof:

```bash
MUNIN_DIR=$(mktemp -d) npm run analyze -- --db "$SNAP" --totals
ls -A "$MUNIN_DIR"   # must print nothing
```

Phase 3 does not write the ledger. If this fails, something is writing state too
early.

### 9. Fixtures for the cases real data cannot prove

The live history has no paid Anthropic traffic, no cache writes, and no priced
reasoning traffic. Use the tests for those:

```bash
node --test tests/unit/pricing.test.mjs
node --test tests/unit/build-events.test.mjs
node --test tests/unit/findings.test.mjs
node --test tests/unit/repeat-tool-calls.test.mjs
node --test tests/unit/repeated-context.test.mjs
```

Read the assertions: they should contain exact dollar and token figures, a dated
card change, a long-context band, an observed-zero case, an unpriced case, and a
free-id case. A test that only asserts "greater than zero" is not enough for this
phase.

## Expected snapshot values (2026-10-22)

These are a reference, not constants. Re-snapshot and recompute before an exit
review.

| Figure                    | Value        |
| ------------------------- | ------------ |
| sessions                  | 22           |
| subagent sessions         | 4            |
| usage-bearing model calls | 1,196        |
| failed attempts, no usage | 16           |
| input tokens              | 5,709,686    |
| output tokens (source)    | 433,741      |
| thinking tokens           | 307,293      |
| priced output             | 741,034      |
| cache read tokens         | 65,763,960   |
| cache write tokens        | 0            |
| observed cost             | $0.759757726 |
| `gpt-oss:120b` calls      | 654          |
| `gpt-oss:120b` observed   | $0.759757726 |
| `gpt-oss:120b` estimated  | $0.759757726 |
| aggregate drift sessions  | 10           |

The exact match on `gpt-oss:120b` is the acceptance signal for the pricing and
token mapping. Everything else is explanatory.

## Out of scope for this plan

- The other 15 optimization rules, recommendations, apply/undo, and replay.
- Product CLI commands and terminal report formatting.
- The ledger, incremental scans, live monitoring, and snapshots.
- The dashboard.
- Claude Code, Codex, Gemini, import, and image readers.
- Path canonicalisation for project identity.
- Any claim of semantic equivalence between models or prompts.
- Inferring a per-token rate from an observed total.

## Risks and mitigations

- **Pricing accuracy.** Most cards are ported from the reference's 2026-10-19
  lists; only the Ollama cards were re-verified. Mitigation: record the date and
  source in `docs/pricing.md`, keep unpriced models visible, and never invent a
  rate.
- **Free/paid prefix collision.** A `-free` id can start with a paid id.
  Mitigation: explicit `$0` cards, a free guard, longest-match resolution, and a
  regression test.
- **Output and reasoning semantics.** Getting this wrong inflates or deflates
  every output cost. Mitigation: define priced output as source output plus
  thinking, assert it in a fixture, and prove it against the real Ollama total.
- **Failed attempts.** Counting them as free calls would understate the average
  cost and hide quota errors. Mitigation: separate `CallAttempt` from
  `UsageEvent`, and report failed attempts in data health.
- **Live database drift.** Every manual comparison can disagree if the database
  changes between commands. Mitigation: snapshot first, and label reference
  values with their date.
- **Tool signature drift.** A wrong field name collapses many tools into one
  signature. Mitigation: Step 0 fixes and tests both spellings.
- **Savings on unpriced traffic.** A zero-dollar finding could be read as "this
  is free". Mitigation: `unpriced: true` and `tokensWasted`, never a silent
  zero.
- **Cache write split.** Phase 2 stores one cache-write aggregate. Phase 3
  treats it as the 5-minute TTL, which understates the 1-hour price. Mitigation:
  document it; add the split when the reader can recover it.
- **Determinism.** Clock reads, locale formatting, and Map iteration can leak
  into the report. Mitigation: no `Date.now()` in core, explicit sorts, and a
  two-run hash check.
- **Scope creep into Phase 4.** The detector list is the likely leak.
  Mitigation: only two detectors ship here; the rest wait for the rule registry.

## Minimum cut if time runs short

Ship Steps 1, 2, 3, 6, and 8 with a minimal report from Step 7. Keep the cache
numbers but do not build per-day cache charts. Defer `repeated-context` only if
the prefix data is not stable. Do not defer the observed-versus-estimated split,
the unpriced list, or the finding calculation: those are the phase's exit
criterion.
