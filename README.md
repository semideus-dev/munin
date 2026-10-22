# Munin

Munin reads a developer's local coding-agent history and explains where the
money went and what could be avoided. It is a rebuild of Optimaizr with
OpenCode 2.x support and, later, a local dashboard.

Current status: **Phase 1 foundation**. The workspace, domain contracts,
configuration, diagnostics, and the first tests exist. Commands are not wired
yet; `--version` is the only working flag.

## Requirements

- Node.js 24 (minimum 22.13, for `node:sqlite`)
- npm 11 or newer
- OpenCode 2.x with local history, once the reader lands

The npm workflow is the contract; Bun is optional and no script depends on it.
See `docs/adr/0005-node-npm-toolchain.md`.

## Install and check

```bash
npm ci
npm run typecheck
npm test
```

`npm run typecheck` builds first, because `local` and `cli` typecheck against
the declarations `core` emits. `npm test` also builds, then runs the test
suite with `node --test`.

Run the CLI stub:

```bash
node apps/cli/dist/cli.js --version
```

## Layout

| Path             | Contents                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/core`  | Pure engine: domain model, diagnostics, later pricing and rules. No filesystem, network, or process access.       |
| `packages/local` | The only package allowed to touch the filesystem, SQLite, or the OS: configuration now, readers and ledger later. |
| `apps/cli`       | Command surface, exit codes, and error payloads.                                                                  |
| `tests/unit`     | Cross-platform unit tests against built output.                                                                   |
| `docs`           | Phase plan, ADRs, glossary, parity matrix, diagnostics.                                                           |

## Paths and environment

The source database defaults to OpenCode's XDG location on **every** platform,
including Windows:

```
<home>/.local/share/opencode/opencode.db
```

OpenCode 2.x uses `XDG_DATA_HOME || <home>/.local/share` regardless of OS, so
Munin matches it rather than inventing an `%LOCALAPPDATA%` default.

| Variable        | Effect                                        |
| --------------- | --------------------------------------------- |
| `XDG_DATA_HOME` | Replaces the data root, when absolute         |
| `MUNIN_DB`      | Source database path; wins over settings      |
| `MUNIN_DIR`     | Munin state root; defaults to `<home>/.munin` |
| `MUNIN_DEBUG`   | Print stack traces for expected failures      |

Database precedence:

```
--db  >  MUNIN_DB  >  $MUNIN_DIR/config.json "db"  >  OpenCode default
```

A relative `db` in `config.json` resolves against the state directory. A
relative `MUNIN_DB` resolves against the current directory. Munin never expands
`~`; the shell does that.

`HOME` is never read for path resolution. Home comes from `os.homedir()`, which
keeps Git Bash's `HOME=/c/Users/...` from corrupting Windows paths.

## Data and privacy

- Source history is opened read-only. Munin never writes to OpenCode's database.
- Prompts and message text are never stored. The model keeps shapes, token
  counts, and hashes.
- Derived state lives under `MUNIN_DIR`, not inside the source database.
- Observed cost is the headline; API-equivalent cost is secondary and labelled.
  See `docs/adr/0003-observed-cost-headlines.md`.

## Windows notes

- Use PowerShell. No admin rights are required.
- The default database is
  `%USERPROFILE%\.local\share\opencode\opencode.db` unless `XDG_DATA_HOME` is
  set. Do not set `HOME` for Munin; it is ignored.
- The repo enforces LF line endings through `.gitattributes`.
- npm scripts contain no POSIX-only commands (`rm`, `cp`), so the same commands
  work in PowerShell and bash.

Clean rebuild:

```powershell
Remove-Item -Recurse -Force node_modules, packages/core/dist, packages/local/dist, apps/cli/dist
npm ci
npm run typecheck
npm test
```

The same in bash:

```bash
rm -rf node_modules packages/*/dist apps/*/dist
npm ci
npm run typecheck
npm test
```

## Documentation

- `docs/project.md`: phase plan and exit criteria
- `docs/plans/`: per-phase plans and exit records
- `docs/readers.md`: source model, V1/V2 mapping, read-only guarantees
- `docs/adr/`: architecture decisions
- `docs/diagnostics.md`: exit codes, error and warning shapes
- `docs/parity-matrix.md`: what is ported, adapted, rebuilt, or deferred
- `GLOSSARY.md`: project vocabulary
