# Phase 1 completion plan

Status: in progress
Owner: team
Scope: finish Phase 1 of `docs/project.md` without the dashboard
Estimated effort: 4 to 5 hours

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
- Exit mapping has a unit test.
- No command prints a stack trace for an expected error.

## Step 3: Test harness

Files: `tests/fixtures/records.mjs` (new), `tests/unit/*.test.mjs` (new), root `package.json` scripts, `docs/testing.md` (new, short).

- Use `node --test` against built output, like the reference. No extra test framework.
- Root scripts:

  ```json
  "pretest": "npm run build",
  "test": "node --test tests/unit"
  ```

  Directory form avoids shell globs, which differ on Windows.

- Fixtures: builders for `SourceSession`, `SourceMessage`, `Dataset` and `UsageEvent`. Text fields are shape-only, never prompt text.
- Temp state: `fs.mkdtempSync(path.join(os.tmpdir(), "munin-"))`, cleaned in `after`.
- Minimum suite:
  1. config defaults for win32, darwin, linux
  2. `XDG_DATA_HOME` accepted when absolute, ignored when relative
  3. `--db` beats `MUNIN_DB` beats settings beats default
  4. Git-Bash-style `HOME` ignored; `os.homedir()` default used
  5. malformed `config.json` degrades with the right warning code
  6. `inspectSourceDatabase` returns `ready`, `missing`, `unreadable`
  7. domain: `CostCalculation.total` follows `basis` (observed vs estimated)
  8. diagnostics: `MuninError` maps to the documented exit codes
- Assert that a failing test exits non-zero; delete the current vacuous pass.

Acceptance:

- `npm test` prints real results and fails when a test fails.
- Suite runs on macOS now; the Windows-only path assertions run everywhere through the pure resolver.
- `npm run test` does not need network or the user's real database.

## Step 4: Portability hardening

Files: `.gitattributes` (new), `.editorconfig` (new, optional), `.github/workflows/ci.yml` (new, optional), `package.json`.

- `.gitattributes`: `* text=auto eol=lf`, plus `*.png binary`, `*.db binary`, and `*.bat text eol=crlf` if ever added. This stops Windows checkouts from rewriting scripts and fixtures.
- No shell syntax in npm scripts. Audit every `scripts` entry for `rm`, `cp`, `&&` chains that assume a POSIX shell; use Node one-liners or separate scripts instead.
- CI matrix (recommended, cheap): Ubuntu, macOS, Windows on Node 24 running `npm ci && npm run typecheck && npm run build && npm test`. It will only run once the repo has a GitHub remote, but it is the only real proof for a distributed team.
- Document Windows prerequisites in the README: Node 24, PowerShell commands, no admin rights needed, DB path is still `%USERPROFILE%\.local\share\opencode\opencode.db` unless `XDG_DATA_HOME` is set.

Acceptance:

- `.gitattributes` present and committed.
- `grep` over npm scripts finds no POSIX-only commands.
- CI workflow is valid YAML and runs the same commands as the README.

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

- [ ] Config resolves correctly on win32, darwin, linux (unit-proven)
- [ ] Diagnostics documented and enforced
- [ ] `npm test` runs real tests and fails on failure
- [ ] `.gitattributes` and portable scripts
- [ ] README with Windows notes
- [ ] Clean checkout installs, typechecks, builds three packages, tests green
- [ ] Dashboard deferral recorded in the plan, parity matrix, ADR-0006 note
- [ ] Nothing from Phase 2 leaked in (no DB opened, no V2 parsing, no pricing)

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
- **CI is unproven** until the repo has a remote. Treat the manual Windows checklist as required if CI cannot run.
- **Long paths on Windows** (>260 chars) can fail without `\\?\` prefixes. Out of scope unless a teammate hits it.
