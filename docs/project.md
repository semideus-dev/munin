# Optimaizr Rebuild --- Multi-phase Implementation Plan

**Objective:** Recreate the original Optimaizr project in a new folder,
using the cloned repository as a behavioral and implementation
reference. Preserve reusable features while excluding Claude-specific
mods, and add a local interactive dashboard plus OpenCode 2.x support.

**Guiding principle:** Build the shared engine first, validate it
against real local history, and then expose it through the CLI and
dashboard. Avoid duplicate business logic or an unnecessary
backend/database stack.

## Scope decisions

- **Keep:** core, local, CLI, supported data-source readers, pricing,
  ingestion, analysis, optimization rules, reports, live monitoring,
  ledger, replay/verification, apply/undo, and generic configuration.
- **Exclude:** `mods/optimaizr` and Claude-specific hooks, statusline
  integrations, and plugin setup. The non-Claude equivalents (OpenCode
  server guard and terminal statusline plugins) are planned under Phase 6.
- **Add:** an interactive local dashboard and OpenCode 2.x support.
- **Preserve:** OpenCode 1.x compatibility and the original shared
  engine behavior.
- **Runtime:** Bun as the preferred development runtime where it
  works. Keep npm available for the original-compatible build workflow
  if Bun's workspace scripts cause issues.
- **Avoid:** replacing the existing architecture with an unrelated
  framework or database stack just for the sake of it.

Difficulty ratings are relative to this project and a 24-hour hackathon,
assuming one developer comfortable with TypeScript. They are not
guaranteed time estimates.

---

## 1. Target architecture

The CLI and dashboard should call the same core functions. The dashboard
must not implement its own token calculations or optimization logic.

---

Layer Responsibility

---

Local data sources OpenCode 1.x and 2.x plus other
readers confirmed in the original
repository inventory.

Shared core Normalization, pricing, token/cost
calculations, caching analysis,
rules, recommendations, and
reports.

Local runtime Read-only source access, local
ledger, incremental scanning, live
refresh, replay and verification.

CLI Commands, diagnostics, reports,
live monitoring, apply/undo and
verification where supported.

Dashboard Interactive local views for
overview, sessions, usage
breakdowns and recommendations.
-----------------------------------------------------------------------

### Suggested project layout

```text
optimaizr-rebuild/
├── package.json
├── tsconfig.base.json
├── packages/
│   ├── core/       # ingestion, providers, pricing, analysis, rules, reports
│   └── local/      # readers, ledger, live, replay
├── apps/
│   ├── cli/
│   └── dashboard/
├── tests/
│   ├── fixtures/
│   └── integration/
└── docs/
```

This is a proposed layout, not a claim that the original has precisely
these directories. Map the real modules and tests from the clone into
this structure; do not blindly copy names.

### Runtime decisions

- Prefer Bun for development where compatible; retain npm as a
  reliable fallback while workspace scripts are being validated.
- Keep TypeScript and ESM, and preserve original package boundaries
  where practical.
- No remote server, authentication, or separate database server is
  required for the first local version.
- Keep source ingestion read-only; the Optimaizr ledger stores derived
  snapshots and state, not a replacement for OpenCode history.

---

## Phase 0 --- Repository reconnaissance and scope

**Difficulty:** 1--2/5\
**Goal:** Understand the original behavior before writing the
replacement.

---

Feature / task Difficulty Deliverable

---

Inspect root scripts 1/5 Build and dependency
and workspaces map

Trace core ingestion 2/5 Data-flow diagram
pipeline

Map providers and 2/5 Source compatibility
database readers matrix

Identify pricing, 2/5 Feature checklist
rules and report  
modules

Identify 1/5 Explicit exclusion
Claude-specific list
integrations

Establish original 2/5 Known-good reference
build/test baseline
------------------------------------------------------------------------

### Implementation steps

1.  Keep the clone as the reference copy and create a separate, empty
    rebuild directory.
2.  Inspect package manifests, exports, source files, tests and README.
3.  Trace one full path: source database → parsed records → normalized
    data → report.
4.  Record each user-facing CLI command and the behavior it promises.

### Phase 0 summary

At the end, have a feature inventory, dependency map, Claude exclusion
list, and clear definitions of session, message, token count, cost and
optimization rule.

**Exit criterion:** You can explain how one OpenCode session becomes an
Optimaizr report.

---

## Phase 1 --- Workspace, build system and shared data model

**Difficulty:** 2--3/5\
**Goal:** Establish a clean project that builds before implementing
product features.

Feature Difficulty Deliverable

---

TypeScript and ESM configuration 2/5 Shared compiler settings
Workspace packages 2/5 `core`, `local`, `cli`, `dashboard`
Shared types 3/5 Session, message, usage, tool event
Configuration and environment 2/5 Local paths and settings
Logging and error conventions 2/5 Consistent diagnostics
Unit test setup 2/5 Fixtures and deterministic tests
Bun/npm workflow 2/5 Repeatable install/build/test

### Implementation steps

- Use TypeScript and ESM, and make Bun the preferred development tool
  where it works.
- Define normalized types for provider, model, session, timestamp,
  token categories, cost and tool events.
- Keep optional source fields optional rather than inventing missing
  data.
- Avoid duplicating business logic across the CLI and dashboard.

### Phase 1 summary

The monorepo builds with shared contracts, tests and repeatable scripts;
the apps can still be empty shells.

**Exit criterion:** A clean checkout installs, typechecks, builds all
packages and runs tests.

Status: complete on 2026-10-22 with the dashboard deferred to Phase 7. The
executed scope and exit record are in `docs/plans/phase-1-completion.md`.

---

## Phase 2 --- Local data ingestion and OpenCode compatibility

**Difficulty:** 4/5\
**Goal:** Read real coding-agent history and convert it into normalized
records.

---

Feature Difficulty Deliverable

---

Read local SQLite 3/5 Read-only access
databases

OpenCode 1.x reader 3/5 `session`, `message`,
`part`

OpenCode 2.x reader 4/5 `session_v2`,
`session_message`

Parse message and 4/5 JSON and tool-event
part payloads normalization

Extract token and 4/5 Provider-reported
cost metadata usage

Session discovery and 3/5 Old and recent
pagination sessions

Mixed-schema handling 4/5 Avoid
duplicate/missing
history

Other original source 3--5/5 Preserve inventoried
readers providers
------------------------------------------------------------------------

### Implementation steps

1.  Detect schema from SQLite metadata instead of assuming one layout.
2.  Parse V2 JSON payloads by record type; normalize into the same
    internal format as V1.
3.  Preserve model/provider identifiers, token usage, cost, timestamps,
    metadata and available tool information.
4.  Handle unknown event types, missing fields, mixed schemas and
    migrated sessions safely.
5.  Never modify the user's OpenCode database.

### Phase 2 summary

Both OpenCode schema generations flow through one normalized interface,
with other original readers implemented according to the Phase 0
inventory.

**Exit criterion:** Fixture tests pass for V1 and V2, and an integration
test reads the real local database without modifying it.

Status: complete on 2026-10-22 (commit `71e5de0`). The executed scope and exit
record are in `docs/plans/phase-2-readers.md`. The two documentation gaps
carried out of Phase 2 were closed at the start of Phase 3 Step 0.

---

## Phase 3 --- Analysis engine, pricing and reporting

**Difficulty:** 4/5\
**Goal:** Turn raw sessions into accurate usage and cost analysis.

Feature Difficulty Deliverable

---

Provider/model pricing registry 3/5 Versioned pricing and units
Token and cost calculations 3/5 Deterministic calculations
Session aggregation 2/5 Usage by session and time
Model/provider breakdown 2/5 Compare model usage
Cache read/write analysis 4/5 Separate cache categories
Repeated-work detection 4/5 Repeated tool operations
Waste/savings estimates 4/5 Evidence-based potential savings
Structured reports 3/5 Reusable output for both UIs

### Implementation steps

- Separate observed cost, estimated cost and potential savings.
- Use provider-reported usage when available; do not invent token
  counts.
- Use model-specific input, output, cache-read and cache-write prices
  where applicable.
- Implement repeated-work detection based on the original behavior,
  not broad claims of semantic equivalence.

### Phase 3 summary

The engine calculates usage and costs, groups sessions, analyzes caching
and produces structured findings independently of the interfaces.

**Exit criterion:** Known fixtures produce deterministic totals and
every cost/savings estimate has an explainable calculation.

Status: complete on 2026-10-22. The executed scope and exit record are in
`docs/plans/phase-3-analysis.md`: every call priced (observed headline, dated
list-price estimate, token-only unpriced), deterministic aggregates, cache
analysis, two explanation-complete repeated-work detectors, a byte-identical
report with data health, and the `npm run analyze --` harness. 76 tests pass;
totals and the $0.759757726 gpt-oss:120b charge reconcile exactly against SQL
on a snapshot, and no state is written. Docs: `docs/analysis.md`,
`docs/pricing.md`, `docs/reports.md`, ADR-0007, updated diagnostics.

---

## Phase 4 --- Optimization rules and actionable recommendations

**Difficulty:** 4--5/5\
**Goal:** Recreate reusable optimization logic without Claude-specific
hooks.

---

Feature Difficulty Deliverable

---

Rule definitions and 2/5 IDs, descriptions,
metadata applicability

Rule evaluation 3/5 Check when a rule
applies

Recommendation 3/5 Evidence and
generation trade-offs

Rule application 4/5 Safe supported
changes

Undo support 4/5 Restore prior state

Replay/verification 5/5 Compare behavior and
usage

Rule-specific tests 3/5 Regression coverage
------------------------------------------------------------------------

### Implementation steps

1.  Separate finding an opportunity from applying a change.
2.  Check integration support, capture original state, validate, apply,
    record and verify.
3.  Clearly mark actions that rely on removed Claude integrations as
    unsupported unless a non-Claude implementation exists.
4.  Build replay abstractions and tests before live API replay; replay
    can incur costs and be nondeterministic.

### Phase 4 summary

The engine evaluates rules and explains recommendations. Its injected
apply/undo seam only handles explicitly supported Munin-owned settings;
current rules have no such mapping, so external-agent actions are queued.
Verification distinguishes measured results from estimates.

**Exit criterion:** Rules are independently tested, unsupported actions
fail clearly, and apply/undo does not silently corrupt configuration.

Status: complete on 2026-10-23. Registry, recommendation/decision state,
verification, apply/undo seams, replay abstractions, tests, and Step 9 docs are
implemented, and the reference-parity audit of the 15 ported detectors passed.
No current rule maps to an applicable Munin-owned optimization setting, so the
apply-success seam remains test-only while external-agent actions queue
(documented in `docs/rules-unsupported.md`).

---

## Phase 5 --- Local runtime, ledger, live monitoring and privacy

**Difficulty:** 4/5\
**Goal:** Make Optimaizr useful during coding, not only for one-time
reports.

---

Feature Difficulty Deliverable

---

Local ledger 3/5 Analysis snapshots
and state

Incremental history 4/5 Process newly
scanning discovered activity

Live monitoring 4/5 Refresh reports as
sessions change

Snapshots 3/5 Compare analysis over
time

Results comparison 3/5 Before/after usage
and trade-offs

Privacy controls 3/5 Document local data
handling

Error recovery 3/5 Locks, missing files,
partial records
------------------------------------------------------------------------

### Implementation steps

- Keep the ledger separate from the source database; store derived
  snapshots, rule actions and verification results.
- Avoid persisting raw prompts unless the original behavior requires
  it.
- Start with polling/incremental scans rather than a complex streaming
  architecture.
- Make repeated scans idempotent so new sessions are not counted
  twice.

### Phase 5 summary

Munin maintains local analysis state, incrementally refreshes reports, compares
snapshots and measures before/after cost per turn or call from the apply
journal. The scan harness supports watch mode, full reconciliation/repair and
privacy checks. Results comparisons remain generic because the current rules
have no Munin-owned apply mapping.

**Status:** Implementation complete; the manual exit check against a disposable
copy of the local OpenCode database (new-session discovery and restart resume)
is still pending. The integration tests cover the same behavior with SQLite
fixtures, but Phase 5 is not marked complete until the manual check is run.

**Exit criterion:** A new OpenCode session is discovered without a
restart, and repeated scans do not double-count usage.

Plan: `docs/plans/phase-5-runtime.md` (local ledger, incremental
scanning with watermark cursors, watch loop, snapshots and trends,
results comparison port, privacy checks, error recovery).

---

## Phase 6 --- CLI and commands

**Difficulty:** 3--5/5\
**Goal:** Recreate the original command-line experience on top of the
shared engine.

---

Feature Difficulty Deliverable

---

Main report command 2/5 Usage and waste
summary

`help` and `status` 1/5 Help and environment
checks

`sessions` and `why` 2/5 Session listing and
explanation

`live` 3/5 Continuous local
monitoring

`results` 2/5 Before/after
comparison

`apply` and `undo` 4/5 Supported rule
actions

`verify` 5/5 Verification/replay

`card` and output 2/5 Compact readable
formatting reports

`guard` (OpenCode plugin) 4/5 Holds a costly tool
action once;
`guard list`

`statusline` (CLI plugin) 3/5 Cost/token line in
OpenCode's TUI
footer
-------------------------------------------------------------------------

### Guard and statusline findings (researched 2026-10-23)

Feasibility is confirmed against OpenCode 2.x documentation, with one open
question. Both features ship as one npm plugin package with two entries:
the server plugin listed in `opencode.json(c)` `plugins`, and the
terminal plugin (`./tui` export) listed in `cli.json` `plugins`.
`munin guard on|off` and `munin statusline on|off` edit those config
files the same way the reference installs Claude Code hooks, and
receipts and state live under `MUNIN_DIR`.

- **Guard** runs in the OpenCode server. Its holds use the permission
  `evaluate` hook: guard changes an `allow` decision to `ask` with a cost
  message, and OpenCode's own prompt provides the "allow once, then go
  through" flow. Explicit user `deny` rules stay final. Failed tool calls
  are recorded with `tool.execute.after` plus plugin storage, which
  replaces the reference's `marks.json`.
- **First cut catches tool actions only:** whole-file reads over the
  size threshold and a third identical failing shell command. The
  cold-cache message hold is the one unverified piece: OpenCode's
  session prompt hook has no typed rejection, so a one-hour spike must
  check whether throwing in the hook aborts admission cleanly. If it
  does not, guard v1 warns through live and statusline instead of
  holding.
- **Statusline** renders in an OpenCode TUI slot (`prompt.footer.status`
  for the first cut) and reads session data from the plugin's reactive
  client APIs, not by polling the database. It can show: session context
  size and re-read cost, cache countdown, this-turn cost, duration and
  request count, cheaper-model hint, a user-configured budget percentage
  (not the Claude 5-hour window), and guard status. Token counts in
  client data need verification; the fallback is a usage recorder in the
  same package's server entry.
- **`live` is unchanged:** a standalone TUI polling the OpenCode
  database (the same DB-cursor design as the parity matrix). No plugin.
  The split is: statusline inside the session you type in, live across
  all open conversations.

### Implementation steps

1.  Implement the main report, help/status and sessions first.
2.  Add why/results, then live monitoring.
3.  Add apply/undo and verify after rule behavior is safe.
4.  Use the original CLI inventory to determine exact command semantics;
    do not invent parity.

### Phase 6 summary

The local CLI reads supported sources, analyzes usage and exposes
reusable features without duplicating the engine.

**Exit criterion:** A user can build the project and get a useful report
from actual local history.

---

## Phase 7 --- Interactive local dashboard

**Difficulty:** 4/5\
**Goal:** Add a dashboard as a second interface to the same engine.

Feature Difficulty Deliverable

---

Local dashboard server 3/5 Serve UI on localhost
Overview page 2/5 Cost, tokens, sessions, trends
Usage charts 2/5 By model and time
Session explorer 3/5 Search, filter, inspect
Cost breakdown 2/5 Provider, model, token category
Optimization recommendations 3/5 Evidence and impact
Rule action controls 4/5 Supported apply/undo/verify
Live refresh 3/5 Update session data
Local security 3/5 Bind locally and validate actions

### Implementation steps

- Use a lightweight UI (for example React + Vite) with the shared core
  contracts.
- Build Overview, Sessions and Optimization pages.
- Expose only a restricted set of local read/action endpoints.
- Bind to localhost, validate action inputs, avoid arbitrary
  filesystem/shell access, and minimize raw prompt exposure.

### Phase 7 summary

CLI and dashboard display the same data and recommendations; supported
actions go through the same rule engine.

**Exit criterion:** The dashboard shows real local data and its totals
agree with the CLI.

---

## Phase 8 --- Integration, regression tests and release readiness

**Difficulty:** 4/5\
**Goal:** Make the rebuilt tool reliable to demonstrate and continue
developing.

Feature Difficulty Deliverable

---

V1/V2 regression fixtures 3/5 Both OpenCode schemas
Cross-package integration tests 4/5 Reader → engine → UI
CLI end-to-end tests 3/5 Commands and exit codes
Dashboard integration tests 3/5 Loading, filters, errors
Pricing/calculation tests 3/5 Known totals
Rule apply/undo tests 4/5 Safe state restoration
Live-monitor tests 4/5 New records and deduplication
Build/runtime checks 2/5 Bun/npm workflows
Documentation 2/5 Setup, commands, limitations

### Implementation steps

- Test clean installs and builds, not only your existing working
  directory.
- Verify that ingestion never writes to source history.
- Check that CLI and dashboard totals match.
- Document unsupported providers, actions and any remaining feature
  gaps.

### Phase 8 summary

The tool has reproducible build steps, documented limitations, and
integration coverage across readers, core, CLI and dashboard.

**Exit criterion:** The app can be demonstrated from a clean checkout
without undocumented machine-specific state.

---

## 9. Difficulty overview

Relative engineering complexity, not estimated hours. Highest-risk work
is data parsing, accounting accuracy, safe actions, and incremental
monitoring---not the dashboard charts.

---

Feature area Difficulty Main risk

---

Workspace/build 2/5 Script compatibility
across npm and Bun

Data readers 4/5 Schema variation,
missing fields, mixed
V1/V2 history

Analysis/pricing 4/5 Cache pricing and
missing usage metadata

Rules/apply/undo 4/5 Integration-specific
behavior and safe
rollback

Live 4/5 Concurrency and
monitoring/ledger duplicate prevention

CLI 3/5 Exact command parity

Dashboard 4/5 Local security and
consistent shared data

Replay/verification 5/5 Cost, credentials and
nondeterministic
outcomes
-------------------------------------------------------------------------

---

## 10. Suggested 24-hour execution schedule

---

Time Focus Deliverable

---

Hours 0--2 Reconnaissance and Map modules; create
foundation workspace; establish
build/tests.

Hours 2--6 Ingestion and OpenCode Normalize V1/V2 and
V2 validate against real
local data.

Hours 6--10 Analysis and pricing Token/cost totals,
sessions, caching and
repeated-work findings.

Hours 10--13 CLI and reports Get the core commands
working end-to-end.

Hours 13--17 Dashboard MVP Overview, session list,
cost charts,
recommendations.

Hours 17--20 Rules and live updates Supported actions, undo
and incremental
refresh.

Hours 20--24 Integration and demo Regression tests,
fixes, docs and a
reliable demo.
-----------------------------------------------------------------------

This is aggressive, not a guarantee. If time slips, prioritize a working
reader, accurate analysis, CLI, and dashboard overview. Move replay
verification, advanced rule actions, and full parity across every
provider to follow-up work. Do not fake unfinished features in the demo.

---

## 11. Final acceptance checklist

- [ ] Clean checkout builds successfully.
- [ ] OpenCode 1.x history is supported.
- [ ] OpenCode 2.x history is supported.
- [ ] Token counts and costs pass fixture tests.
- [ ] Repeated-work findings are explainable.
- [ ] Supported rules can be applied and undone safely.
- [ ] Ingestion never modifies local source history.
- [ ] CLI and dashboard agree on session totals.
- [ ] Live refresh avoids duplicate records.
- [ ] Claude-specific mods are excluded.
- [ ] Remaining unsupported features are documented.

---

## 12. Overall summary --- planned project contents

---

Repository capability Planned outcome

---

`packages/core` Rebuilt analysis engine, pricing,
ingestion contracts, rules and
reports.

`packages/local` Local readers, ledger, live
monitoring and replay/verification
support.

OpenCode reader V1 retained; V2 added; mixed
schemas handled without duplicate
usage.

Other source readers Reimplemented according to the
original source inventory.

Analytics Token/cost usage, cache analysis,
session summaries and waste
estimates.

Optimization engine Rule evaluation, recommendations
and supported apply/undo.

Results/verification Before/after comparisons and replay
where feasible.

`apps/cli` Rebuilt CLI command interface.

Claude-specific mods Excluded, including Claude-specific
hooks and statusline integrations.

Dashboard New interactive local dashboard
using the same core engine.

Local-first behavior Preserved, with any optional
network-dependent verification
documented.
-----------------------------------------------------------------------

**Definition of done:** "Recreated" means a feature is implemented and
tested, not merely represented by a command or screen. Claude-dependent
behavior remains excluded unless a meaningful non-Claude implementation
exists. Verify every claimed capability against the original source
before marking it complete.

**Immediate next step:** Complete Phase 0. Inspect the actual source
files and tests, turn the original modules into a checklist, and then
start the new folder. This prevents building a simplified imitation that
misses important original functionality.
