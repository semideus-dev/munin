# Phase 1 completion plan

Status: complete (closed 2026-10-22)
Owner: team
Scope: finish Phase 1 of `docs/project.md` without the dashboard
Estimated effort: 3 to 3.5 hours (hackathon scope: harness plus three tests, no CI)

## Context

Phase 1 established the build and the shared contracts. Done so far:

- npm workspace: `packages/core`, `packages/local`, `apps/cli`
- strict TypeScript, ESM, Node 24, `npm ci` based workflow
- shared domain model (`domain/source.ts`, `domain/usage.ts`)
- configuration module (`local/src/config.ts`) with DB and state resolution

Still open: cross-platform hardening of that config, diagnostics conventions, a real test harness, and a clean-checkout proof.

## Scope change: dashboard deferred

`docs/project.md` lists `apps/dashboard` as a Phase 1 workspace and the Phase 1 exit criterion says "builds all packages". The team decided to defer the dashboard to the end of the build (Phase 7). Phase 1 therefore exits with three packages, and the dashboard workspace is created when Phase 7 starts.

Recorded in:

- this plan
- `docs/parity-matrix.md` (dashboard rows marked deferred)
- `docs/adr/0006-next-dashboard.md` (decision unchanged, scheduling note added)

Revised Phase 1 exit criterion:

> A clean checkout installs, typechecks, builds `core`, `local` and `cli`, and runs real tests that can fail.

## Constraint: the team is cross-platform

Munin must work on macOS, Linux and Windows. Most of the risk is path handling, not SQLite. Verified facts about OpenCode 2.1.2, from its bundled source:

- Its data root is `XDG_DATA_HOME || <home>/.local/share`, **on every platform**, including Windows. There is no `%LOCALAPPDATA%` branch for session data.
- Its config root is `XDG_CONFIG_HOME || <home>/.config`, on every platform.
- `<home>` is `os.homedir()`. `HOME` is not consulted directly.

Consequences:

- Do **not** invent a `%LOCALAPPDATA%\opencode` default; it would be wrong on Windows.
- Do **not** trust `HOME` for home resolution. Git Bash on Windows sets `HOME=/c/Users/...`, which is not a native path and breaks `path.join`.
- `%LOCALAPPDATA%` appears in the binary only inside third-party Google auth code, not OpenCode's own path resolver.

Re-verify these two facts on a Windows machine before release; treat them as a checked assumption, not folklore.

---

## Step 1: Cross-platform configuration rework

Files: `packages/local/src/config.ts`, `packages/local/src/paths.ts` (new), tests later.

Current gaps:

1. `homeDir()` prefers `env.HOME`, which is wrong on Windows and under Git Bash.
2. Platform-specific behavior cannot be unit-tested away from macOS.
3. `XDG_DATA_HOME` handling uses the runtime `path` implementation only.

Work:

- Extract a pure path resolver into `local/src/paths.ts`:

  ```ts
  interface HomeInputs {
    platform: NodeJS.Platform;
    home: string;
    xdgDataHome?: string;
    envDb?: string;
    envStateDir?: string;
    stateDirOverride?: string;
  }
  ```

  It returns `{ stateDir, defaultDbPath, settingsPath, ledger }` using `path.win32` when `platform === "win32"` and `path.posix` otherwise, so Windows rules are tested on any machine.

- Home resolution: `os.homedir()` by default; an explicit `home` option for tests. Remove the `HOME` preference.
- `XDG_DATA_HOME` accepted only when absolute **for the given platform** (`win32.isAbsolute` on Windows). Relative values fall back to the default.
- Default DB: `<dataHome>/opencode/opencode.db`, where dataHome is `XDG_DATA_HOME` or `<home>/.local/share`.
- State root: `MUNIN_DIR` or `<home>/.munin`.
- Empty env values are treated as unset (`MUNIN_DB=""`, `MUNIN_DIR=""`).
- Relative `MUNIN_DB` resolves against the process cwd; relative `config.json` `db` resolves against the state dir. Document both.
- Never expand `~`; document that the shell does it.
- Keep `loadSettings` and `inspectSourceDatabase` behavior; they already return typed results and warnings.

Acceptance:

- `resolvePaths` uses no platform globals except an injected default.
- Unit tests (Step 3) cover win32, darwin and linux defaults, `XDG_DATA_HOME` absolute vs relative, `MUNIN_DB` vs `--db` precedence, and a Git-Bash-style `HOME` being ignored.
- Existing manual behavior on macOS remains unchanged.

## Step 2: Diagnostics and error conventions

Files: `packages/core/src/diagnostics.ts` (new), `apps/cli/src/exit.ts` (new), `docs/diagnostics.md` (new).

Decide and implement once, so every later command is consistent:

- **Streams:** data to stdout, diagnostics and warnings to stderr. `--json` keeps stdout pure JSON.
- **Exit codes:** `0` success, `1` runtime error (missing DB, unreadable file), `2` unsupported or not automatable (for example `apply` on a behavioural rule), `64` usage error (unknown flag). Document each.
- **Error shape:** `MuninError` with `code`, `message`, and `kind` (`usage | config | source | ledger | action`). One mapping from `kind`/code to exit code, in the CLI only.
- **JSON errors:** `{ "ok": false, "error": { "code": "...", "message": "..." } }`; success is `{ "ok": true, "data": ... }`.
- **Stack traces:** never for expected failures. `MUNIN_DEBUG=1` prints the stack.
- **Warning codes:** a frozen registry so tests and docs cannot drift. Start with the codes already emitted by config: `config.unreadable`, `config.unparseable`, `config.invalid`, `config.invalid-db`, `config.invalid-days`, `config.invalid-tz`. Phase 2 adds `source.*`.
- **Plain text rules:** no em dashes, no emoji, no box drawing. Colour only when stdout is a TTY, `NO_COLOR` is unset, and `TERM` is not `dumb`. Windows consoles without ANSI must still read correctly.
- **Aggregation:** repeated warnings of the same code carry a `count`, not N lines.

Acceptance:

- `docs/diagnostics.md` lists codes, exit codes, and JSON shapes.
- `MuninError` and `WARNING_CODES` are exported from core.
- No command prints a stack trace for an expected error.

## Step 3: Test harness (three tests, hackathon scope)

Files: `tests/unit/*.test.mjs` (new), root `package.json` scripts.

- Use `node --test` against built output. No extra framework, no fixtures module yet.
- Root scripts:

  ```json
  "pretest": "npm run build",
  "test": "node --test"
  ```

  Bare `node --test` discovers `tests/unit/*.test.mjs` recursively without shell globs, which differ on Windows.

- Exactly three tests:
  1. **Platform path matrix**: win32, darwin and linux defaults through the pure resolver, including `XDG_DATA_HOME` absolute vs relative.
  2. **DB precedence**: `--db` beats `MUNIN_DB` beats `config.json db` beats the default.
  3. **Cost basis**: `CostCalculation.total` follows `basis` (observed vs estimated) in core.
- Assert that a failing test exits non-zero; delete the current vacuous pass.
- Deliberately not tested yet: exit-code mapping, warning registry, `inspectSourceDatabase` states, fixtures for the reader. Those arrive with the code that needs them.

Acceptance:

- `npm test` prints real results and fails when a test fails.
- The Windows assertions run on any machine through the pure resolver.
- `npm test` needs no network and never reads the user's real database.

## Step 4: Portability hardening (minimal)

Files: `.gitattributes` (new), `package.json`, `README.md` (Windows notes land in Step 5).

- `.gitattributes`: `* text=auto eol=lf`, plus `*.db binary` and `*.png binary`. This stops Windows checkouts from rewriting scripts and fixtures.
- No shell syntax in npm scripts. Audit every `scripts` entry for `rm`, `cp`, or `&&` chains that assume a POSIX shell; use Node one-liners or separate scripts instead.
- Skip CI for now. The repo has no remote, and a workflow that never runs is theatre. Revisit in Phase 8 if the project is pushed.

Acceptance:

- `.gitattributes` present and committed.
- `grep` over npm scripts finds no POSIX-only commands.

## Step 5: README and clean-checkout proof

Files: `README.md` (new).

README covers: what Munin is, current status (Phase 1, no commands yet), prerequisites, install/build/test, environment variables (`MUNIN_DB`, `MUNIN_DIR`, `XDG_DATA_HOME`), data and privacy stance, Windows notes, and a pointer to `docs/parity-matrix.md`.

Clean check on macOS:

```bash
rm -rf node_modules packages/*/dist apps/*/dist
npm ci
npm run typecheck
npm run build
npm test
```

Windows equivalent:

```powershell
Remove-Item -Recurse -Force node_modules, packages/core/dist, packages/local/dist, apps/cli/dist
npm ci
npm run typecheck
npm run build
npm test
```

Acceptance:

- Both command sets documented and at least one executed successfully.
- No machine-specific path or cached artifact is required.
- `git status` clean after install/build/test apart from ignored files.

## Step 6: Phase 1 exit review

- [x] Config resolves correctly on win32, darwin, linux (unit-proven)
- [x] Diagnostics documented and enforced (`MuninError`, `WARNING_CODES`, `apps/cli/src/exit.ts`)
- [x] `npm test` runs real tests and fails on failure
- [x] `.gitattributes` and portable scripts
- [x] README with Windows notes
- [x] Clean checkout installs, typechecks, builds three packages, tests green
- [x] Dashboard deferral recorded in the plan, parity matrix, ADR-0006 note
- [x] Nothing from Phase 2 leaked in (no DB opened, no V2 parsing, no pricing)

Exit record, macOS with Node 24.21 and npm 11.19:

- `rm -rf node_modules packages/*/dist apps/*/dist && npm ci` succeeded
- `npm run typecheck` green (it builds first, so a fresh checkout works)
- `npm test` 3 passed, 0 failed; a deliberate failure exited `1`
- `node apps/cli/dist/cli.js --version` printed `0.1.0`

Windows caveat: path rules are unit-proven through the win32 resolver, but a
manual run on a Windows machine is still recommended before release.

Then Phase 2 starts: V2 reader `opencode-v2.ts`, schema detection, instruction hashes, and the first real scan against a local database.

## Out of scope for this plan

- Dashboard workspace and UI
- Opening or reading the source database
- Pricing, rules, reports, CLI commands
- Ledger writes and live polling
- Replay/verification

## Risks

- **Windows SQLite locking** is untested until Phase 2. Mitigation then: open read-only, set a busy timeout, never write, and fall back to a copy if a locked WAL blocks reads. Note it in Phase 2, not here.
- **Path case-insensitivity** on Windows and default macOS can cause duplicate project identities. Deferred to Phase 2/3 where projects are keyed; the resolver should never key on raw path strings.
- **No CI yet** (intentionally deferred; the repo has no remote). The win32 rules are unit-proven, but a manual Windows run of install, typecheck and test is required before release.
- **Long paths on Windows** (>260 chars) can fail without `\\?\` prefixes. Out of scope unless a teammate hits it.
