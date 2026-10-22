# Parity matrix

What Munin rebuilds from Optimaizr, what it must adapt for OpenCode 2.x, and what it deliberately leaves out. Status legend:

- **Ported** — logic reused, behaviour preserved.
- **Adapted** — logic reused, data acquisition rewritten for V2 fields.
- **New** — no reference equivalent.
- **Excluded** — Claude-specific or beyond scope.
- **Deferred** — planned, not in the hackathon cut.

## Packages

| Reference | Munin | Status |
| --- | --- | --- |
| `core/domain/types.ts`                                              | `core/domain`                                              | Adapted (V2 fields, dual cost basis)                                                                                   |
| `core/pricing.ts`                                                   | `core/pricing`                                             | Ported + model alias layer (New)                                                                                       |
| `core/providers/registry.ts`                                        | `core/providers`                                           | Ported, trimmed to `opencode` + generic                                                                                |
| `core/ingest/opencode.ts`                                           | `local/readers/opencode-v1.ts`                             | Ported                                                                                                                 |
| —                                                                   | `local/readers/opencode-v2.ts`                             | New                                                                                                                    |
| —                                                                   | `local/readers/schema.ts`                                  | New (detect v1/v2/both, precedence)                                                                                    |
| —                                                                   | `local/readers/instructions.ts`                            | New (instruction hashes, sizes, prefix hash)                                                                           |
| `core/ingest/claudecode.ts`                                         | —                                                          | Deferred                                                                                                               |
| `core/ingest/codex.ts`                                              | —                                                          | Deferred                                                                                                               |
| `core/ingest/import.ts`                                             | —                                                          | Excluded                                                                                                               |
| `core/ingest/images.ts`                                             | —                                                          | Excluded (no image usage in OpenCode history)                                                                          |
| `core/analyze/summary.ts`                                           | `core/analyze/summary.ts`                                  | Ported                                                                                                                 |
| `core/analyze/sessions.ts`                                          | `core/analyze/sessions.ts`                                 | Adapted (subagents, compaction)                                                                                        |
| `core/analyze/conversations.ts`                                     | `core/analyze/conversations.ts`                            | Adapted (no subscription windows)                                                                                      |
| `core/analyze/{cold,writes,context-watch}.ts`                       | same                                                       | Ported                                                                                                                 |
| `core/analyze/rules.ts`                                             | `core/analyze/rules/*`                                     | Split per rule, 17 ported/adapted                                                                                      |
| `core/analyze/drilldown.ts`                                         | same                                                       | Ported                                                                                                                 |
| `core/analyze/classify.ts`, `tasks.ts`                              | same                                                       | Adapted                                                                                                                |
| `core/analyze/profile.ts`                                           | same                                                       | Ported                                                                                                                 |
| `core/analyze/budget.ts`                                            | same                                                       | Ported (generic budget cap only)                                                                                       |
| `core/analyze/live.ts`                                              | same                                                       | Adapted (DB polling)                                                                                                   |
| `core/analyze/results.ts` | `packages/core/src/analyze/results.ts` | Partial (generic cost/turn or cost/call comparison; no reference-specific agent levers) |
| — | `packages/core/src/analyze/snapshot-diff.ts` | New (compact snapshot trend diff) |
| `core/analyze/{plan,codex-plan,guard,week,metrics,checks}.ts`       | —                                                          | Excluded                                                                                                               |
| `core/recommend/*`                                                  | same                                                       | Ported, Claude steps removed                                                                                           |
| `core/report/{terminal,html,card}.ts`                               | same                                                       | Ported                                                                                                                 |
| `core/report/statusline.ts`                                         | —                                                          | Excluded                                                                                                               |
| `core/verify/state.ts`                                              | same                                                       | Ported (replay deferred)                                                                                               |
| `local/ledger.ts`, `decisions.ts`, `verifications.ts`, `changes.ts` | `packages/local/src/ledger.ts`, `cursors.ts`, `changes.ts` | Adapted (session-slice journal, watermarks, snapshots, apply journal) |
| `local/live.ts` | `packages/local/src/scan.ts` watch mode | Adapted (polls OpenCode DB fingerprint; manual real-DB check pending) |
| Reference byte-offset/event streaming tail | — | Excluded (Munin polls SQLite and re-reads whole sessions at 2-second cadence) |
| Reference per-rule result metrics for external model/agent changes | — | Excluded (no supported Munin model/agent apply mapping; generic cost comparisons remain available) |
| —                                                                   | `local/config/apply.ts`                                    | New                                                                                                                    |
| `local/{wrap,samples,overrides,meter,notify,jev}.ts`                | —                                                          | Excluded                                                                                                               |
| `local/{claude-mod,claude-account,statusline,guard,compaction}.ts`  | —                                                          | Excluded                                                                                                               |
| `local/providers/*`                                                 | `local/providers/opencode.ts`                              | Ported shim                                                                                                            |
| `apps/cli` dispatch, `args`, `data`, `config`                       | same                                                       | Ported                                                                                                                 |
| `apps/cli/commands/{mod,statusline}`                                | —                                                          | Excluded                                                                                                               |
| `apps/cli/commands/live*` | — | Deferred to Phase 6 (the Phase 5 polling watcher is available through the scan harness) |
| `apps/cli/scripts/{bundle,e2e,mod-prices}`                          | —                                                          | Excluded                                                                                                               |
| `apps/cli/test` (48 files)                                          | own tests + arithmetic expectations                        | Not copied                                                                                                             |
| `mods/`, `.claude-plugin/`                                          | —                                                          | Excluded                                                                                                               |

## Rules

Every rule below is evaluated against message-level usage. "V2 input" names the data that makes it work.

| Rule                    | V2 input                                                             | Status                 |
| --- | --- | --- |
| `pricing-change`        | dated rate cards + call timestamps                                   | Ported                 |
| `cost-spike`            | spend by period                                                      | Ported                 |
| `spend-concentration`   | spend by project/model                                               | Ported                 |
| `cache-churn`           | cache read/write per call + instruction prefix hash + model switches | Adapted                |
| `repeated-context`      | prefix hash across sessions                                          | Adapted                |
| `prompt-bloat`          | instruction blob sizes per session                                   | Adapted (V2 is richer) |
| `repeat-tool-calls`     | tool inputs (paths, commands)                                        | Ported                 |
| `model-fit`             | task kind + model rates                                              | Ported                 |
| `reasoning-effort`      | model variant + reasoning tokens                                     | Adapted                |
| `oversized-input`       | input tokens per call                                                | Ported                 |
| `oversized-output`      | output tokens per call                                               | Ported                 |
| `oversized-tool-output` | tool result size                                                     | Adapted                |
| `error-loops`           | tool status/exit + assistant error finish                            | Adapted                |
| `cold-resume`           | gaps + cache writes                                                  | Ported                 |
| `heavy-start`           | first-call input tokens + instruction size                           | Adapted                |
| `context-compaction`    | compaction records (measured)                                        | Adapted, now measured  |
| `model-default`         | session model vs task profile                                        | Adapted                |

## CLI

| Reference command | Munin | Status |
| --- | --- | --- |
| *(default)* `profile` | `munin` | Ported |
| `scan` | `npm run scan` | Partial (Phase 5 harness; product CLI wiring is Phase 6) |
| `waste`                                                        | `munin waste`                 | Ported                                                                                                                         |
| `show`                                                         | `munin show <rule>`           | Ported                                                                                                                         |
| `why`                                                          | `munin why`                   | Ported                                                                                                                         |
| `sessions`                                                     | `munin sessions`              | Adapted                                                                                                                        |
| `tokens` / `analytics`                                         | `munin tokens`                | Ported                                                                                                                         |
| `live` / `watch` | `npm run scan -- --watch` | Partial (runtime harness is implemented; product CLI wiring is Phase 6) |
| `report`                                                       | `munin report`                | Ported                                                                                                                         |
| `apply` / `undo`                                               | `munin apply` / `munin undo`  | Adapted (project config only)                                                                                                  |
| `simulate`                                                     | `munin simulate --to <model>` | Deferred (stretch)                                                                                                             |
| `card`                                                         | `munin card`                  | Deferred (stretch)                                                                                                             |
| `results` | `npm run scan -- --results` | Partial (generic ledger-based cost/turn or cost/call comparison; empty apply journal is explicit; product CLI remains Phase 6) |
| `verify`                                                       | `munin verify --replay`       | Deferred (stretch)                                                                                                             |
| `providers`                                                    | `munin providers`             | New (coverage view)                                                                                                            |
| `privacy` / `security`                                         | `munin privacy`               | Ported                                                                                                                         |
| `limit`                                                        | —                             | Excluded                                                                                                                       |
| `plan`, `codex-plan`                                           | —                             | Excluded                                                                                                                       |
| `statusline`, `guard`, `mod`                                   | —                             | Excluded                                                                                                                       |
| `metrics`, `feedback`, `changelog`, `import`, `guide`, `audit` | —                             | Excluded                                                                                                                       |

## Dashboard

Deferred to the end of the build (Phase 7), so Phase 1 exits with three packages. See `docs/plans/phase-1-completion.md`.

| Page             | Content                                                                                              | Status        |
| --- | --- | --- |
| `/`              | observed + API-equivalent KPIs, spend over time, model split, cache split, top findings, data health | New, deferred |
| `/sessions`      | filterable session table                                                                             | New, deferred |
| `/sessions/[id]` | turn timeline, tools, cache behaviour, findings, subagents                                           | New, deferred |
| `/findings`      | ranked findings with evidence and calculation; apply/undo for three rules                            | New, deferred |

## Deliberate gaps

- No Claude Code, Codex, Gemini, CSV/JSON import, SDK `wrap()`, images, subscription plans, hooks, statusline, or plugin.
- No replay verification in the hackathon cut; the state machine exists so it can be added without reshaping rules.
- No demo fixture dataset yet; development runs against the author's real OpenCode database read-only.
