# Phase 5 plan: local ledger, incremental scanning, live monitoring, snapshots and results comparison

Status: planned (not started)
Owner: team
Scope: turn the batch analyze pipeline into a local runtime: a file-backed
ledger of derived state under the state directory, watermarked incremental
scanning of the OpenCode database, a polling watch loop that discovers new
sessions without a restart, snapshot capture with trend comparison, the
change-driven results comparison ported from the reference, privacy controls
over what the ledger persists, and error recovery for locks, torn records,
missing source and truncation. No CLI product commands and no dashboard:
those are Phases 6-7; the harness scripts are the manual surface in this
phase.
Estimated effort: 12 to 16 hours

## Goal

Phase 5 makes Munin useful during coding, not only for one-time reports.
After this phase a scan maintains local derived state that survives runs, a
new OpenCode session shows up on the next poll without any restart, and the
numbers never change because a scan ran twice.

The runtime pieces mirror the reference's split, adapted to Munin's source
model (the reference instruments SDK traffic into a ledger; Munin reads the
OpenCode database directly and stores *derived* state):

1. **Ledger** (reference `packages/local/src/ledger.ts`): append-only JSONL
   state under the state directory, best-effort from the writer's point of
   view but self-healing at read time. Munin's ledger holds derived records
   only - priced usage events, scan cursors, snapshots, and the Phase 4
   apply journal - never source history and never prompt text.
2. **Incremental scanning** (reference shape in `live.ts` tailOpencode +
   `ingest/opencode.ts` `since` support): both readers gain a persisted
   watermark. A scan reads only sessions whose `time_updated` advanced
   past the watermark, re-reads whole sessions, and replaces their slice of
   derived state. Idempotency comes from stable event ids and
   session-slice replacement, not from arithmetic.
3. **Live monitoring** (reference `live.ts`): polling, never `fs.watch`.
   Each tick stats the source file (cheap), and when it changed runs an
   incremental scan and renders the refreshed report. Cursors persist
   across restarts - a deliberate deviation from the reference, which keeps
   high-water marks in memory only, because Munin's exit criterion
   (discover new sessions without a restart after a *restart*, too) needs
   it.
4. **Snapshots and comparison** (reference `analyze/results.ts` +
   `changes.ts`): each completed scan appends one summary snapshot; two
   snapshots diff into a trend report; applied changes (Phase 4's journal)
   become before/after periods with the reference's verdict vocabulary.

## Current situation (2026-10-23)

### What Phases 1-4 produced

- `packages/local/src/paths.ts` already reserves the state layout:
  `stateDir` (`~/.munin` or `MUNIN_DIR`), `settingsPath` (config.json),
  and the ledger paths `events`, `snapshots`, `changes`, `decisions`,
  `verifications`. `defaultDbPath` resolves via XDG exactly like OpenCode.
- `packages/local/src/readers/`: read-only readers for V1, V2 and mixed
  schemas (`readDataset`), both already preselect sessions with
  `s.time_updated >= :cutoffMs` (bounded by `sinceDays`). `openReadOnly`
  exists; `readInstructions` reads V2 instruction references.
- `packages/core`: Phase 3 engine (`buildEvents`, `summarize`,
  `cacheStats`, `sessionSummaries`, `detectFindings`, `buildReport` with
  reconciliation and `dataHealth.clean`), priced `UsageEvent` domain type
  with stable ids (`source message id`), and Phase 4's rules,
  recommendations, verification, apply/undo manifest and replay
  abstractions. Core stays pure: no `fs`, no `process.env`.
- `packages/local/src/changes.ts`: file-backed append-only apply journal
  (`changes.jsonl`) with load/append only.
- `scripts/analyze-local.mjs`: the batch analyze harness (totals, models,
  sessions, cache, findings, report, events; `--decide`, `--verify-state`,
  `--accept-risk`, `--check-privacy`, read-only against the source DB).
  Batch remains full-window; incremental work must not change its output.
- 105 tests green.

### What the reference repo has and Munin does not

- `packages/local/src/ledger.ts`: `events.jsonl` under `~/.optimaizr`,
  append-only `CallEvent` lines, in-memory queue with 1 s drain and
  exit-drain, `readLedger` that skips unparseable lines with a count.
- `packages/local/src/live.ts` (`tailLedger`, `followFiles`,
  `tailOpencode`, `createLiveSession`): byte-offset polling tails with
  partial-line holding, decoder across reads, truncate/rotate detection
  (`size < offset` → restart at 0); the opencode tail keeps a part-id
  cursor with a 30 s overlap window and an in-memory `seen` set so
  out-of-order commits are not missed and not double-counted
  (`live.ts:425-430`, `532-543`).
- `core/src/analyze/results.ts`: `measureResults()` - each applied change
  splits usage at its timestamp; baseline min 14 / max 30 days
  (`BASELINE_MIN_DAYS/BASELINE_MAX_DAYS`); `ResultRow` per key with
  `before`/`after`/`better`/`tradeOff`/`worse`; verdicts
  `too-early | no-baseline | working | no-change | worse`; a
  baseline-sensitivity range. `apps/cli/src/data.ts` computes
  `resultsDays` so a results run reads back only as far as needed.
- `packages/local/src/changes.ts` (reference): apply/record/undo journal
  with period construction (`changesFrom`, `AppliedChange`) and
  60-second `sameEntry` dedup against secondary sources.
- Privacy posture (`apps/cli/src/commands/info.ts:125-190`,
  `samples.ts`, `jev.ts`): only model, timestamps, counts, cost, latency,
  tool names, truncated tool inputs and a one-way prefix hash are ever
  stored; capture defaults off; nothing leaves the machine unless the
  user turns the optional judge on. Munin has no samples/jev machinery at
  all - its scan harness already refuses to serialize prompt-bearing keys
  (`BANNED_KEYS`, `ALLOWED_OUTPUT_PATHS` in `scripts/analyze-local.mjs`).
- Error recovery patterns: reader-side torn-line tolerance, tmp+rename
  atomic writes (`overrides.ts`, `guard.ts` marks), fail-closed state
  stores (`verifications.ts`: "an unreadable store means nothing is
  verified"), a locked/replaced SQLite handle re-opened on the next poll
  (`live.ts:539-542`), and no lock files (the reference tolerates a torn
  line instead).

## Scope decisions

- **The ledger stores derived state only.** One `events.jsonl` line per
  *session slice*: the priced `UsageEvent[]` for that session as captured
  at scan time, with the scan's watermark and schema mix. This deviates
  from the reference (one event per line, fed live) because Munin's source
  is read from SQLite; the invariant that matters is preserved - stable
  event ids make re-reading harmless - and `snapshots.jsonl` accumulates
  one summary per completed scan. Raw prompts are never persisted: the
  same `BANNED_KEYS` rule that screens analyze output becomes a
  serialization-time validation error, not a silent strip.
- **Watermarks per schema, session granularity.** Both readers keep their
  `time_updated >= cutoff` preselect, fed from `cursors.json` instead of
  `sinceDays`. The watermark advances only after a scan commits its
  slices and snapshot. A 30-second re-read overlap below the watermark
  ports the reference's overlap-window idea to session granularity: a
  session re-read because of the overlap replaces its slice instead of
  adding a second copy. `--full` ignores cursors.
- **Incremental math replaces, never sums.** A re-read session's slice
  replaces the previous one (last slice per session id wins at read
  time), so a resumed or edited session is re-priced from scratch. This
  is the whole idempotency story; there is no incremental *arithmetic* to
  get wrong.
- **One report builder path.** The ledger rebuild (`buildLedgerReport`)
  reuses the Phase 3 aggregation, cache, session and detector pieces on
  merged events - it must not fork the math. Source reconciliation is a
  batch concept; ledger reports carry their own dataHealth
  (skipped/journal state) instead of SQLite reconciliation. The pin:
  for the same window, ledger-rebuild totals equal batch totals to the
  last digit (tested on fixtures and one real snapshot).
- **Pricing is captured at scan time, not re-derived.** Ledger slices
  store the dated-cost calculations as computed. A `--full` scan re-prices
  from the registry; the reconcile step compares fresh vs stored totals
  and reports drift (e.g. registry editions changed) instead of silently
  mixing regimes.
- **Live monitoring is polling at session level**, not streaming: cheap
  stat tick, incremental query only when the source changed, single-flight
  guard, truncate/replace → automatic full rescan, locked/unreadable DB →
  keep the last good state with a warning and retry next tick. No
  `fs.watch`.
- **Results comparison is ported faithfully but starts honest**: Munin's
  journal currently has no real applies (no rule maps to a Munin-owned
  setting), so the port is driven by fixtures and the empty journal
  produces an explicit "no applied changes on record" verdict rather than
  a fabricated comparison.
- **Privacy is a checkable property.** The scan exposes the same
  `--check-privacy` gate over everything it writes (slices, snapshots,
  cursor names); `docs/ledger.md` lists every file under the state dir
  with a one-line "what is in this file" description, mirroring the
  reference's `info` privacy listing. Retention: everything until
  `rm -rf` of the state dir.
- **Error recovery follows the reference patterns**: abundant
  skip-and-count at read, tmp+rename for whole-file state (`cursors.json`,
  `snapshots` compaction later), fail-closed gates, a single-writer scan
  lock with pid+staleness detection (the one addition beyond the
  reference, needed because watch + an interactive scan could otherwise
  interleave writes to the journal).

## Data flow

```text
OpenCode source db (read-only, never written)
        |
        v
incremental reads (watermark cursors, whole-session reads)
        |
        v
buildEvents  -->  UsageEvents for re-read sessions  -->  events.jsonl slices
        |                                                   (upsert by session id)
        v                                                   |
merged events = ledger slices + fresh full-scan events       |
        |                                                    |
        v                                                    v
buildLedgerReport (Phase 3 engines reused)                snapshots.jsonl
        |                                                 (one summary per scan)
        v
refreshed report on stdout; trends = diffSnapshots(prev, current)
results comparison = changes.jsonl -> measureResults (ported)
```

- The source database is opened read-only in every path; a scan never
  writes to it. Cursors advance only after slices + snapshot commit.
- The watch loop owns the same pipeline as a one-shot scan; there is no
  separate live engine.
- Batch `npm run analyze --` keeps its Phase 3 semantics byte-for-byte;
  the incremental path lives in `npm run scan --`.

## Deliverables

| Deliverable | Where | Proof |
| ----------------------------------------------- | ----------------------------------------- | ---------------------------- |
| Snapshot / cursor / slice contracts + validation | `core/src/domain/ledger.ts`, `core/src/ledger/*.ts` | `tests/unit/ledger-schemas.test.mjs` |
| Priced-event slice serialization + privacy gate | `core/src/ledger/slices.ts` | `tests/unit/ledger-slices.test.mjs` |
| Watermark cursors (atomic read/write, freshness rule) | `packages/local/src/cursors.ts` | `tests/unit/cursors-local.test.mjs` |
| Incremental V1 / V2 / mixed reads on watermark | `packages/local/src/readers/*` (extended) | `tests/unit/readers-incremental.test.mjs` |
| Append-only slice journal + dedup at read + torn-line tolerance | `packages/local/src/ledger.ts` | `tests/unit/ledger-local.test.mjs` |
| Ledger report rebuild on merged events | `core/src/report/ledger-report.ts` | `tests/unit/ledger-report.test.mjs` + equivalence pin |
| Scan orchestration, snapshot append, reconcile, repair | `scripts/scan-local.mjs` (+ pure pipeline in core/local) | `npm run scan --` |
| Watch loop without restart | `scripts/scan-local.mjs --watch` | manual check below |
| Trend comparison of two snapshots | `core/src/analyze/snapshot-diff.ts` | `tests/unit/snapshot-diff.test.mjs` |
| Results comparison port (verdicts, baselines, days) | `core/src/analyze/results.ts` | `tests/unit/results.test.mjs` |
| Privacy controls over ledger writes | scan harness + `docs/ledger.md` | `npm run scan -- --check-privacy` |
| Error recovery: lock, torn lines, missing DB, truncation | `core` + `local` (tested) | `tests/unit/scan-errors.test.mjs` |
| Documentation + exit review | `docs/ledger.md`, plans README, project.md | exit checklist |

## Steps

### Step 0: Phase 4 exit record and baseline intact (45 min)

1. Record the Phase 4 close: exit audit recorded as done on 2026-10-23 in
   `docs/plans/phase-4-rules.md`, `docs/plans/README.md` and
   `docs/project.md` (done at planning time for this phase).
2. Re-verify the Phase 4 baseline: `npm test` (105/105) and
   `npm run analyze -- --report --json` produce byte-identical output
   across two runs on a copied snapshot DB, with the file's mtime and
   size unchanged after both.
3. Inventory the consumers of `readDataset` options (`sinceDays`,
   `limit`, `offset`) so adding a watermark option cannot silently change
   batch behavior; record them here.

Manual check: tests green, the two `analyze` runs differ in nothing, the
snapshot DB file mtime/size unchanged. The inventory list appears in this
file's execution notes.

### Step 1: Ledger contracts, snapshot schema, slice serialization (2 h)

1. `core/src/domain/ledger.ts`: types for
   - `SessionSlice` (`schema: "munin.slice/1"`): `sessionId`, `at`,
     `watermarkMs`, `events: UsageEvent[]`,
   - `Snapshot` (`schema: "munin.snapshot/1"`): metadata (id, `at`,
     source path + origin), scope (`full`/`incremental`, sessions read,
     slices replaced), state counters (sessions/events tracked), window,
     compact totals and per-model rows, compact findings list
     (rule/count/claimed window), `dataClean`, warning counts.
   - `SnapshotDiff`, `ScanCursor` shapes.
2. `core/src/ledger/slices.ts`: serialize/deserialize events with
   validation (fail-closed: wrong or prompt-bearing keys are errors, and
   the BANNED_KEYS vocabulary moves from the harness script into core so
   every future host inherits it). Anything outside the allow-list of a
   `UsageEvent` field is refused, never dropped.
3. Pure validation of `Snapshot`/`ScanCursor` (required fields, ISO `at`,
   monotonic ids, watermark not in the future).

Manual check: `node --test tests/unit/ledger-schemas.test.mjs
tests/unit/ledger-slices.test.mjs` passes serialization round-trips with
no loss; a deliberately injected `"prompt": "..."` field is a validation
error; `grep -rn "node:fs\|process.env" packages/core/src` stays empty.

### Step 2: File-backed ledger, cursors and lock in `packages/local` (2 h)

1. `packages/local/src/ledger.ts`: file-backed stores at the reserved
   paths - slice journal (`events.jsonl`, one `SessionSlice` per line)
   and snapshot journal (`snapshots.jsonl`). Read path: skip unparseable
   line with a counted warning (reference `readLedger` behavior), apply
   "last slice per session id wins", and expose
   `skippedLines`/`sessions`/`slicesReplaced`.
2. `packages/local/src/cursors.ts`: `cursors.json` read/write where the
   write is tmp+rename atomic (reference `overrides.ts` pattern) and a
   failed load yields "no cursor" with a warning, never a guessed value.
3. `packages/local/src/lock.ts`: single-writer lock (`scan.lock` holding
   pid + startedAt + purpose): acquire fails with a clear error while
   another live pid holds it; a dead/stale pid (and an age past a max)
   breaks the lock with a warning. Writer failure at any point releases
   or leaves a stale lock for the next run to recover.
4. All stores stay keyed by injected paths; nothing in `packages/local`
  invents a second location.

Manual check: `node --test tests/unit/ledger-local.test.mjs
tests/unit/cursors-local.test.mjs tests/unit/lock-local.test.mjs`; then
by hand corrupt the journal's last line in a scratch state dir - the next
read reports `skippedLines: 1` and works; start two scans against the
same state dir - the second refuses with the lock message; `kill -9` a
holder - the next acquires after noting the stale pid.

### Step 3: Incremental reads on the existing readers (2.5 h)

1. Extend `ReadV1RowsOptions`/`ReadV2RowsOptions` with
   `watermarkMs` + `overlapMs` (default 30 s, matching the reference's
   overlap window). The preselect becomes
   `s.time_updated >= watermarkMs - overlapMs`; whole sessions
   (messages/parts/instructions) are re-read for each selected session,
   exactly like the current code reads them - only the outer filter
   changes.
2. Cursor maintenance is pure in core: `advanceCursor(current, readRows)`
   picks the max `time_updated` among fully read sessions, refuses if a
   selected session's read failed (its failure is data, not an
   exception), and never advances from partial data.
3. Mixed-schema: two independent watermarks (`v1`, `v2`), same rules; a
   schema mix change on the first incremental pass forces a `--full`
   rescan with a clear warning (counted, not fatal).
4. Batch behavior untouched: `sinceDays`/`limit`/`offset` semantics are
   pinned by existing tests plus a new one proving a watermark run with
   cursor absent equals a full run.

Manual check: `node --test tests/unit/readers-incremental.test.mjs` on
fixtures (V1, V2, mixed, a session re-read under the overlap, a
failing selected session). On the real DB copy: run an incremental read
with the recorded watermark, confirm the SQLite query touched only the
expected session ids (spot-check by hand against
`SELECT id FROM session WHERE time_updated >= ...`), and the DB file is
untouched (mtime/size).

### Step 4: Scan orchestration, snapshot append, reconcile (2 h)

1. New harness `scripts/scan-local.mjs` wrapping a library pipeline that
   lives on top of existing pieces (core stays pure; the script is the
   host like `analyze-local.mjs`):
   `lock → read cursors → incremental read → buildEvents on the fresh
   slices only → replace slices in journal → merge journal + nothing
   else → buildLedgerReport → append Snapshot → advanceCursor (tmp+rename)
   → prints refreshed summary (totals, sessions added/changed, findings
   changed).
2. `--full`: ignore cursors, read the whole window, replace every slice,
   reconcile: stored = fresh counts per session; `--repair` (explicit,
   refuse without it) rewrites the journal from a full scan when
   reconciliation reports drift (registry editions, schema surprises,
   hand-corrupted journal).
3. Ordering invariant: slices commit before advancing the cursor, and a
   crash anywhere leaves the next scan repeating the same read, with
   "last slice wins" collapsing the duplicates. No transaction across
   files; idempotency is the recovery.
4. Snapshot ids are monotonic (per process) and the snapshot content
   fields are the compact list from Step 1 - no report blobs, no
   findings detail beyond rule/count/claim.

Manual check: `npm run scan --` twice on the default DB → second run
reports zero sessions read, zero replaced, identical totals, exactly one
new snapshot row, cursors unchanged after the first advance. `npm run
scan -- --full` reconciles counts against the journal per session; the
phase-3 cleanliness check (source mtime+size unchanged) still passes.

### Step 5: Watch mode - live monitoring without a restart (2 h)

1. `scripts/scan-local.mjs --watch [--interval ms]` (default 2000,
   floor 500): each tick, `statSync` the source DB; if size/mtime
   unchanged, skip; else run one scan cycle and render the refreshed
   report with what changed since the previous render (new session ids,
   replaced session ids, totals delta, new findings if any).
2. Single-flight and truncation ported from the reference shape: a slow
   cycle never overlaps itself; if the source shrinks or changes
   fingerprint beyond watermark expectations (replace/deletion), the
   next cycle is `--full`-equivalent automatically with a warning; a
   locked/missing/unreadable DB keeps the last good state and prints a
   counted warning, retrying next tick.
3. SIGINT/SIGTERM flush: release the lock, record the final cursor and
   leave exactly one snapshot row for the last successful cycle.
4. Restart property: after stop/start, the loop resumes from
   `cursors.json` (not from "now"), so activity that happened while the
   watcher was down is picked up - this closes the exit criterion's
   second half and is pinned in a test.

Manual check: copy the DB, start `npm run scan -- --watch --db
/tmp/munin-watch.db`. Insert one new session row (a copy of an existing
row with a new id and fresh `time_updated`) via `sqlite3`. Within one
interval the render shows the new session and updated totals; repeated
inserts do not double count; SIGINT stops cleanly and the lock file is
gone; restart the watcher, insert again, it is found (cursor resumed).
Then delete the copy mid-run: the loop warns and keeps the last state
instead of crashing.

### Step 6: Trends, results comparison (2 h)

1. `core/src/analyze/snapshot-diff.ts`: pure
   `diffSnapshots(prev, current)` → totals/model deltas, session counts,
   findings that appeared/disappeared/grew (by rule id). Rendered in the
   scan summary and via `--snapshots` (list + last diff). This is
   Munin's "compare analysis over time" deliverable; it does not
   duplicate `measureResults`.
2. `core/src/analyze/results.ts`: port three pieces with their vocabulary:
   `resultsDays()` (how far back a results run must read), the baseline
   window constants (14-30 days), `measureResults()` over
   `AppliedChange` periods built from Munin's own `changes.jsonl`
   journal (period per entry: from `appliedAt` to the next undo or the
   next change on the same rule), and the verdict mapping
   (`too-early`, `no-baseline`, `working`, `no-change`, `worse`) with
   the baseline-sensitivity range.
3. `npm run scan -- --results` renders the change-driven comparison; an
   empty or zero-apply journal produces the verdict "no applied changes
   on record" rather than invented imaginative numbers. Baselines are
   computed over merged ledger state so the report can be produced
   without touching source rows whose slices are known.

Manual check: `node --test tests/unit/snapshot-diff.test.mjs
tests/unit/results.test.mjs` (fixtures: before/after period build-up,
short/long baseline edges, `too-early`/`no-baseline` verdicts, journal
dedup). Then `npm run scan -- --results` on the real state dir shows the
explicit empty state.

### Step 7: Privacy controls over everything the runtime writes (1 h)

1. The scan exposes `--check-privacy` in the same sense the analyze
   harness does: after each cycle, walk the slices/snapshots it wrote
   and refuse if any banned key or unexpected field survived (fail the
   watch cycle, keep the last good state; the cursor is not advanced).
   It must be possible to run a watch with `--check-privacy` permanently
   on.
2. `docs/ledger.md`: one table per runtime file with "what is in it" -
   mirrors the reference `info` listing - plus the retention model
   (`rm -rf` the state dir), the boundary sentence ("the source database
   is never written; prompt text never reaches the ledger"), and the
   prefix-hash note (instruction sizes and hashes only).
3. A git-tracked fixture test pins the invariant: an event with a
   tool-result blob or message text fields cannot serialize.

Manual check: run a scan with `--check-privacy` on the real DB and then
hand-grep the state dir for banned keys and for any string field longer
than the tool-name/signature vocabulary. Corrupt one event in a fixture
to include `text` - the serialization refuses (unit test) and the
watch-mode check stops the cycle before the cursor advances.

### Step 8: Documentation and exit review (1 h)

1. `docs/ledger.md` final state: runtime file map, refresh semantics,
   watermark/recovery rules and the reconcile/repair workflow.
2. Update `docs/parity-matrix.md` rows for ledger/live/results (ported,
   partial, excluded with reasons).
3. `docs/plans/README.md` + this file's status + `docs/project.md`
   Phase 5 status once the exit checklist is fully green.

Manual check: from a clean shell, `npm run scan -- --help` (or the
script's usage) names every flag used above; the plans README lists
Phase 5 with its true status; every command in the "How to verify by
hand" section below runs as written.

## How to verify by hand

All commands run from the munin repo root. The exit criterion is the
project plan's: a new OpenCode session is discovered without a restart,
and repeated scans do not double-count usage.

### 1. Baseline is intact

```bash
npm test
npm run analyze -- --report --json | sha256sum   # or shasum on macOS
npm run analyze -- --report --json | sha256sum
```

Two identical digests; 105+ tests green; the snapshot DB's mtime and size
unchanged after both runs.

### 2. First scan lays down the ledger

```bash
npm run scan -- --full
ls $HOME/.munin
```

Expect `events.jsonl`, `snapshots.jsonl`, `cursors.json`, plus the
existing state files. Totals in the scan summary equal
`npm run analyze -- --totals` on the same window and DB, to the last
digit.

### 3. Repeated scans are idempotent

```bash
npm run scan --        # second run
npm run scan --        # third run
```

Each prints `sessions read: 0`, `slices replaced: 0`, identical totals;
each appends exactly one snapshot row; cursor unchanged after the first
advance. `node -e` (or manual read) of `snapshots.jsonl` shows the same
totals on every row.

### 4. A new session is discovered without a restart

```bash
cp "$(sqlite3 ~/.../opencode.db 'SELECT 1' >/dev/null && echo path)" /tmp/munin-watch.db
npm run scan -- --watch --db /tmp/munin-watch.db
# in another shell:
sqlite3 /tmp/munin-watch.db "INSERT INTO session_v2 ... (new id, fresh time_updated)"
```

Within one interval the render lists the new session and the totals move
by consistent numbers; repeat the insert (two new sessions) and nothing
double counts. `SIGINT`: lock released, one final snapshot. Restart the
watcher, insert again, it is discovered. This is the phase's exit
criterion.

### 5. Consistency between batch and ledger paths

```bash
npm run analyze -- --totals --db /tmp/munin-watch.db
npm run scan -- --full --db /tmp/munin-watch.db   # reconcile mode
```

One reconciliation table; every session's stored vs fresh events match;
any drift is reported as a row, not a crash, and `--repair` is refused
without the explicit flag.

### 6. Incremental reads touch less data

Start a watcher with `--debug-sql` (or check the SQLite `page`/hit
counts if instrumented - record access counts in the execution notes).
While running, touch one session (bump its `time_updated`): only that
session's rows are re-read; totals for every other model/session are
unchanged to the last digit.

### 7. Torn records and stale locks recover

- Corrupt the last journal line in a scratch state dir; next read prints
  `skippedLines: 1` and the scan completes; totals unchanged.
- `kill -9` a watch process; restart recovers (stale lock broken with a
  warning, cursor reused, no double counting).
- Truncate the source DB copy (shrink) mid-watch; the loop responds with
  an automatic `--full`-equivalent pass and a warning, not a crash.

### 8. Results comparison behaves with the vocabulary it promises

Fixture journal with one apply + one undo: periods build correctly
(`from`/`until`), the verdict is one of `working`/`no-change`/`worse`
depending on the fixture, baselines shorter than 14 days or older than
30 produce `too-early`/`no-baseline`. On the real state dir the report
is the explicit "no applied changes on record" verdict.

### 9. Snapshot trends

Two scans over two DB snapshots (different times in history via
`--db` + `--days`): `--snapshots` prints both rows and the diff (added
session counts, findings that grew). Fixture test pins the diff shape.

### 10. Nothing new reads or writes source history, and no prompt text lands anywhere

```bash
grep -rn "node:fs\|process.env" packages/core/src          # still empty
npm run scan -- --check-privacy
# and, for the paranoid:
grep -rnE '"(text|prompt|summary|content|output)"' $HOME/.munin/events.jsonl $HOME/.munin/snapshots.jsonl
```

The grep finds nothing; `--check-privacy` exits 0; the analyze
cleanliness check (source mtime/size unchanged) passes after a full
watch cycle.

## Out of scope for this plan

- CLI product commands (`live`, `results`, `sessions`, `watch`) - Phase 6
  wires the same library seam; the harness flags are the manual surface.
- The dashboard and its live refresh - Phase 7.
- Jev-style remote judging, samples.jsonl capture, meter reading,
  notify/osascript - reference only, Claude/plan-specific or
  network-optional; none is in Munin's scope decisions.
- Claude-specific state (guard hooks, statusline, mod session files,
  plan-usage meter) - excluded per Phase 0.
- High-frequency event streaming into the ledger (the reference's 500 ms
  per-line tails): SQLite reads land in whole sessions, and 2 s polling
  granularity is the local-runtime tradeoff documented in the plan.
- Ledger compaction and file-size management (append-only journal grows;
  a `--repair` full rewrite is the reset path in this phase).
- Repricing the ledger under a new pricing edition over time (reconcile
  reports the drift; a pricing-migration strategy is follow-up work).
- Cross-machine or multi-user state; `changes.jsonl` periods across
  unrelated config rewrites (Phase 4 kept the journal single-session).

## Risks and mitigations

- **Double counting from watermarks/edges**: never sum; every merge is
  "replace by session id" + stable event ids; the 30 s overlap below the
  watermark plus `--full` reconciliation as the backstop; pin-tests for
  rescan, re-read and truncate cases.
- **Incremental vs batch totals diverging**: one report-builder path in
  core; the equivalence test (ledger rebuild equals batch totals on
  fixtures and one real snapshot) fails loudly if a fork appears.
- **Watch loop fighting itself or the analyze harness**: single-writer
  lock with pid staleness; single-flight cycle guard; distinct flags per
  process.
- **State file corruption**: skip-and-count at read, fail-closed gates,
  tmp+rename for `cursors.json` and repairs, `--repair` as the explicit
  reset; a crash-lite phase never leaves a half-written cursor.
- **Privacy regression while writing more files**: serialization-time
  refusal (not silent strip), `--check-privacy` attached to the cycle,
  a pin-tested fixture proving banned keys cannot serialize, and the
  storage-table doc.
- **Scope creep into dashboard-friendly shapes**: snapshot stays compact
  (rule/count/claim; no finding detail), so Phase 7 renders trends from
  the same shared contracts without schema rework in this phase.

## Minimum cut if time runs short

1. Ledger slices + cursors + read-time dedup with the idempotent scan
   (exit criterion's second half) and updated readers watermarking.
2. Watch loop with discovery-without-restart, single-flight, and
   truncate/lock/missing-DB recovery warnings.
3. Snapshot append and trend diff with compact schema (`--results` can
   degrade to the explicit "no applied changes" state).
4. Privacy gate over the new files + `docs/ledger.md` storage table.
5. Reconcile/repair and the baseline-sensitivity results port can defer
   to the Phase 6 wiring without weakening the exit criterion.
