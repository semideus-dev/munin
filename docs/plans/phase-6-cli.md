# Phase 6 plan: the real CLI, plus the OpenCode guard/statusline plugin

Status: in progress. Step 0 (Phase 5 manual exit check) is pending; Step 1
(command table, dispatcher, help/status, exit and JSON plumbing), Step 2
(read-only report commands) and Step 3 (scan and live over the runtime) are
complete.
Owner: team
Scope: replace the `--version`-only CLI stub with the product command table
from the parity matrix, promote the Phase 5 runtime behind real commands,
expose the Phase 4 apply/undo/verify state machine to users, and ship the
OpenCode plugin package (guard + statusline) with its `munin guard` /
`munin statusline` install commands. No dashboard: that is Phase 7.
Estimated effort: 14 to 20 hours

## Goal

After this phase a user installs the package, runs `munin`, and gets a useful
report from their actual OpenCode history. Exit criterion (from
`docs/project.md`): a user can build the project and get a useful report from
actual local history.

Everything the CLI prints must come from the same engine the harnesses call.
There is one report-building path in core; the CLI is a new frontend over it,
not a fork of it.

## Current situation (2026-10-23)

- `apps/cli/src/cli.ts` now dispatches through the product command table.
  Help, `help all`, per-command `--help`, the XDG environment block, and the
  shared exit/JSON contract are wired. The read-only report commands run on
  the shared core path; commands still being ported exit 2 with
  `cli.not-implemented`.
- `scripts/analyze-local.mjs` (Phase 3) and `scripts/scan-local.mjs`
  (Phase 5) are the real surfaces today: totals, models, sessions, cache,
  findings, report, decide/verify-state/accept-risk, full/incremental scan,
  watch, snapshots, results, check-privacy.
- `packages/local/src/scan.ts` holds the watch loop, single-writer lock,
  watermarks, snapshot append; `packages/core` holds the report builders;
  Phase 4's apply/undo journal and decision store are seam-level only.
- The plugin research is done (`docs/project.md`, "Guard and statusline
  findings"): one npm plugin package, two entries (server plugin in
  `opencode.jsonc`, terminal plugin `./tui` export in `cli.json`); one open
  question about cold-cache holds remains.
- The reference CLI (`../optimaizr/apps/cli`) is the semantics source. Do not
  invent parity: read the reference command under `../optimaizr/apps/cli`
  before porting each one; its `dispatch`, `args`, `data`, `config` modules
  are marked Ported in `docs/parity-matrix.md`.

## Steps

Order follows `docs/project.md` implementation steps: report/help/sessions
first, then why and live, then apply/undo and verify once rule behaviour is
safe, with the plugin work last because it is the only piece with an
unverified integration question.

### Step 0. Close Phase 5 for real (about 1 hour)

The Phase 5 manual exit check is still pending, and Phase 6 builds on the
watch loop it verifies.

- Deliverables:
  - Run the "How to verify by hand" script from `docs/plans/phase-5-runtime.md`
    against a disposable copy of the real OpenCode database: new-session
    discovery without restart, restart resume, rescan idempotency
    (`--full` twice, totals identical to the last digit).
  - `docs/plans/phase-5-completion.md` exit record; flip the status lines in
    `docs/plans/README.md`, `docs/project.md`, and this file.
- Test now: the pin test matters late too. `munin scan` twice in Step 3 must
  produce identical totals, so record today's baseline numbers in the
  completion record.

### Step 1. Command table, dispatcher, help and status (about 2 hours)

Replace the stub dispatcher with the real command table.

- Deliverables:
  - `munin <command>` table covering: `profile` (default), `scan`, `why`,
    `sessions`, `tokens`, `waste`, `show`, `report`, `apply`, `undo`,
    `results`, `verify`, `providers`, `privacy`, `live`, `guard`,
    `statusline`, `card`, `simulate`, `help`.
  - `munin help` (four groups: start here, change things, look closer,
    about), `munin help all`, and `munin <command> --help`.
  - Environment checks behind `munin doctor`-style output of `help`/default
    error paths: resolve the OpenCode database path the same way OpenCode
    does (XDG), print where `~/.munin` lives (that is the "status" half of
    the phase table).
  - Shared exit-code and `--json` plumbing through `apps/cli/src/exit.ts`:
    `MuninError` kinds to 1/2/64, unknown command exit 64, JSON contract
    `{ok, data, warnings}` / `{ok:false, error}` per `docs/diagnostics.md`.
- Test now:
  - `munin help`, `munin help all`, `munin nonsense` (exit 64, no stack),
    `MUNIN_DEBUG=1 munin nonsense` (stack on stderr only).
  - `munin --version` unchanged; `--json` on a failing command emits exactly
    one valid JSON document.

Execution (2026-10-23): complete. The table, aliases, four help groups,
per-command help, environment block, exit mapping, JSON failure shape, and
dispatch tests are in place. Until Step 2, bare `munin` shows help/status and
recognised handlers that are not wired yet exit 2.

### Step 2. Read-only report commands (about 4 hours)

The Phase 3 harness modes become commands. Port semantics one command at a
time from the reference `apps/cli` source.

- Deliverables:
  - `munin` (the profile): totals, savings tiers (fix / try / up to, never
    summed), biggest win, next step. The mock in `docs/catch-up.md` is the
    wording target and is marked "mock" - keep it so.
  - `munin scan`: spend, findings, what to do about them, data health block.
  - `munin why`: `$total -> provider -> model -> project -> kind of work`
    drill-down.
  - `munin sessions`: costliest sessions, cache story, cold returns
    (`--top N`, default 10).
  - `munin tokens` and `munin waste` and `munin show <rule>`.
  - `munin providers` (what can be read, and from where) and
    `munin privacy` (what is collected and stored; reuse the Phase 5 privacy
    vocabulary).
  - Flags per `docs/diagnostics.md`, reference semantics: `--days N`,
    `--project STR`, `--tz utc|local|<IANA>`, `--json`, `--why`
    (calculations and assumptions). No `--plan` (excluded).
  - Harness parity: `npm run analyze` outputs stay byte-identical; both
    front ends call the same core builders.
- Test now (this is the strongest step to test against, on your real DB):
  - Pin test per command: `munin` profile totals equal
    `npm run analyze -- --totals` at the same window, digit for digit;
    `munin sessions` vs `--sessions`; `munin show <rule>` vs `--findings`
    evidence.
  - Exit path: `munin --db /nope/munin.db sessions` exits 1 with
    `source.missing-db`, no stack, `--json` shape correct.
  - Presentation rules: piped output plain, colour only on a TTY, paths
    absolute.
  - Privacy grep from Phase 5 (`packages/core` has no `node:fs` /
    `process.env`) still passes.

Execution (2026-10-23): complete. `apps/cli/src/data.ts` is the single read
path (load config, `readDataset` with `--days`, `--project` filter, one
`buildEvents` + `buildReport`); `apps/cli/src/render.ts` is the CLI port of the
harness formatters; `apps/cli/src/commands-report.ts` holds the handlers, and
`commands.ts` wires them for `profile`, `scan`, `sessions`, `why`, `tokens`,
`waste`, `show`, `providers`, and `privacy`. Bare `munin` now runs the profile
instead of printing help. `tests/unit/cli-report.test.mjs` pins profile totals,
window and savings, the session list, and scan findings/recommendations against
`scripts/analyze-local.mjs` on one fixture DB, pins `show <rule>` against
`--findings`, and covers the missing-DB exit path. New `cli.*` and
`rules.unknown-rule` codes are registered in `docs/diagnostics.md`.

### Step 3. Scan and live over the shared runtime (about 3 hours)

Promote the Phase 5 harness onto product commands; the library seam already
exists in `packages/local/src/scan.ts`.

- Deliverables:
  - `munin scan` gains the Phase 5 flags: one-shot full or incremental scan
    over the real DB, `--full`, `--repair`, landing and appending the
    ledger, plus the summary of what changed.
  - `munin live`: the Phase 5 watch loop as a standalone TUI, polling the
    OpenCode database (no plugin, per the researched split: statusline inside
    the session you type in, live across all open conversations).
    `--interval N`, single-writer lock respected, `MUNIN_DEBUG` trace.
  - Wire warnings from the scan runtime (stale lock, truncation,
    skipped lines, reconcile drift) to stderr under the diagnostics rules.
- Test now:
  - Repeat the Step 0 manual script, now with product commands: open a new
    OpenCode session while `munin live` runs; it appears without a restart;
    totals after match the batch `munin` totals at the same window.
  - Kill `munin live` mid-cycle and restart: it catches up, nothing double
    counts.
  - Run `munin scan` and `munin live` concurrently: the lock message shows
    and neither corrupts the ledger.
  - Two watch instances: second one refuses or warns per the lock policy.

Execution (2026-10-23): complete. `munin scan` now runs the Phase 5 locked scan
(`runScan`) and renders the scan summary (mode, sessions read, slices replaced,
tracked, reconciliation, snapshot trend) ahead of the Step 2 report sections;
`--full`, `--repair` and `--tz` are wired, and `--days`/`--project` filter the
reported view while the ledger and snapshot stay full. `munin live` runs
`createScanWatcher` as a streaming log: one compact cycle line per change, quiet
on unchanged ticks, warnings and full-rescan notices to stderr once each, and
`--interval N` (minimum 500 ms; `--json` streams one event per line). New
`apps/cli/src/scan-support.ts` maps flags and runtime failures to `MuninError`
(`state.lock-held`, `state.lock-unremovable`, `source.*`, `ledger.scan-failed`),
and `apps/cli/src/commands-live.ts` holds the watch handler. The runtime codes
(`state.*`, `ledger.*`, `watch.*`) are now in `WARNING_CODES` and registered in
`docs/diagnostics.md`. `tests/unit/cli-scan.test.mjs` covers full/incremental
totals, the `--project` view against a full ledger, lock contention, missing DB,
the `--repair` usage error, and a `live` SIGTERM smoke test; the Step 2 scan pin
still passes through the ledger path.

### Step 4. Report HTML (about 2 hours)

- Deliverables: `munin report` writes the self-contained HTML dashboard
  (reference `core/report/html.ts` is Ported; local-only links, no external
  assets). Exit nonzero if the target is unwritable.
- Test now: output file opens from `file://` with no network requests
  (browser devtools offline), and the totals on the page match `munin` to
  the last digit.

### Step 5. apply / undo, then results (about 3 hours)

Expose the Phase 4 seam. Apply/undo come before results so the journal has
real entries to compare.

- Deliverables:
  - `munin apply <rule>`: only for settings Munin owns (currently `days`
    and `tz` in `~/.munin/config.json`); behavioural rules exit 2 with an
    `action.*` code and print the guided steps instead. `--why` shows
    calculation and assumptions.
  - `munin undo <rule>`: restores exact prior config bytes from the journal;
    failed restore stays pending, never silently corrupted.
  - `munin results`: each applied change against the days before it,
    verdict vocabulary intact (`too-early`, `no-baseline`, `working`,
    `no-change`, `worse`) with baseline sensitivity. An empty journal prints
    the explicit "No applied changes on record" verdict.
- Test now:
  - `munin apply cost-spike` (behavioural) exits 2 and lists nothing applied.
  - `munin apply days --json` in a sandboxed `MUNIN_DIR` appends one journal
    record; `munin undo days` restores the exact prior bytes (file compare).
  - After a real apply: `munin results` shows `too-early`, then `working` /
    `no-change` once baseline windows exist; never sums tiers.
  - The Phase 4 arithmetic fixtures still pass untouched.

### Step 6. verify (about 2 hours)

- Deliverables: `munin verify --replay` runs the offline token replay over
  stored events, flags stale findings, fails closed. Live model replay stays
  deferred (documented gap, not silently missing).
- Test now: replay on saved events reproduces the saved claim; mutate a
  fixture line and verify fails closed with exit 1.

### Step 7. OpenCode plugin package: guard and statusline (about 5-6 hours)

The only step with an open integration question. The spike happens before or
at the start of this step, not at the end.

- Deliverables:
  - New plugin package (its own npm package, `bin` optional) with two
    entries: server plugin listed in `opencode.json(c)` `plugins`, terminal
    plugin (`./tui` export) listed in `cli.json` `plugins`.
  - 1-hour spike first: does throwing in the session prompt hook abort
    admission cleanly? If yes, guard v1 holds cold-cache reads; if not,
    guard v1 warns through live and statusline instead (either outcome is
    acceptable; record it in a decision note under `docs/adr/`).
  - Guard v1: oversized whole-file read and third identical failing shell
    command, via the permission `evaluate` hook (`allow` becomes `ask` with
    a cost message; explicit user denies stay final). Failure tracking via
    `tool.execute.after` + plugin storage (replaces the reference's
    `marks.json`).
  - Statusline v1 in `prompt.footer.status`: context size, re-read cost,
    cache countdown, this-turn cost and duration, cheaper-model hint,
    user-set budget percent, guard status.
  - `munin guard on|off` and `munin statusline on|off`: edit the OpenCode
    config files the way the reference edits Claude hooks; byte-exact
    receipts of prior config under `MUNIN_DIR`; idempotent re-runs.
- Test now (disposable OpenCode project + throwaway config; never the
  author's real session):
  - `munin guard on` receipts restores prior bytes on `off`, re-runs are
    no-ops, editing survives an OpenCode restart.
  - OpenCode test project: trigger an oversized read (hold or warn per spike
    verdict), trigger three identical failing shell commands (hold message
    shows once, then goes through).
  - Statusline: turns render session cost/count; token counts verified
    against the client data (fallback usage recorder if they are off).
  - Package boundary: the plugin reads the same state under `MUNIN_DIR` and
    writes nothing to the OpenCode database.

### Step 8. Phase close-out (about 1-2 hours)

- Deliverables:
  - Parity matrix statuses flip (`scan`, `live`, `results`, `providers`
    rows) including the excluded list getting its real replacements
    (`munin guard`, `munin statusline` as OpenCode forms).
  - `docs/plans/phase-6-completion.md` exit record; `apps/cli/README.md`
    short-form command reference (the reference's npm page is the model).
  - Catch-up doc refresh.
- Test now, the exit criterion itself: from a clean checkout,
  `npm install && npm run build && node apps/cli/dist/cli.js` produces a
  useful report from actual local history, and `npm test` is green.

## Out of scope for this plan

- The dashboard and its server (Phase 7).
- `munin simulate --to <model>` beyond the stretch stub; `munin card` is a
  stretch command, ported only if time remains (both are marked Deferred in
  the parity matrix).
- Live model replay verification behind `munin verify`; offline replay only.
- Claude-form statusline/guard/mod semantics; only the OpenCode plugin forms
  exist.
- Subscription plan windows, `--plan`, import, metrics, feedback, guide,
  audit, changelog commands - excluded, per the parity matrix.
- Ledger compaction and multi-machine state - Phase 5 follow-up, unchanged.

## Risks and mitigations

- **Two front ends drift apart** (harness vs CLI): one report-builder path in
  core, the pin tests of Step 2 fail loudly if a fork appears; the harness
  scripts stay as the developer surface.
- **Plugin breaks sessions**: the spike gate before guard work; guard/undo
  receipts restore exact bytes; all plugin testing happens in a disposable
  OpenCode project, never the author's live config.
- **Guard's hold row missing** (the unverified prompt-hook behaviour): the
  researched fallback is warn-only through live and statusline; v1 catches
  tool actions only either way.
- **Command semantics invented instead of ported**: each Step 2 command is
  read out of `../optimaizr/apps/cli` first; wording targets (the mock
  profile) are already written down so nothing is improvised twice.
- **Exit/JSON contract regressions**: the diagnostics table in
  `docs/diagnostics.md` gains new command codes as they land, and tests
  assert 0/1/2/64 per contract.

## Minimum cut if time runs short

1. Step 1 (dispatcher/help) + Step 2 read-only commands with the pin tests -
   the exit criterion is already satisfied here.
2. Step 3 scan/live promotion.
3. Step 5 apply/undo (results can stay harness-only without weakening
   anything; its machinery is already Phase 5 complete).
4. Step 7 guard/statusline can drop to a separate follow-up plan; it is the
   biggest time sink and has its own open question. `docs/project.md`
   already records the research needed to resume it.
