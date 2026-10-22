# Catch-up: what Munin has, what is left, and where it is going

Written 2026-10-23, right after Phase 4 closed and Phase 5 planning landed.
This is a plain-words summary for anyone (including future us) picking the
project back up. No new information here that docs and plans do not already
have; this just puts it in one place, with real output where we have it.

## The one-paragraph version

Munin is a rebuild of `optimaizr` (the CLI in `../optimaizr`, see its
`docs/CLI.md` and `CHANGELOG.md`) that drops the Claude-only parts and adds
OpenCode 2.x plus a local dashboard. It is a workspace with three packages:
`packages/core` (pure engine, no filesystem or network), `packages/local`
(readers and storage, the only package allowed to touch disk), and `apps/cli`
(the command surface). Phases 1 through 4 are done: the workspace builds, the
OpenCode history readers work against real databases, the pricing + analysis +
rules engine produces findings and reports, and the rules engine has
recommendations, decision state, verification, and an apply/undo seam. What is
not there yet: a runtime ledger (Phase 5), real CLI commands (Phase 6), the
dashboard (Phase 7), release hardening (Phase 8) and the OpenCode
guard/statusline plugins (also Phase 6, researched). Today, the only wired CLI
flag is `--version`; everything real is driven through the analyze harness,
`npm run analyze -- <mode>`, which is developer-facing right now and becomes
the user-facing reports in Phase 6.

## What is working today, in command order

### `node apps/cli/dist/cli.js --version` (user facing, the only wired CLI flag)

Prints the version and exits 0. It exists so the package is installable end to
end while the engine was being ported. Anything else prints a one-line notice
that commands are not wired yet and exits 1.

Underneath: `apps/cli/src/cli.ts` is a tiny manually-checked dispatcher, by
design. Phase 6 replaces it with the real command table wired to the same
engine the harness calls. Exit codes already follow the final contract
(`docs/diagnostics.md`): 0 ok, 1 runtime error, 2 unsupported/not automatable,
64 usage error, with `MuninError` payloads and warning registries.

### `npm run analyze -- <mode>` (developer-facing harness today, the future reports)

The Phase 3 analyze harness (`scripts/analyze-local.mjs`). It reads the real
OpenCode database read-only, runs the full engine, and prints results. Modes:
`--totals`, `--models`, `--sessions`, `--cache`, `--findings`, `--report`,
`--events`, plus `--decide <status> <rule>`, `--verify-state`, `--accept-risk
<rule>`, `--check-privacy`, `--db <path>`, `--tz <zone>`, `--json`. stdout
carries data only; warnings go to stderr. It writes nothing except when a mode
explicitly records state (decisions, accept-risk), and even then only into
`~/.munin/`.

Real output on the author's own database (2026-10-22, 18.58 days, 1,775 calls
in 31 sessions; free models dominate so headline dollars are tiny on purpose):

```text
Totals
  db           /Users/shabad/.local/share/opencode/opencode.db
  window       2026-10-04T05:24:04Z .. 2026-10-22T19:26:12Z (18.58 days)
  calls        1,775 calls, 31 sessions, 135 turns, 7 subagent sessions
  tokens       input 8.4M | priced output 1.2M (thinking 515K) | cache read 113.3M
  costs        observed $0.759758 | estimated $0.759758 | unpriced 0
  rates        observed coverage 100%  cache hit 93.11%  thinking 42.82%
  savings      fix $0.0192 (monthly $0.0310) | try $0.2620 | all $0.2725
```

```text
model                              calls     headline  share  cache hit
ollama-cloud/gpt-oss:120b             654   $0.759758  100%     96.22%
opencode/deepseek-v4.1-flash-free     678   $0.000000    0%     89.02%
opencode/glm-5.3-flash-free           444   $0.000000    0%     95.74%
```

And one real finding (from `--findings`):

```text
[try] 296 calls happened after repeated compaction epochs   context-compaction
  affected     296 calls, share 4.73% of window spend
  savings      window $0.003196 | monthly $0.005159 | tokens 182,925
  calculation  For events with epoch >= 2: 15% of input tokens priced at input-rate.
  assumption   15% of post-compaction input is treated as avoidable rebuild overhead.
  fix          Use tighter context windows and periodic checkpoint summaries.
  overlap      shares claimed calls with model-fit, oversized-input, ...
```

How it works underneath, in one line each:

1. `packages/local` readers detect the schema (V1 `session/message/part`,
   V2 `session_v2/session_message`, or mixed) and read the SQLite database
   open-only, never writing it.
2. `core/normalize` turns rows into a `Dataset`; `buildEvents` walks messages
   in source order and produces one priced `UsageEvent` per model call.
   Failed attempts fail calls (never price, never enter totals). Sessions in
   the source are only reconciled, never billed.
3. `core/pricing` holds dated rate cards with model aliases. Each call gets a
   cost basis: `observed` (the provider-reported charge, the headline),
   `estimated` (tokens priced on the date-correct card), or `unpriced`
   (tokens only, never a fake `$0`). This is why every dollar has a basis and
   a date beside it.
4. `core/analyze` builds aggregates (`summarize` buckets by model, provider,
   project, day, session, agent), cache stats, session rows, and heads to
   `core/analyze/rules.ts` for the rules; then rules run their detectors.
5. Findings are reports with proof: affected events, savings split as fix /
   try / test without ever adding tiers together, confidence, assumptions, and
   a plain-language calculation. Overlapping findings de-overlap per call
   (largest claim wins), so numbers are never double counted.
6. `buildReport` assembles the whole thing into byte-identical JSON with a
   `dataHealth` block: what was read, what was skipped, unpriced models,
   reconciliation, detector errors.

Where this lands for users: in Phase 6 these same modes become `munin`,
`munin scan`, `munin why`, `munin sessions`, `munin tokens`, `munin waste`,
`munin show <rule>`, `munin report`. The harness stays for developers.

### `npm run analyze -- --decide / --verify-state / --accept-risk` (internal state plumbing)

Phase 4: recommendations shipping as decision state.

- Findings that are advisory (like `cost-spike`) never become recommendations;
  actionable ones get an action, rationale, available actions, and a stored
  status: `new`, `viewed`, `applied`, `done`, `dismissed`.
- `--decide viewed model-fit` records what you thought. It stores in
  `~/.munin` (the DecisionStore), never in OpenCode's database.
- `--verify-state` and `--accept-risk` control the gate: a change can only be
  `applied` if it is `not-required` type (pure waste removal), passes a replay,
  or you explicitly accept the risk. Failed or unverifiable replays fail
  closed.
- Replay is offline in this phase: a token replay reruns the pure detector
  over stored events and compares the saved claim (stale findings get
  flagged); a plan replay is a caller-injected mock executor. No live model
  calls exist anywhere in Munin yet (that is optimaizr's `verify`, deferred).
- The apply/undo seam exists and is tested, but only for settings Munin owns
  (keys in `~/.munin/config.json`; the two appliable ones are `days` and
  `tz`). No current rule maps to either, so all
  external-agent actions queue (documented in docs/rules-unsupported.md). Undo
  journals exact prior config bytes and restores them; a failed restore stays
  pending so nothing is silently corrupted.

## What is done, phase by phase

| Phase | Status | What it delivered |
| --- | --- | --- |
| 1 | done 2026-10-22 | workspace, contracts, config, diagnostics, tests. Exit record `docs/plans/phase-1-completion.md`. |
| 2 | done 2026-10-22 | OpenCode V1 + V2 + mixed-schema read-only readers, instruction/reference hashes. Exit record `docs/plans/phase-2-readers.md`. |
| 3 | done 2026-10-22 | the engine: buildEvents, pricing, aggregates, cache analysis, two repeat detectors, buildReport with dataHealth, the analyze harness. Exit record `docs/plans/phase-3-analysis.md`. |
| 4 | done 2026-10-23 | the rest of the rules (17 total), recommendations, decision state, verification with replay, apply/undo seams, the apply journal. Exit in `docs/plans/phase-4-rules.md`. |
| 5 | planned, not started | ledger, incremental scans, watch mode, snapshots, results comparison. Plan `docs/plans/phase-5-runtime.md`. |
| 6 | not started | the real CLI commands plus the OpenCode guard/statusline plugin package. |
| 7 | not started | local dashboard on the same engine. |
| 8 | not started | fixtures, e2e, release readiness. |

References for what was kept/adapted/excluded from optimaizr:
`docs/parity-matrix.md`. All the lesson "why" docs: `docs/analysis.md`
(token and cost semantics), `docs/pricing.md`, `docs/rules.md` (every rule
with its thresholds), `docs/rules-unsupported.md`, `docs/reports.md`
(report shape), `docs/diagnostics.md` (exit codes and errors),
`docs/readers.md`.

105 unit tests green across all four phases.

## The features that are left, and how each will look

Everything here is from `docs/project.md` (the phase plan and its Phase 6
research notes), `docs/plans/phase-5-runtime.md` and `docs/parity-matrix.md`;
nothing is invented.

### Phase 5 first (runtime), then Phase 6 exposes it

Phase 5 turns the batch harness into a local runtime. After it:

- `npm run scan --` does one full or incremental scan and lands a ledger.
  Its summary shows what changed: sessions read, slices replaced, totals, and
  findings that appeared or disappeared.
- `npm run scan -- --watch --interval 2000` keeps a live view open. It stats
  the database every tick, and when it changed, reads only sessions whose
  `time_updated` moved, re-reads those sessions whole, and replaces their
  ledger slice. New sessions show up with no restart, and restarting the
  watcher picks up
  activity that happened while it was down (that is the Phase 5 exit
  criterion).
- Idempotency rule: never sum. Each session slice is replace-per-session-id,
  so scanning twice, or a session growing mid-watch, cannot double count. The
  pin test: for the same window, ledger totals equal batch totals to the last
  digit.
- Watermarks live in `~/.munin/cursors.json`, one per schema (V1/V2), 30
  seconds of overlap below the watermark so late-committed sessions are not
  missed.
- `scan` keeps its own single-writer lock (`scan.lock` with pid + age),
  tolerates torn lines with `skipped lines: N`, breaks stale locks after a
  crash, and treats source truncation or replacement as an automatic full
  rescan with a warning.
- Every completed scan appends one compact snapshot
  (`~/.munin/snapshots.jsonl`), and `diffSnapshots(prev, current)` turns two
  snapshots into a trend: models moved, new sessions, findings that grew or
  disappeared.
- The results comparison (optimaizr's `optimaizr results`) is ported with its
  verdict words intact (`too-early`, `no-baseline`, `working`, `no-change`,
  `worse`, with a baseline-sensitivity range). Because no rule currently maps
  to a change Munin can apply, an empty journal produces the explicit, honest
  "no applied changes on record" verdict rather than fabricated numbers.
- Privacy stays checkable: `--check-privacy` fails the cycle (and the code
  never serializes prompt-bearing keys; the allowed vocabulary block lives in
  core now, so any future host inherits it). `docs/ledger.md` will list every
  file under `~/.munin` with a one-line "what is in this file".

User-facing verdict: Phase 5's surface is still the harness (`npm run scan
--`). `docs/plans/phase-5-runtime.md` is the plan; its "How to verify by hand"
section is the manual script.

### Phase 6: the real CLI

The command list below is the parity matrix target, with status per command:
`profile/scan/waste/show/why/sessions/tokens/live/report/apply/undo/privacy`
are ported or adapted (reference logic, OpenCode-shaped data):

```bash
munin                    # the profile: totals, savings by tier, biggest win, next step
munin scan               # spend, findings, and what to do about them, plus data health
munin why                # drill down: $total -> provider -> model -> project -> kind of work
munin sessions           # costliest sessions, cache story, cold returns
munin tokens             # token analytics, priciest single calls
munin waste              # just the opportunities
munin show <rule>        # the individual events a rule touched (evidence)
munin report             # self-contained HTML dashboard, local-only links
munin apply <rule>       # kept in config or guided steps
munin undo <rule>        # undo anything apply did
munin providers          # what can be read, and from where
munin privacy            # what is collected and stored
munin help / munin help all
munin live               # watch mode over the TUI (the Phase 5 watch loop, promoted)
```

After the block above, the stretch commands stay marked as stretch, exactly
as the parity matrix has them: `munin simulate --to <model>`, `munin card`,
`munin results`, `munin verify --replay`. The Phase 5 plan ports the
*measurement machinery* behind `results` (the verdict vocabulary, the
baseline windows, `resultsDays`) driven by the apply journal and shown
through `npm run scan -- --results`, but a standalone `munin results`
command is not a Phase 6 promise. Excluded outright (from the matrix):
`plan`, `codex-plan`, `limit`, `statusline/guard/mod` in their Claude forms
(the OpenCode forms are below), `metrics`, `feedback`, `changelog`, `import`,
`guide`, and `audit`.

The two deliberate visual differences from optimaizr, both from exclusions:
no plan-window sections (no Claude Pro 5-hour meter, no ChatGPT plan meter),
and `--plan` is gone with them.

Expected look of `munin` (the profile), marked "mock" so it is never mistaken
for shipped output; the wording follows the reference's style and the tier
rules (fix / try / "up to" test, never summed), the ratios come from the real
harness run above:

```text
munin | profile
2026-10-04 to 2026-10-22  (18.58 days)

  Observed $0.760 in this window · 1,775 calls · 122.9M tokens
  (billed = what the source recorded; the list-price estimate happens to match)

  Savings found
    Clear waste              $0.031/mo   fix it, nothing to lose
    Likely, if you try      +$0.423/mo   compaction rebuilds, cold resumes
    Up to, if you test       $0.00/mo   (no test-tier findings)

  Biggest win  Context after compaction · try · medium confidence
    296 of 1,775 calls carried a compaction epoch · ~$5.14/yr at this pace

  Where it goes
    Cache hits carried 93% of input traffic (already the cheap rate)
    Thinking was 42.8% of priced output
    7 subagent sessions ran alongside the main conversations
```

How the money is arrived at, unchanged from today: each finding carries its
own calculation and assumptions; overlapping findings de-overlap per call
(largest claim wins); tiers are never added together; monthly and annual
figures scale the window by its real day count and say so.

### Phase 6: guard and statusline as an OpenCode plugin

Researched and written up in `docs/project.md` (Phase 6, "Guard and statusline
findings"). Feasibility confirmed against OpenCode 2.x docs; one open question
remains (whether throwing inside OpenCode's prompt hook aborts admission
cleanly, which decides guard v1 cold-cache holds vs warn-only). Planned shape:

- One npm plugin package, two entry points: a server plugin (listed in
  opencode.json `plugins`) and a terminal plugin (`/tui` export, listed in
  `cli.json` `plugins`).
- `munin guard on | off` edits those config files the way `optimaizr guard`
  edits Claude hooks; receipts live under `~/.munin`.
- Guard v1 catches tool actions only: a whole-file read over the size
  threshold and a third identical failing shell command, using OpenCode's
  permission `evaluate` hook to turn `allow` into `ask` with a cost message.
- Statusline renders in the OpenCode TUI footer slot; it shows context size,
  re-read cost, cache countdown, this-turn cost, a cheaper-model hint, a
  user-set budget percent, and guard status.

### Phase 7: the dashboard

A local web app (planned stack: light React + Vite) bound to localhost,
calling the same core contracts. Four pages: `/` overview (KPIs, spend over
time, model and cache split, top findings, data health), `/sessions` with
filters, `/sessions/[id]` with a turn timeline, and `/findings` with evidence
and apply/undo for the rules that support it. Exit criterion: dashboard totals
match CLI totals to the last digit.

### Phase 8: release

Clean-checkout builds, V1/V2 fixtures for regression tests, CLI e2e, pricing
pin tests, apply/undo state tests, and the final checklist in
`docs/project.md`: readers never modify source history, findings explainable,
supported rules apply and undo safely, lists of unsupported features are
documented.

## What was deliberately left out (so we do not wonder later)

From `docs/parity-matrix.md`: no Claude Code, Codex, or Gemini-CLI readers; no
CSV/JSON import; no SDK `wrap()`; no subscription-plan windows, so no
`optimaizr limit` learning and no `--plan`; no live-model replay verification
in this cut (the verdict/state machine is in place so it can be added without
reshaping the rules). Reader-level exclusions: import, images, plans. Two
details already handled despite those gaps: free `$0` models in OpenCode
correctly show `$0` spend rather than "unpriced" (they have an observed basis
with a $0 recorded charge), and models with no card at all surface in
`dataHealth.unpricedModels` with their call and token counts instead of
passing as cheap months. The pricing registry carries tiered rate cards (a
long-context price kicks in past a threshold's token count) and a
prefix-alias layer, so a renamed model id still prices under the right card.

## Where every kind of surface sits today

| Surface | Today | At deployment |
| --- | --- | --- |
| `--version` and the CLI stub | user visible | replaced by the full Phase 6 CLI |
| `npm run analyze -- <mode>` harness | developer diagnostic | stays as the maintenance tool, outputs promoted into `munin scan/profile etc.` |
| config (`~/.munin/config.json`, `MUNIN_DB`, `XDG_DATA_HOME`, `MUNIN_DIR`, `MUNIN_DEBUG`) | internal | documented user-facing paths |
| decision store, apply journal, verification store | internal | user-visible through `apply/undo/show` |
| parity-matrix / analysis / pricing / rules / reports / diagnostics docs | internal | the CONTRIBUTING/API level of the shipped repo |
| OpenCode database | read-only source, never written | same |
| rule thresholds, confidence vocabulary, finding contract | internal | user-visible wording inside every finding |
