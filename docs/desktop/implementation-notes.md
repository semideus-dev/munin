# Desktop implementation notes — Phases 0–2

Baseline commit: `f655f03` ("phase 6: safepoint"), branch `main`, working tree clean at
inspection time. This file records what the checkout actually contains, what the baseline
commands do, and the Electron runtime compatibility result. Phases 1–2 append the
shared application service and the Electron shell; later phases update it.

## 1. Verified baseline commands

Run on the repo's declared toolchain (`.nvmrc` = `24`, resolved to Node v24.22.1):

| Command                | Result                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `npm run build`        | PASS (core, local, cli via `tsc`)                                      |
| `npm run typecheck`    | PASS (pre-build runs `build` first, then `tsc --noEmit` per workspace) |
| `npm test`             | PASS — 146/146 tests (`node --test`, `pretest` builds first)           |
| `npm run format:check` | FAIL — 25 pre-existing files, unrelated to desktop work (list below)   |

Notes:

- `node_modules/` was absent on first checkout; `npm install` (7 packages) restored it.
  The build failure before that (`TS2688: Cannot find type definition file for 'node'`)
  was purely the missing install, not a source defect.
- **Node version matters.** With linuxbrew Node v23.5.0 in `PATH`, `npm test` reports
  123/146: every `node:sqlite` usage emits `ExperimentalWarning` on stderr under Node 23,
  which the CLI-dispatch tests assert must be empty, and the v1/v2 fixture tests fail to
  detect a schema. Under Node 24 (the `.nvmrc` version) all 146 pass. The failures are
  environmental, not regressions; use Node 24 (`nvm use`) for all work in this repo.
- Pre-existing `format:check` offenders: `docs/catch-up.md`, `docs/parity-matrix.md`,
  `packages/core/src/analyze/rules/ported.ts`, `packages/core/src/ledger/cursor.ts`,
  `packages/core/src/normalize/{merge,opencode-v1,opencode-v2,reconcile,text}.ts`,
  `packages/local/src/readers/{instructions,opencode-v1,opencode-v2,schema}.ts`,
  11 files under `tests/` (incl. `tests/fixtures/opencode-db.mjs` and one snapshot JSON).
  Decision: left untouched in Phase 0 (no unrelated edits); revisit at Phase 9.

## 2. Runtime compatibility: Electron can run the existing SQLite reader

Isolated spike (kept outside the repo at `/tmp/opencode/electron-spike`, Electron installed
from npm, no repo changes):

- Electron **45.0.0** (npm `latest`) bundles Node **24.22.0** — same major/minor as the
  repo toolchain, so `node:sqlite` semantics match the tested CLI environment.
- `require("node:sqlite")` inside the Electron **main process**: available, no flag, no
  experimental warning. `DatabaseSync` create/insert/select: PASS.
- Static import of the workspace's built ESM (`packages/local/dist/index.js`) inside
  Electron main: PASS.
- Full read path: `readDataset({ db: <real opencode.db> })` inside Electron main returned
  `schema: "mixed"`, 5 sessions, 194 messages, warnings `source.mixed-schema`,
  `source.aggregate-mismatch`.
- Source file stat before/after the read: mtime, size and inode **unchanged**.
- Result line: `{"electron":"45.0.0","node":"24.22.0","sqliteBuiltin":true,"sqliteWorks":true,"localReaderLoaded":true,"readDatasetOk":true,"sourceUnchanged":true}`.

Conclusion: no compatibility blocker. The desktop main process can import `@munin/local`
directly and use `node:sqlite` on Electron 45. Packaged-app verification happens in Phase 9.
Display server available for GUI tests: X11 (`DISPLAY=:0`); no Wayland session on this machine.

## 3. Actual reusable APIs (confirmed by reading source, not docs)

### `@munin/core` (pure engine, no fs/net)

- `buildReport(dataset, { zone, detectors?, decisions? }) -> MuninReport` — the single
  report path. `buildEvents(dataset) -> PricedDataset` (events + attempts + window +
  warnings). `buildLedgerReport(events, opts)` rebuilds from ledger events.
- `MuninReport`: `formatVersion, method, pricingAsOf, pricingVersion, timeZone, window,
totals, byModel, byProvider, byProject, byDay, bySession, byAgent, cache, sessions,
findings, recommendations, savings, dataHealth` — fully JSON-serialisable by contract.
- Totals keep `headlineUsd` / `observedUsd` / `estimatedUsd` distinct; `totalTokens`
  excludes thinking (thinking is inside priced `outputTokens`). `observedCoverage`,
  `unpricedCalls`, `unpricedModels`, `cacheHitRate`, `thinkingShare` are report fields.
- `savings`: `fix`, `try`, `test`, `all` (`TierSavings` = tiers, claimedCalls, windowUsd,
  monthlyUsd, annualUsd) plus `tokensWasted`, `pricedTokensWasted`, `unpricedTokensWasted`,
  `unpricedFindings`. `windowDays`/`projectionDays` describe the basis.
- `ReportFinding` (serialised): rule, category, title, detail, why, tier, savings
  (`SavingsEstimate` with evidence/calculation/assumptions/confidence/…), affected, impact,
  severity, risk, verification, advisory, observations, fix, optional `candidate`,
  `claimByEvent[]`, optional `overlapWith[]`. Confidence is ordinal (`low|medium|high`).
- `SessionSummary` rows are already in the report (`report.sessions`), parent/subagent
  distinction via `isSubagent`, `parentSessionId` is on the session records.
- `PricedDataset.attempts: CallAttempt[]` — every assistant/compaction attempt incl.
  failures (`usage?`, `errorType?`, `stopReason?`); `events: UsageEvent[]` are billed only.
- `dataHealth`: clean, schema, sources, sessions, subagentSessions, messages, modelCalls,
  failedCalls, compactions, warnings, unpricedModels, observedCoverage, reconciliation,
  projectLabelCollisions, detectorErrors, instruction, optional `ledger`.
- Privacy: `BANNED_KEYS`, `assertNoBannedKeys(value)` in `ledger/slices.ts`; validator is
  already invoked by ledger schemas and by `runScan({ checkPrivacy: true })`.
- `MuninError({ code, kind, message })` is the expected-failure type; `WARNING_CODES` is
  the frozen warning-code table.
- Decisions seam: `recordDecision(store, rule, status, at, note?)` + `DecisionStore`
  interface in `analyze/recommend.ts`; `buildReport(..., { decisions })` accepts them.
  **No filesystem-backed DecisionStore exists anywhere yet** (only an injected test double).
  The path `~/.munin/decisions.json` is reserved in `local/paths.ts`.

### `@munin/local` (only package allowed to touch fs/SQLite/OS)

- `loadConfig({ db?, stateDir?, ... }) -> { paths, dbPath, dbOrigin, settings, warnings }`;
  origin is `flag | env | settings | default`. `inspectSourceDatabase(path) -> ready |
missing | unreadable`.
- `readDataset(options) -> Dataset` — read-only handle (`readOnly: true`, `busy_timeout`,
  `query_only=ON`); missing/unreadable DB degrade to warnings, never throw.
- `runScan(options) -> ScanResult` (mode, sessionsRead, slicesReplaced, new/replaced ids,
  totals, findings, report, snapshot, `snapshotDiff`, cursor, warnings, reconciliation,
  repaired). Scan lock contention throws "Another Munin scan holds the lock".
- `readScanSnapshots()` — **full snapshot history** + latest `SnapshotDiff` + skippedLines.
  `readScanResults()` — applied changes + `measureResults` verdict (works with an empty
  journal: shows a no-data state).
- `createScanWatcher(options)` — `.poll() -> WatchPollResult` of kinds `unchanged | busy |
warning | scan`; fingerprint-based (dev/ino/size/mtime), auto full-rescan when the source
  is replaced/shrunk/time-went-back. This is the one polling algorithm to reuse.
- `openMuninConfigStore(path)` — restricted config writer: only `days` and `tz` keys, with
  validation. Safe existing write API for settings (Phase 8).
- `openLedgerStore(paths)` — `readSlices`, `readSnapshots`, `appendSlice/Snapshot`,
  `rewriteSlices`, `auditPrivacy` (strict post-write privacy audit).
- `openChangesStore`, `readScanCursor`, `acquireScanLock` all exported.

### CLI (`apps/cli`) — orchestration seam, not an API

- `apps/cli/src/data.ts` is the entire read orchestration: `loadConfig` → `readDataset`
  (`sinceDays` only when `--days` given) → project substring filter → `buildEvents` →
  `buildReport(dataset, { zone })` → `{ config, dataset, priced, report, warnings, tz }`.
  This is the logic to extract into a shared package in Phase 1; the CLI must keep
  delegating to it so `--json` output stays byte-stable.
- Defaults to preserve: **days** = flag only (no implicit 7-day window; `settings.days` is
  currently read but unused by report commands); **tz** = `--tz` else `UTC` for report
  reads (`runScan` alone falls back to `settings.tz`); **project** = case-insensitive
  substring over label/id/directory; **db/state-dir** precedence flag > `MUNIN_DB` >
  `config.json` > XDG default.
- JSON envelope: `{ ok: true, data, warnings }` / `{ ok: false, error: { code, message } }`.
- Wired handlers: profile, scan, sessions, live(watch), why, tokens, waste, show,
  providers, privacy, help. **Registered but NOT wired** (exit 2 `cli.not-implemented`):
  apply, undo, results, verify, guard, statusline, report, card, simulate. Per the plan,
  none of these may appear as controls in the GUI.

## 4. Boundaries and risks found

- Report reads (`loadData`) go straight to the source DB and write nothing; scans write
  only Munin state. GUI read-only methods should use the `loadData` path so navigation
  never mutates anything (rule 10/5).
- `runScan` requires session `timeUpdated` watermarks not in the future, and appends
  snapshots; GUI must call it only on explicit action or watcher ticks.
- `createScanWatcher` holds `inFlight` only during `poll()`; it is synchronous. One owner
  in the Electron main process, one instance, restart-safe.
- ADR-0006 documents a deferred Next.js dashboard decision; this desktop plan supersedes
  that scheduling (separate process, same engine). Keep the ADR unless a new one is written.
- Repo docs (`docs/plans/*`, `GLOSSARY.md`, `AGENTS.md` issue tracker under `.scratch/`)
  exist; follow their conventions for new docs.

## 5. Phase 1 — the shared application service (`packages/application`)

Created `@munin/application` as the one read path for every front end. It contains no
analysis; it resolves options, reads, filters, prices and reports through `@munin/core` /
`@munin/local`, then maps the result onto presentation DTOs.

- `context.ts` — `loadReadContext(options, extras)` = `loadConfig` → `readDataset`
  (`sinceDays` only when `days` is supplied) → project substring filter → `buildEvents` →
  `buildReport(dataset, { zone })`. Defaults match the CLI exactly: no implicit window,
  `UTC` day zone, project filter over label/id/directory. `normalizeReadOptions` rejects
  non-positive/non-integer `days`, empty `project`/`tz` with `request.invalid` (usage).
- `errors.ts` — the only boundary error shape, `ServiceErrorDTO { code, kind, message }`.
  `toServiceError` maps `MuninError` directly; unknown failures become a fixed
  `internal` message and are logged in the host. `toScanError` is the scan mapping the CLI
  used to own (fatal `[code] message` warnings, lock contention, stale-lock cleanup).
- `service.ts` — `createMuninService({ now, onEvent })` implementing the full contract:
  `getSourceStatus`, `getOverview`, `getFullReport`, `getFindings`, `getFinding`,
  `getUsage`, `getSessions`, `getSessionDetail`, `getActivity`, `getHealth`, `runScan`,
  `startMonitoring`, `stopMonitoring`, `getPrivacyStatus`. Read contexts are memoised by
  options + source fingerprint (dev/ino/size/mtime); reads never scan or write. One
  watcher instance, `intervalMs` ≥ 500 (default 2000), start/stop idempotent, timer
  `unref()`ed. `runScan` refuses re-entry with `state.lock-held`.
- `dto/*` — plain JSON contracts. `OverviewDTO` forwards `Totals`, tariff tiers and data
  health and adds field-selected groups only. `UsageOverviewDTO` forwards every aggregate
  and adds a session timeline projected from `PricedDataset` (no prompts, bodies, tool
  inputs/results). `FindingDetailDTO` joins claims to calls using report claims, never new
  arithmetic. `ActivityDTO` exposes scanner status, runtime last scan/error, monitoring
  state, full snapshot history and the apply-journal results (or `null`, never a
  fabricated empty report). `HealthDTO`/`PrivacyDTO` expose config/source/pricing/ledger
  and run the existing strict `auditPrivacy` validator.
- DTO keys avoid the ledger's banned names (`text`, `summary`, `content`, `state`,
  `output`, `prompt`, `oldString`): `SessionDetailDTO.session`, `ActivityDTO.status`,
  `ScanDTO.status`, and token fields are `inputTokens`/`outputTokens`/….
- CLI delegation: `apps/cli/src/data.ts` now calls `loadReadContext(readOptionsOf(args))`
  and `scan-support.ts` calls `toScanError`. Flag parsing, defaults and the JSON envelope
  are unchanged.

### Parity verification method

The live OpenCode DB cannot be used for byte parity: this agent itself writes to it while
working. Instead:

1. A detached worktree of `HEAD` (`f655f03`) was built at `/tmp/opencode/munin-baseline`
   as the "before" build.
2. A frozen copy of the real DB was made with `VACUUM INTO` (`/tmp/opencode/parity/real-frozen.db`).
3. Both builds ran the same capture script over fixed fixture paths and the frozen DB:
   `profile`, `sessions`, `why`, `tokens`, `waste`, `show`, `providers`, `privacy`,
   `scan --full`, incremental scan, `--days`, `--project`, `--tz`, findings, missing DB,
   and six real-DB reads.
4. A comparer normalised ISO timestamps only and deep-compared 22 captures.

Result: **22/22 identical** (same exit status, stdout, stderr) — including scan journals,
missing-DB errors and the real database.

Tests: `tests/unit/application-service.test.mjs` (10 tests) pins DTO/report equality,
thinking-is-priced-output (no double count), failed attempts distinct from billed events,
no leaked fixture bodies/banned keys, source bytes unchanged and zero ledger files after
reads, cache invalidation on source change, missing/unreadable states, scan + activity,
lock contention, monitoring idempotence, error safety and the privacy audit.
`npm test`: **156/156** (146 baseline + 10). `typecheck` passes; new files are Prettier-clean.

## 6. Phase 2 — Electron workspace, security and the typed bridge

`apps/desktop` is a new workspace (`@munin/desktop`) built with Electron 45.0.0, React 19,
Vite 7 and TypeScript; the preload is bundled to CommonJS with esbuild.

- Main (`src/main/index.ts`) imports the real `createMuninService` from
  `@munin/application` (no CLI parsing, no reimplementation). It registers only three
  read channels — `munin:overview`, `munin:source-status`, `munin:health`. No scan,
  apply, monitoring or settings channel exists yet.
- Window: 400×600, min 360×480, dark background, `show: false` until `ready-to-show`,
  `autoHideMenuBar`, single instance, close hides to tray (quit via tray), second launch
  restores the window. Background work never shows or focuses the window.
- Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, `allowRunningInsecureContent: false`, `devTools` only when
  unpackaged, no application menu, `setWindowOpenHandler` denies every window,
  `will-navigate`/`will-attach-webview` are restricted, permission request/check handlers
  deny everything, and the renderer HTML carries a restrictive CSP (`default-src 'none'`,
  scripts only from self). The preload exposes exactly the three typed read methods —
  no generic `invoke`, no Node globals.
- IPC results are `{ ok: true, data }` or `{ ok: false, error: ServiceErrorDTO }`.
  `sanitizeReadRequest` accepts only `days` (positive integer), `project` and `tz`
  (non-empty strings); unknown keys are rejected. Sender frames must be the built
  renderer or the configured Vite origin (`isTrustedRendererUrl`).
- Renderer: compact dark Overview with source badge/schema, report window, headline and
  observed/estimated split, call/session/turn counts, observed coverage, unpriced-call
  note, token composition (with "output includes thinking" note), the four distinct
  savings tiers, top finding from core's ranking, data health/warnings, resolved source
  path and footer. Loading and error states; Retry re-invokes the real read. No charts,
  no fake data, no placeholder controls.
- `getPrivacyStatus` and the write/scan paths are implemented in the service but not yet
  exposed over IPC (later phases).
- Dev tooling: `npm run dev:renderer` (Vite at 127.0.0.1:5173) and
  `npm run dev:app` (`MUNIN_DESKTOP_DEV_URL` set) from `apps/desktop`.

### Verification

- `npm run build` (all workspaces) and `npm run typecheck` pass on Node 24.22.1.
- Service smoke inside Electron against a frozen real DB:
  `SMOKE_RESULT {"ok":true,"electron":"45.0.0","node":"24.22.0","sourceStatus":"ready","sourceSchema":"mixed","calls":161,"sessions":4,"headlineUsd":0,"healthHasData":true,"activityStatus":"idle","snapshots":0}` —
  proves Electron main + `node:sqlite` + the shared service.
- Hidden-window UI smoke (preload → IPC → renderer) returned real text: `HEADLINE COST
$0.00`, `Calls 161`, `Sessions 4`, `Total 11,890,772`, savings tiers, and `SMOKE_UI
{"ok":true,...}`. A `capturePage` screenshot rendered correctly at 400×600.
- `tests/unit/desktop-ipc.test.mjs` (3 tests) pins the channel list, request validation and
  URL trust (sibling-prefix and host-suffix attacks refused). `npm test`: **159/159**.

Smoke commands (run from `apps/desktop`, with `MUNIN_DB` pointing at a DB):
`MUNIN_DESKTOP_SMOKE=1 ../../node_modules/.bin/electron .` and
`MUNIN_DESKTOP_SMOKE=1 MUNIN_DESKTOP_SMOKE_UI=1 ../../node_modules/.bin/electron .`
(optional `MUNIN_DESKTOP_SMOKE_SCREENSHOT=/path.png` captures the frame). These paths are
environment-gated and never run for a normal launch.

### Known limits at the end of Phase 2

- The four-tab shell (Overview/Optimize/Usage/Activity & Health), findings/usage/activity
  views and monitoring controls arrive in later phases; today the window renders the real
  Overview only.
- No packaging/installer yet; the Electron binary is downloaded by `npm install`'s
  dependency install step in development (the repo's npm config gates install scripts, so
  run `node node_modules/electron/install.js` once if `electron/dist` is absent).
- Recommendation decisions remain read-only (`buildReport` supports `decisions`; the
  filesystem `DecisionStore` is still deferred to Phase 5).
