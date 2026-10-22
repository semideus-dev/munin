# Phase 4 plan: optimization rules and actionable recommendations

Status: planned
Owner: team
Scope: turn the two Phase 3 detectors into a named rule engine with rule
metadata and confidence conventions, add the recommendation layer with
persisted decision state, the verification-state resolver with `--accept-risk`,
and the apply/undo seam over Munin's own configuration, with replay as
abstractions plus tests using fake drivers (no live API replay). No CLI
product commands, ledger, live monitoring, or dashboard: those are Phases
5-7.
Estimated effort: 12 to 16 hours

## Goal

The reference engine's rule layer is four stacked pieces, all in
`packages/core` and kept pure (no `fs`, no `process.env`; hosts inject
stores — `AGENTS.md` and the store interfaces guarantee it):

1. **Rules** (`analyze/rules.ts`): a registry of named detector functions.
   Each rule is a pure function from a shared `Ctx` to at most one finding;
   findings carry evidence class (`measured` / `inferred` / `estimated`),
   a `confidenceOf()` derivation (measured-ness, sample size, token-profile
   stability), tier (`fix` / `try` / `test`), and `claimByEvent` so
   overlapping findings can be combined per call instead of summed.
2. **Recommendations** (`recommend/recommendations.ts`): findings become
   recommendations with an imperative action line, a rationale in the
   user's own traffic terms, an allowed-action list (`view-affected`,
   `simulate`, `verify`, `apply`), and decision state (`viewed` /
   `applied` / `done` / `dismissed`) persisted through the injected
   `DecisionStore`.
3. **Verification** (`verify/state.ts`): `verificationModeOf()` decides
   how a finding's quality question can be settled (`not-required` /
   `replay` / `manual` from risk and candidate kind), and
   `resolveVerification()` is the one pure answer `verify` writes and
   `apply` reads: `canApply` is true only for `not_required`, a `passed`
   replay, or a recorded user risk acceptance. Nothing else applies,
   including failed or inconclusive replays.
4. **Apply/undo** (core `recommend/actions.ts` + local `changes.ts` /
   `overrides.ts`): `accept()` tries host-injected rewriters, falls back to
   `queued` with the next command, records changes in a changes manifest,
   and undo restores prior values (for the reference: `removeOverrides`
   plus the previous value captured for config levers). Apply never edits
   the user's code.

Munin must reproduce these four pieces on its Phase 3 contracts, minus
every Claude-specific rewriter (the Claude Code mod, statusline, and guard
apply targets are excluded per Phase 0; `statuslineOn` / `guardOn` in the
reference's `apply` command have no Munin counterpart).

## Current situation (2026-10-22)

### What Phase 3 produced

- The finding contract
  (`packages/core/src/analyze/findings.ts` + `domain/finding.ts`):
  `FindingDraft` validation (`findingValidationProblems`), `buildFinding`
  producing findings with calculation, assumptions, `claimByEvent`, tier,
  confidence, and verification mode, plus the de-overlap functions
  `recoverableByEvent` / `recoverableWindow`.
- A detector registry (`analyze/findings/index.ts`) with two detectors:
  `repeat-tool-calls` and `repeated-context`, each with hand-computed
  explanations.
- A structured report (`report/report.ts`) with totals, model/project
  summaries, findings, and `dataHealth`, pinned by a snapshot test.
- The `npm run analyze --` harness over the real local database, read-only.

### What the reference repo has and Munin does not

- `analyze/rules.ts` (2187 lines): 17 named rules in `RULES`
  (`pricing-change`, `cost-spike`, `spend-concentration`, `cache-churn`,
  `repeated-context`, `prompt-bloat`, `repeat-tool-calls`, `model-fit`,
  `reasoning-effort`, `oversized-input`, `oversized-output`,
  `oversized-tool-output`, `error-loops`, `cold-resume`, `heavy-start`,
  `context-compaction`, `model-default`), shared `Ctx`, `confidenceOf()`,
  and the overlap/savings machinery (`savingsOverlap`, `recoverable*`).
- `recommend/recommendations.ts`: decision state and `DecisionStore`.
- `recommend/actions.ts`: `ProposedChange`, `Traffic`, `RequestRewriter`,
  `ApplyOutcome`, `accept()`.
- `verify/state.ts`: `resolveVerification()`, `acceptRisk()`,
  `VerificationStore`.
- `packages/local`: changes manifest (`recordChange`, `recordUndo`,
  `openChanges`), model overrides (`ModelOverride`, `removeOverrides`),
  sample capture, and the `wrap()` rewriter host.

### Phase 3 gaps that Phase 4 must close first

1. **Rules are unnamed detectors.** Two detectors exist, selected by
   `DETECTORS` order, with no per-rule metadata (description, category,
   rationale/action line), so neither recommendations nor a future CLI can
   address a rule by id the way the reference does (`f.rule` drives
   `apply`/`why`).
2. **No recommendation layer.** Findings are terminal: no decision state,
   no action list, no rationale, no simulation.
3. **No verification resolver or store seam.** Phase 3's engine writes no
   state by design; Phase 4 introduces the injected store pattern
   (`DecisionStore`, `VerificationStore`), with the file-backed
   implementation living in the harness script (the eventual host), not in
   core.
4. **2 of ~17 rules.** The remaining reference rules are ported onto the
   existing `FindingDraft` contract; none is invented.

## Scope decisions

- **Port rule semantics from the reference**, including `confidenceOf()`
  mechanics, window figure vs monthly/annual projection separation, and
  the overlap accounting. Do not redesign the finding shape: Phase 3
  already ported it.
- **Keep finding vs applying separate**, as the project plan instructs:
  the detection pipeline stays the Phase 3 one; recommendation, decision
  state, and apply/undo are new modules that consume findings.
- **Rules must support exact ids and addressed operations from the
  start**, so recommendation and apply can speak `f.rule` the way the
  reference does.
- **The apply seam covers Munin's own configuration only** (the Phase 1
  config surface), plus state-ledger records of what was applied.
  - No agent-authorization surfaces, no `.claude`-anything, no
    statusline/guard equivalents, and no direct rewrites of OpenCode's
    own database. The reference's rewriters exist for Claude Code and
    SDK apps; without a hosted integration there is nothing safe to
    write, so all OpenCode-targeted changes surface as `queued` with the
    manual command, matching how the reference treats a finding with no
    installed integration.
  - Application failures are errors with causes, never silent skips.
- **Undo is restore-last-apply**, session-independent: the apply manifest
  captures the full previous value of every key touched, undo replaces it
  back, and both land in the state dir's changes manifest (Phase 5 turns
  this into the real ledger).
- **Replay stays abstract in this phase**: `VerificationRecord` and the
  `resolveVerification()` state machine are ported and tested with fake
  drivers, and the harness records red/green; no live model calls.
- **Rule-specific tests come from the reference's own dataset
  conventions**: each ported rule is pinned by a small hand-built dataset
  fixture in the same way the reference tests rules
  ("a bug fix needs a regression test that fails without the fix").

## Data flow

```text
Dataset + analysis scope defaults
        |
        v
evaluators (rule registry; confidence rules) --> findings, overlap checks
        |
        v
recommendations (dedupe, order, count of unattributed, per-rule action lines)
        |
        v
recommendation state (DecisionStore) -----> expected next actions
        |
        v
apply seam (trust gate, config store injection, snapshot, write)
        |                    |
        v                    v
   changed config         undo record
```

- Rules consume the snapshot; nothing in the analysis layer reads local
  disk or env.
- Recommendations sort by recoverable claim window, tie-break by rule
  confidence then rule id, and record when findings were cut from the
  list.
- Apply touches only Munin's own config keys, records touched keys and
  previous values in a changes manifest under the state dir, and never
  writes to OpenCode's own database.

## Deliverables

| Deliverable                                        | Where                                     | Proof                                    |
| -------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Named rule registry with metadata                  | `core/analyze/rules.ts`                   | `tests/unit/rules.test.mjs`              |
| Ported reference rules beyond the Phase 3 pair     | `core/analyze/rules/`                     | `tests/unit/rules.test.mjs`              |
| Confidence and `EvidenceClass` conventions         | `core/analyze/rules/confidence.ts`        | `tests/unit/rules.test.mjs`              |
| Overlap accounting for composed findings           | `core/analyze/findings.ts` (extends)      | `tests/unit/overlap.test.mjs`            |
| Recommendation generation with decision state      | `core/analyze/recommend.ts`               | `tests/unit/recommend.test.mjs`          |
| Verification-state resolver and `--accept-risk`    | `core/analyze/verification.ts`            | `tests/unit/verification.test.mjs`       |
| Config-store seam, apply flow, denied surfaces     | `core/analyze/rules/apply.ts`             | `tests/unit/apply.test.mjs`              |
| Undo restore from the manifest                     | `core/analyze/rules/apply.ts` (undo path) | `tests/unit/apply-undo.test.mjs`         |
| Replay abstractions + fake-driver tests            | `core/analyze/verification.ts` (replay kinds) | `tests/unit/replay.test.mjs`         |
| Snapshot-shape regression fixtures                 | `tests/fixtures/rules/`                   | all rules-*.test.mjs                     |
| Harness for rules, recommendations, apply, undo    | `scripts/rules-local.mjs`                 | manual runs in "How to verify by hand"   |

## Steps

### Step 0: Verify the Phase 3 baseline still holds (45 min)

1. Re-run the Phase 3 exit snapshot: `npm test` plus
   `npm run analyze --` against a stable snapshot of the phase-3 exit
   database. Confirm the totals from the Phase 3 exit record still match
   to the last digit.
2. Read `analyze/findings/index.ts` and record everything that consumes
   `DETECTORS` order, so replacing it with the named registry does not
   silently re-order report findings.
3. Note the finding-shape fields the report already renders
   (`findings.ts` in `report/`), so recommendation fields render without
   report rework.

Manual check: `npm test` stays green and the snapshot reconcile run
reports the same totals as Phase 3's exit record (see
`docs/plans/phase-3-analysis.md`, exit snapshot section).

### Step 1: Named rule registry (1.5 h)

1. Create `core/analyze/rules.ts` with one entry per rule, starting from
   the two Phase 3 detectors (`repeat-tool-calls`, `repeated-context`),
   and register rules as they get ported in Step 2:
   - stable string rule ids (no enums) for cross-snapshot matching,
   - `description`, `rationale` (the reference's `rationaleFor`
     vocabulary, kept as data not code),
   - `action` (the imperative one-liner),
   - `category` (model-selection, context-bloat, caching, retries, ...),
   - `tier` (`fix` / `try` / `test`),
   - `verificationMode` (`not-required` / `replay` / `manual`),
   - a `claudeSafe` note: "Yes" means the reference rule never touches a
     Claude-specific surface in its implementation. "No" rules are not
     ported, and their absence is documented instead.
2. Keep findings.ts, `buildEvents`, `summarize`, and the report exactly
   as Phase 3 produced them; the registry replaces only the detector
   selection point.
3. Preserve `findings` ordering semantics in the report: the report lists
   findings sorted by rule id, not by registry insertion order, and the
   test pins this in both orders to prove the sort is not accidental.

Manual check: `npm run build && node --test tests/unit/rules.test.mjs`
shows the registry returning definitions with every field filled.
Cross-check by hand that each entry's rule id exists in the reference
repo's RULES list and that `claudeSafe` is accurate (read the reference
rule body: `sed -n` the rule function in `optimaizr/packages/core/src/
analyze/rules.ts`).

### Step 2: Port remaining reusable rules (3 h)

Port rules in this order (highest verification confidence first, most
risky last), checking each one's semantics against the reference:

1. `cache-churn` — already computed by the Phase 3 cache analysis;
   becomes a rule with its own evidence and claim window.
2. `prompt-bloat` — system prompt churn per session, ported against V2
   `session_message` payloads.
3. `oversized-input`, `oversized-output`, `oversized-tool-output` —
   straightforward size-threshold rules; port thresholds and rationale
   lines verbatim from the reference.
4. `error-loops` — identical failing calls retried; needs only per-call
   success/failure facts already in the Phase 3 event model.
5. `oversized-input`'s sibling `spend-concentration` — spends by
   project/session skew.
6. `reasoning-effort` — needs the `dataHealth` audit that reasoning
   tokens are priced, never double-counted (Phase 3's ADR-0007).
7. `model-fit`, `model-default` — the "agent capability exceeds
   workload" rule; port only the OpenCode evidence (subagent facts
   already present), no Claude-specific capability metadata.
8. `cost-spike`, `pricing-change` — skew and price-step detection on
   observed charges.
9. `context-compaction`, `cold-resume`, `heavy-start` — the levers that
   drive the apply seam: these are the rules a user can act on directly.

Rules that only ever forked on Claude-specific surfaces stay unported
with a note in `docs/rules-unsupported.md`. Do not invent a non-Claude
"equivalent" for them this phase.

Manual check: for each freshly ported rule, run `npm run analyze --` on
the Phase 3 exit snapshot before and after. The rule either produces its
reference-shaped finding on this real data, or its absence is explainable
("no qualifying traffic in this window"). Run
`node --test tests/unit/rules.test.mjs` and the new per-rule test.

### Step 3: Confidence conventions, overlap accounting (1.5 h)

1. Port `confidenceOf()` exactly: measured-ness, sample-size thresholds
   (`SAMPLE_THIN` = 10, `SAMPLE_SOLID` = 50), token-profile stability.
2. Rule findings carry `claimByEvent`, and the de-overlap functions
   (Phase 3 already has them) must swing both ways, i.e.
   `recoverableWindow` after a composed evaluation equals the manual sum
   minus overlapped claims, for the test fixture.
3. Re-use the Phase 3 report's findings block unchanged (rule id, tier,
   confidence, claim), adding a per-rule overlap note only when two rules
   contend for the same call (`savingsOverlap`-style output).

Manual check: compose two overlapping rules on an overlapping dataset
fixture; confirm the de-overlapped total, not the naive sum, and the
"contention" note rendered in the report findings block.

### Step 4: Recommendation generation and decision state (2 h)

1. `core/analyze/recommend.ts` produces recommendations from findings:
   - `rule`, `action` (imperative one-liner), `rationale` (traffic-based
     sentence, from the rule's `rationale` template),
   - `confidence` and `tier` inherited from the finding,
   - allowed actions list (`view-affected`, `simulate`, `verify`,
     `apply`),
   - sorted by recoverable claim window, tie-break by confidence, then
     rule id.
2. Persisted decision state (`DecisionStore` interface, ported from the
   reference's `recommendations.ts`): statuses `viewed` /
   `applied` / `done` / `dismissed` are remembered between runs; the
   store is injected by the caller. The file-backed store lives in the
   harness script (the eventual host); core defines only the interface.
3. The report recommendations block renders decision state next to
   findings ("viewed 2026-10-22", etc).

Manual check: run the analyze harness twice on an unchanged snapshot. The
recommendation block is byte-identical (same order, same rationale text).
Set a decision via the harness (`--decide done`), re-run, and the
decision state renders in the report list.

### Step 5: Verification resolver (1 h)

1. Port `verificationModeOf()` and `resolveVerification()` verbatim (the
   reference is pure; nothing to adapt).
2. Port `acceptRisk()`: recording a manual verification is the only
   way a `manual` mode finding gets to apply.
3. The harness gets a `--verify-state` flag printing per-rule resolution
   (state, mode, `canApply`, headline, guidance), and `--accept-risk
   <rule>` to write the record. Both write to the harness's state dir.

Manual check: for each of the three verification modes, take a rule of
that mode and run the harness `--verify-state`:

- a `not-required` rule resolves straight to `canApply: true`,
- a `manual` rule resolves to `unverified` / no apply until
  `--accept-risk`, then `canApply: true`,
- a `replay` rule with no verification record stays `unverified` (there
  is no replay runner yet in this phase).

### Step 6: Apply seam (2 h)

1. `core/analyze/rules/apply.ts` takes a finding, a `ConfigStore`
   interface (injected, like `DecisionStore`), and the verification
   resolver's answer, and either:
   - **applies**: for rules that map to Munin's own configuration keys.
     Only rules whose change is Munin-controlled (e.g. the `external`
     reorder of its `analysisDefaults`) qualify in this phase.
   - **queues**: for every OpenCode-targeted change there is no intended
     writer for yet (no hosted integration): result is `queued` with the
     next command and reason, copied from the reference vocabulary
     (`not_required`, `manual`, `replay`, plus "no pre-request
     integration is installed, so nothing was changed").
   - **fails**: with a cause, never a silent skip, if a key write fails
     or the store refuses.
2. Before any apply:
   - refuse on a snapshot whose reconciliation has an open mismatch or
     whose `dataHealth.clean` is false (the reference never writes on
     data it doubted),
   - record the full previous value of every config key touched (a
     snapshot, not a diff) into the changes manifest in the state dir,
   - record timestamp, rule id, keys touched.
3. Apply runs only after user confirmation; the library returns the
   outcome and the harness (or later the CLI) owns the prompt. `--dry-run`
   must not write anything, matching the reference's accept() ordering
   (the dry-run check precedes any rewriter/store interaction).

Manual check: in a scratch state dir, run a scripted apply against a fake
config store; confirm the manifest captured the previous bytes, rule id
and timestamp; confirm the store received exactly the key-value pair the
rule declares (no extras); confirm a `queued` OpenCode-targeted
recommendation printed the `next` command and wrote nothing; confirm a
dirty-snapshot apply refused with the reconciliation reason and no write.

### Step 7: Undo (1.5 h)

1. `apply.ts` undo path reads the manifest entries and restores the
   previous snapshots in reverse apply order within the session.
2. After a restore, the config content must byte-match the manifest's
   previous value; a mixed/partial restore aborts and reports the
   remaining pending entries.
3. Undo records in the manifest the restored-at timestamp and the keys
   restored. Cross-session undo chains stay out of scope.

Manual check: apply, mutate the config by hand, undo; the config returns
to the manifest's previous content (byte-equal, not merely semantically
equal). Apply two rules, undo both: restores run in reverse order and the
second restore leaves the state the first one expects.

### Step 8: Replay abstractions (2 h)

1. Two replay interfaces, ported conceptually from the reference (the
   live API replay stays out of scope):
   - **token replay**: recompute token counts for a finding's evidence
     spans from the events, then re-apply the finding. The finding's
     claim window must equal the recomputation, else the finding is
     stale and the replay returns a difference report.
   - **plan replay**: for rules whose fix changes disposition rather
     than tokens (e.g. `context-compaction`), a minimal, mocked plan
     executor that runs the finding against a canned dataset slice.
2. Both interfaces return a verdict object: refreshed claim window,
   re-estimated confidence, and a one-line reason; the result feeds
   `recordVerification()` with state `passed` / `failed` /
   `inconclusive` exactly like the reference's mapping.
3. Registry metadata declares which replay kind each rule needs; the
   report/deeper tooling reads it from metadata, not a special case.
4. Constraining test: no replay driver calls the network in this phase,
   proven with a fake `fetch` that records any attempt and fails the
   test when touched.

Manual check: a finding with a stale claim window (fixture updated in the
wrong direction) fails token replay with a difference report; a plan
replay over a canned slice never leaves the process; the harness
`--verify-state` output for a recorded replay shows `canApply: true` with
the PASS headline and sample count.

### Step 9: Documentation, report surfacing and exit review (1 h)

1. `docs/rules.md`: registry shape, rule ids, applicability vocabulary,
   verification modes, apply/undo contract, replay kinds, and the
   unsupported-rules list (`docs/rules-unsupported.md`).
2. The analyze harness surfaces rule-level detail: per-rule findings,
   recommendation block, skipped rules (with reasons), verification
   states.
3. Update `docs/plans/README.md` and this file's status once the exit
   checklist is fully green.

Manual check: `npm run analyze --` includes a rule block, a
recommendation block, and no rule in the registry is missing from either
a finding, a recommendation, or a skipped entry with reason.

## How to verify by hand

All commands run from the munin repo root; the snapshot is the same
phase-3 exit database as Phase 3's exit record, so totals reconcile to a
known number.

### 1. Baseline is intact

```bash
npm test
npm run analyze --
```

Both show the Phase 3 exit-record totals, the same exact reconciliation,
and report byte-identical output.

### 2. Registry completeness

```bash
npm run build && node --test tests/unit/rules.test.mjs
```

Every rule entry has every field filled. Cross-check by hand that each
entry's rule id exists in the reference repo's RULES list
(`optimaizr/packages/core/src/analyze/rules.ts`, list at the bottom) and
that `claudeSafe` matches what the reference rule body actually touches.

### 3. Rules fire on real data where the reference would fire

```bash
npm run analyze -- --rules
```

For each newly ported rule, hand-check the Phase 3 exit snapshot:

- if the rule produced a finding, footprint the affected calls,
  confidence, and claim window against the finding's stated calculation
  (same as Phase 3's one-finding recompute check),
- if it produced none, the rule's applicability preconditions
  (thresholds, minimum sample size) must also say none on this window.

### 4. Overlap accounting

Take a fixture with two overlapping rules (for example one finding
claims a call as `repeat-tool-calls` and another also claims it as
`repeated-context`); the composed `recoverableWindow` must equal the
manual sum minus the overlapped claim, and the report shows the
contention note with the pair of rule ids.

### 5. Recommendations are stable and driven from findings

```bash
npm run analyze --          # first run
npm run analyze --          # second run
```

Diff the recommendation blocks: byte-identical. Then run
`npm run analyze -- --decide done <rule>` and re-run; the decision state
renders next to that rule's recommendation, persists across runs, and
changes nothing else in the report.

### 6. Verification states namespace-correct

```bash
npm run analyze -- --verify-state
```

For each rule, the verification state matches its mode:
`not-required` is `canApply: true`, `manual` is
`canApply: false` until `--accept-risk`, `replay` is `canApply: false`
until a replay record exists (not in this phase). Run
`npm run analyze -- --accept-risk <rule>` and confirm the record is
written to the state dir, then `--verify-state` again: the mode is now
`manual` accepted-risk with `canApply: true`.

### 7. Apply writes only what it declared, with a captured prior

All apply runs here are scripted against an injected `ConfigStore` (the
core never touches real config until the CLI wires a prompt in Phase 6).

```bash
node --test tests/unit/apply.test.mjs
```

The test proves: the fake store receives exactly the declared key-value
pairs (no extras); the manifest captures rule id, timestamp, previous
bytes, and touched keys; a `queued` OpenCode-targeted recommendation
prints the `next` command and writes nothing; a dirty-snapshot apply
refuses with the reconciliation reason and no write; a rerun is
idempotent (no duplicate manifest entry). Hand-spot-check the manifest
file in the scratch state dir after the run.

### 8. Undo restores byte-exact, in order

```bash
node --test tests/unit/apply-undo.test.mjs
```

The test pins: after undo, the config content is byte-equal to the
manifest's `previous` value (after the fixture hand-mutated the config in
between, proving restore is from stored bytes, not a recompute); two
applies undone in sequence restore in reverse order and the second
restore leaves the state the first expects. Hand-spot-check the manifest
records the restored-at timestamp and the restored key set.

### 9. Replay abstractions do what they claim

- Token replay: mutate a fixture so the finding's claim window is stale;
  the replay reports a difference and does not return a fresh claim equal
  to the stale one.
- Plan replay: configure a canned dataset slice and run the replay; the
  fake `fetch` stays untouched (any recorded attempt fails the test).

### 10. Nothing new reads or writes OpenCode's history

Apply and undo paths touch `packages/core` state only through injected
stores, and their paths resolve to keys in the user's config and the
Munin state dir, never to OpenCode's own database. Run the phase 3
cleanliness check (`npm run analyze --` leaves the snapshot's mtime and
size unchanged) plus:

```bash
grep -rn "node:fs\|process.env" packages/core/src/analyze
```

which must return nothing (core stays pure; `fs` and env access belong to
the harness script and, later, `packages/local`).

## Out of scope for this plan

- Live API replay and network-based verification.
- Applying to any Claude-specific surface (the reference's
  `statuslineOn`, `guardOn`, Claude mod rewriters): excluded per Phase 0;
  the reference's queued message for "no integration installed"
  documents what Munin does instead.
- Writing OpenCode's own database or its session instructions text via
  apply: nothing in Phase 4 touches OpenCode storage for a change.
- Cross-session undo chains, long-lived config migration.
- The CLI commands (`apply`, `undo`, `verify`); Phase 6 wires them onto
  the library seam. The harness provides the manual paths meanwhile.
- The ledger as a real store; Phase 5 owns it, this phase uses an
  injected interface plus a file in the state dir.

## Risks and mitigations

- **Rule id drift during porting**: every id must match the reference's
  id byte for byte; the registry test asserts it against a hand-recorded
  list from the reference repo's RULES array.
- **Confidence thresholds drift**: `SAMPLE_THIN` / `SAMPLE_SOLID` and the
  measurement-ness wording are ported verbatim with their tests, not
  reworked.
- **Apply seam touching agent-specific surfaces**: the `ConfigStore`
  exposes only Munin's own keys; the core never builds `fs` paths
  (confirmed by the grep check in step 10), and OpenCode-targeted
  recommendations queue instead of write.
- **Replay promising what it cannot measure**: no network in this
  phase's replay, proven by the fetch-recording test; replay kinds come
  from registry metadata, not hand-maintained lists.
- **Overlapping claims double-summing**: Step 3's composition test
  overlaps two rules on purpose and asserts the de-overlapped sum.
- **Recommended ordering instability**: pinned by the byte-identical
  run-to-run test in Step 4.

## Minimum cut if time runs short

1. Registry with the two Phase 3 rules ported cleanly, ids and metadata
   stable, report unchanged.
2. Confidence conventions and overlap accounting with the composed test.
3. Recommendation generation with decision state and the stability test.
4. Verification resolver + `--accept-risk` in the harness, all three
   modes verified by hand.
5. Apply/undo over the injected config-store seam with the manifest and
   byte-exact restore; the trust gate refuses dirty snapshots; queued
   outcomes for OpenCode-targeted rules.

Defer: additional rule ports beyond the Phase 3 pair, the plan-executor
replay kind fleshed out, and the Step 9 doc polish. The rule engine, the
recommendation/verification state machines, and the safe apply/undo seam
are the Phase 4 core claim; more rules and replay execution can land in
Phase 6 wiring and Phase 5 ledger follow-up.
