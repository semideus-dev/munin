# Phase 2 plan: readers and normalization

Status: planned
Owner: team
Scope: read OpenCode history into the source model. No pricing, analysis, CLI commands, or dashboard.
Estimated effort: 7 to 9 hours

## Goal

Turn local OpenCode history into `Dataset` records that Phase 3 can price and
analyse. Both schema generations come through one reader API; V2 is validated
against the real database, V1 against fixtures.

Project exit criterion (`docs/project.md`):

> Fixture tests pass for V1 and V2, and an integration test reads the real local
> database without modifying it.

Definition of done:

- `readDataset()` returns sessions, messages, tool calls, observed cost, and
  instruction metadata for the real V2 database.
- V1 fixture rows produce the same source model through the same API.
- A mixed database does not duplicate or silently drop sessions.
- The source database is never written to.
- Prompt text, tool output, and compaction summaries never leave the reader.
- Six focused tests pass, including an integration test that skips cleanly when
  the database is absent.
- A development script makes every step verifiable by hand.

## Scope decisions

- **V2 is the only source with real local data.** It gets the integration test.
- **V1 is ported from the reference and fixture-tested.** No V1 database exists
  on the author's machine.
- **Claude Code, Codex, Gemini, and import readers stay out.** Phase 0 inventory
  marked them deferred or excluded; the parity matrix already records this.
- **The deliverable is `Dataset`, not `UsageEvent`.** Phase 2 preserves
  provider-reported usage and tools. Phase 3 builds priced `UsageEvent`s,
  estimated costs, and analysis.
- **Observed cost only.** `SourceUsage.observedUsd` comes from the source. No
  rate cards, no estimated cost, no `unpriced` logic yet.
- **No product CLI command.** Verification uses `scripts/read-local.mjs`, a
  development harness. Phase 6 replaces it with real commands.
- **No ledger writes, no live polling, no dashboard.**

## Verified schema facts

From OpenCode 2.1.2, inspected on the author's database while planning. The
database is live, so counts drift; always compare against the same snapshot.

Tables that matter:

| Table               | Role                                                            |
| ------------------- | --------------------------------------------------------------- |
| `session_v2`        | one conversation, with project, parent, model, aggregates       |
| `session_message`   | one stored record: `assistant`, `user`, `compaction`, lifecycle |
| `project`           | worktree and project identity; `name` is empty in practice      |
| `instruction_state` | per-session `current_values` map of key to blob hash            |
| `instruction_blob`  | instruction text by hash; only lengths and hashes are used      |

V1 tables (`session`, `message`, `part`) are absent on this machine.

Message types and counts at planning time:

| Type             | Count |
| ---------------- | ----- |
| `assistant`      | 1,137 |
| `user`           | 110   |
| `idle`           | 112   |
| `synthetic`      | 46    |
| `agent-switched` | 28    |
| `system`         | 14    |
| `model-switched` | 14    |
| `compaction`     | 8     |

Assistant payload, relevant fields:

```
content[]          text | reasoning | tool
tokens             { input, output, reasoning, cache: { read, write } }
cost               number (null on failed calls)
model              { id, providerID, variant }
time               { created, completed, streamed }
agent, finish      strings
error              { type, message, status, response }
```

Tool elements carry `name`, `id`, `state.input`, `state.status`, and
`state.content` (the output). Tool output is the bulk of the payload and is
stripped in SQL.

Instruction state at planning time: 21 sessions, 42 blobs, 189,703 characters.
`current_values` values are 64-character blob hashes.

Message-level totals at planning time, used as a sanity baseline:

| Figure                        | Value        |
| ----------------------------- | ------------ |
| input tokens                  | 5,389,426    |
| output tokens                 | 412,655      |
| reasoning tokens              | 271,100      |
| cache read tokens             | 61,153,016   |
| cache write tokens            | 0            |
| observed cost                 | $0.759757726 |
| sessions over 1% input delta  | 6            |
| sessions over 1% output delta | 5            |

## Architecture

```text
db file
  |
  +-- openReadOnly() ---------> PRAGMA query_only, busy_timeout
  |
  +-- detectSchema() ---------> v1 / v2 / mixed / none
  |
  +-- readV2Rows() -----------+
  +-- readV1Rows() -----------+--> core/normalize --> merge --> Dataset
  +-- readInstructions() -----+
```

Rules:

- `@munin/local` owns SQL, filesystem, process, and crypto.
- `@munin/core` owns mapping from rows to the source model. It stays pure: no
  `node:*` imports.
- Raw row types are the seam between them and live in core.
- The reader API lives in `@munin/local` and returns `Dataset`.
- Every expected failure becomes a warning, not an exception. Only programmer
  errors throw.

## Mapping rules

### Sessions

| Source                                                 | Target                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `session_v2.id`                                        | `SourceSession.id`                                           |
| `parent_id`                                            | `parentId`                                                   |
| `project_id`                                           | `projectId`                                                  |
| `project.worktree` basename, else `directory` basename | `project`                                                    |
| `title`                                                | `title`                                                      |
| `directory`                                            | `directory`                                                  |
| `agent`                                                | `agent`                                                      |
| `model` JSON                                           | `model` (`providerID` to provider, `id` to model, `variant`) |
| `time_created`, `time_updated`                         | ISO timestamps                                               |
| `tokens_*`, `cost`                                     | `aggregateUsage`, `aggregateCost` (cross-check only)         |
| `instruction_state`                                    | `instructions` (new field)                                   |

Add to `domain/source.ts`:

```ts
export interface SourceInstructions {
  keys: string[];
  chars: number;
  prefixHash: string;
}
```

`SourceSession.instructions?: SourceInstructions`.

### Messages

| Source `type`    | Target `SourceMessageType` |
| ---------------- | -------------------------- |
| `assistant`      | `assistant`                |
| `user`           | `user`                     |
| `compaction`     | `compaction`               |
| `idle`           | `idle`                     |
| `model-switched` | `model-switched`           |
| `agent-switched` | `agent-switched`           |
| `system`         | `system`                   |
| `synthetic`      | `synthetic`                |
| anything else    | `unknown`, keeps `rawType` |

- `seq` and `time_created` preserve source order.
- `time.completed` becomes `completedAt`; `latencyMs` is not stored in the
  source model.
- `textChars` is computed with SQL `length()`. Text itself is stripped before
  rows reach JavaScript where practical.
- `finish` becomes `stopReason`; `error.type` becomes `errorType`.
- Assistant and compaction messages carry `usage`.
- Compaction summaries and `recent` context are never read into the result.

### Tokens and cost

| Source                             | Target                                         |
| ---------------------------------- | ---------------------------------------------- |
| `tokens.input`                     | `inputTokens` / `TokenCounts.input`            |
| `tokens.output + tokens.reasoning` | `outputTokens`                                 |
| `tokens.reasoning`                 | `thinkingTokens`                               |
| `tokens.cache.read`                | `cacheReadTokens`                              |
| `tokens.cache.write`               | `cacheWrite5mTokens`; `cacheWrite1hTokens = 0` |
| `cost`                             | `observedUsd` when finite, including zero      |

No estimated cost in Phase 2. A null cost on a model call is counted under
`source.missing-cost`, not coerced to zero.

### Tools

Tool calls come from assistant `content[]` entries of type `tool`:

- `id`: tool `id`, falling back to `name + index`.
- `name`: canonical mapping where known (`read` to `Read`, `shell` to `Bash`,
  `ls` to `LS`, and so on); otherwise the raw name.
- `signature`: ported rule from the reference. `Read:path#offset:limit`,
  `Edit:path#inputHash`, `Bash:command`, `Grep:pattern|path`,
  `Glob:pattern`, `WebFetch:url`, default `name:jsonPrefix`.
- `target`: `input.path` or `input.filePath`, so edits can retire earlier reads.
- `resultChars`: SQL `length(state.content)`, never the content.
- `isError`: `state.status === "error"`.

Tool inputs are read to compute signatures and then discarded. No tool input or
output is stored.

### Instructions

For each session with `instruction_state`:

1. Parse `current_values` as a key-to-hash map.
2. Sort keys.
3. Sum `length(instruction_blob.value)` per key. A missing blob produces
   `source.instruction-missing`.
4. Build `prefixHash` as the first 16 hex characters of SHA-256 over:
   sorted `key=hash` lines, then agent, provider, model, and variant. Hashing
   lives in `local` because `node:crypto` is not allowed in core.

### Mixed schemas

- Detect by table presence and row counts.
- Read both generations, then merge sessions by id.
- For a session id present in both, V2 wins entirely; V1 rows for that id are
  ignored.
- V1-only sessions are kept.
- Emit one `source.mixed-schema` warning with both counts.

This avoids duplicates and preserves old sessions. The trade-off is that a
partially migrated V2 session does not inherit older V1 messages; the warning
makes that visible.

## Read-only guarantees

- Open with `new DatabaseSync(path, { readOnly: true })`.
- Set `PRAGMA busy_timeout = 5000` and `PRAGMA query_only = ON`.
- Never set journal mode, never vacuum, never create temp tables, never write.
- Close in `finally`, including when mapping throws.
- If the database is busy after the timeout, return `source.busy`, not a crash.
- Windows note: reading a WAL database read-only can fail if the `-shm` file
  cannot be created. If a teammate hits it, fall back to copying `opencode.db`,
  `-wal`, and `-shm` to a temp directory and reading the copy. Do not write to
  the source to work around it.

## Steps

### Step 1: SQLite seam, schema detection, script skeleton (45 min)

Files:

- `packages/core/src/normalize/rows.ts` (raw row types, no logic)
- `packages/local/src/readers/sqlite.ts`
- `packages/local/src/readers/schema.ts`
- `scripts/read-local.mjs` with `--schema`

Work:

- `openReadOnly(path)` returns a configured handle.
- `detectSchema(db)` reads `sqlite_master` and counts `session_v2` and `session`.
- Return `{ schema: "v1" | "v2" | "mixed" | "none", tables, sessionCounts }`.
- Add a root script: `"reader": "npm run build && node scripts/read-local.mjs"`.
- The script accepts `--db <path>` and defaults to `loadConfig().dbPath`.

Verify by hand:

```bash
sqlite3 ~/.local/share/opencode/opencode.db ".tables"
npm run reader -- --schema
```

Expected: both report `session_v2` and `session_message`; the script says `v2`.
Try a missing path and confirm a `source.missing-db` warning and exit code 1.
Try a copied database with `--db` and confirm the same schema.

Done when: schema detection matches `sqlite_master` for V2, V1-like fixture, and
missing paths, and the handle is provably read-only.

### Step 2: V2 row extraction and instructions (1.5 h)

Files:

- `packages/local/src/readers/opencode-v2.ts`
- `packages/local/src/readers/instructions.ts`
- extend `scripts/read-local.mjs` with `--rows`

Work:

- Select sessions ordered by `time_updated`, with optional `sinceDays`, `limit`,
  and `offset`.
- Select messages for selected session ids in chunks of 500 to stay under
  SQLite's variable limit.
- Use `json_remove` to drop `$.content[*].text`, `$.content[*].state.content`,
  `$.text`, `$.summary`, and `$.recent` before rows reach JavaScript.
- Run a separate tool query for `name`, `state.input`, `state.status`, and
  `length(state.content)`, grouped by message id.
- Run a separate length query for text characters, grouped by message id.
- Count invalid JSON rows with `json_valid` instead of failing.
- Read instructions with a join to `instruction_blob` for lengths; hash in
  `instructions.ts`.
- Script `--rows` prints counts only: sessions, message types, invalid JSON,
  tool calls, instruction sessions and characters.

Verify by hand:

```bash
npm run reader -- --rows
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT type, count(*) FROM session_message GROUP BY type ORDER BY type;"
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT count(*), sum(length(value)) FROM instruction_blob;"
```

Expected: identical type counts, 42 blobs and 189,703 characters at planning
time, zero invalid JSON. Run `--rows` twice and confirm the instruction prefix
hash is stable.

Done when: row extraction is complete, bounded by session selection, and no
text or tool output is selected into the result set.

### Step 3: V2 normalization (1.5 h)

Files:

- `packages/core/src/normalize/tools.ts`
- `packages/core/src/normalize/text.ts`
- `packages/core/src/normalize/time.ts`
- `packages/core/src/normalize/opencode-v2.ts`
- `packages/core/src/domain/source.ts` (instructions field)
- `packages/local/src/readers/index.ts` (`readDataset`, V2 path only)
- extend script with `--summary` and `--session <id>`

Work:

- Map sessions and messages exactly as the tables above describe.
- Split assistant `content[]` into tool calls and text character counts.
- Attach instructions by session id.
- Leave estimated cost absent; observed cost only.
- Project label: worktree basename, then directory basename, then `unknown`.
- Script `--summary` prints schema, counts, token totals, observed cost,
  subagent count, instruction totals, and warnings.

Verify by hand:

```bash
npm run reader -- --summary
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT sum(json_extract(data,'$.tokens.input')),
          sum(json_extract(data,'$.tokens.output')),
          sum(json_extract(data,'$.tokens.reasoning')),
          sum(json_extract(data,'$.tokens.cache.read')),
          sum(json_extract(data,'$.tokens.cache.write')),
          sum(coalesce(json_extract(data,'$.cost'),0))
   FROM session_message WHERE type IN ('assistant','compaction');"
```

Every token and cost figure must match exactly. Check the model-call count equals
assistant plus compaction. Pick one session with `--session <id>` and compare
its counts and cost with a SQL query scoped to that id.

Done when: message-level figures match SQL exactly, project labels are sane, and
the serialized dataset contains no text, summary, or tool output fields.

### Step 4: Reconciliation and warnings (45 min)

Files:

- `packages/core/src/normalize/reconcile.ts`
- `packages/core/src/diagnostics.ts` (`WARNING_CODES`)
- extend script with `--reconcile`

Work:

- Compare message sums with `session_v2` aggregates for input, output,
  reasoning, cache read, and cache write.
- A session warns when any category differs by more than 1% (minimum 1 token).
- Emit one `source.aggregate-mismatch` warning with the session count and the
  largest delta, not one warning per session.
- Add the Phase 2 codes:

| Code                         | Meaning                                       |
| ---------------------------- | --------------------------------------------- |
| `source.missing-db`          | no database at the path                       |
| `source.unreadable`          | permissions, wrong file, SQLite open failure  |
| `source.busy`                | locked after the timeout                      |
| `source.no-schema`           | no V1 or V2 tables                            |
| `source.empty`               | schema exists but no sessions                 |
| `source.mixed-schema`        | both generations present                      |
| `source.invalid-json`        | rows skipped, with count                      |
| `source.unknown-type`        | message types mapped to `unknown`, with count |
| `source.unknown-model`       | model calls with no model id, with count      |
| `source.missing-cost`        | model calls with no observed cost, with count |
| `source.aggregate-mismatch`  | session aggregates disagree, with count       |
| `source.instruction-missing` | instruction hash without a blob               |

Verify by hand:

```bash
npm run reader -- --reconcile
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT count(*) FROM (
     SELECT s.id FROM session_v2 s
     LEFT JOIN session_message m
       ON m.session_id = s.id AND m.type IN ('assistant','compaction')
     GROUP BY s.id
     HAVING abs(s.tokens_input - coalesce(sum(json_extract(m.data,'$.tokens.input')),0))
            > max(1, abs(s.tokens_input) * 0.01));"
```

The warning count should match the SQL count (6 at planning time). Confirm the
delta is reported, and confirm that totals in `--summary` still come from
messages, never aggregates.

Done when: reconciliation is warning-only and the real database produces a
sensible mismatch count.

### Step 5: V1 reader and fixture (1 h)

Files:

- `packages/local/src/readers/opencode-v1.ts`
- `packages/core/src/normalize/opencode-v1.ts`
- `tests/fixtures/opencode-db.mjs` (start here)
- `tests/unit/v1.test.mjs`

Work:

- Port `readOpencodeRows` from the reference: `session`, `message`, `part`.
- Port mapping without pricing. Each `step-finish` part is one model call, so it
  becomes one `SourceMessage` with a stable synthetic id `<messageId>#<partId>`.
  This is the documented adaptation for a source that packs several calls into
  one row.
- Tool parts between step-finish parts attach to the call they preceded, then
  reset.
- `part.cost` becomes `observedUsd`.
- Tool output is stripped in SQL; only its length survives.
- The V1 fixture creates a temporary database with one session, one assistant
  message, two step-finish parts, and two tool parts.

Verify by hand:

```bash
node --test tests/unit/v1.test.mjs
```

Expected: two model calls from one message, exact token and cost values, both
tool calls on the right call, and no text or tool output in the serialized
result.

Done when: the V1 fixture produces the same `Dataset` shape as V2.

### Step 6: Mixed-schema merge and orchestrator (1 h)

Files:

- `packages/core/src/normalize/merge.ts`
- `packages/local/src/readers/index.ts` (full `readDataset`)
- `tests/unit/schema.test.mjs`

Work:

- Read both generations when both have rows.
- Merge by session id with V2 precedence.
- Keep V1-only sessions; warn once with both counts.
- Handle `none`, empty, missing, unreadable, and busy cases with warnings.
- Return an empty dataset with warnings instead of throwing for expected cases.
- Apply `limit` and `offset` per source, then merge, sort by `timeUpdated`, and
  truncate. Document this approximation.

Verify by hand:

```bash
node --test tests/unit/schema.test.mjs
npm run reader -- --schema
```

Expected: v1-only, v2-only, mixed, and none fixtures each report the right
schema; the mixed fixture counts V2 sessions once and keeps V1-only sessions.

Done when: no duplicate session ids survive the merge and every degraded case
has a warning.

### Step 7: Finish the test suite (1.5 h)

Files:

- `tests/fixtures/opencode-db.mjs`
- `tests/unit/v2.test.mjs`
- `tests/unit/reconcile.test.mjs`
- `tests/unit/readonly.test.mjs`
- `tests/unit/integration.test.mjs`

Tests:

1. **V2 fixture**: sessions, project label, tokens, observed cost, compaction,
   subagents, tool signatures, instruction chars and stable prefix hash.
2. **V1 fixture**: from Step 5.
3. **Schema and merge**: from Step 6.
4. **Reconciliation**: equal aggregates produce no warning; a 2% delta produces
   one warning with the right count and largest delta.
5. **Read-only and degraded inputs**: hash a fixture file before and after a
   read; assert unchanged. Missing, unreadable, and non-SQLite files produce
   warnings, not throws.
6. **Integration**: read the real database when present; assert schema `v2`,
   sessions and model calls greater than zero, and no `source.unreadable`.
   Skip with a message when absent.

Privacy assertion in the V2 fixture: insert sentinel strings for prompt text,
compaction summary, and tool output, then assert none appear in
`JSON.stringify(dataset)`.

Verify by hand:

```bash
npm test
```

Expected: all tests pass; the integration test passes on a machine with
OpenCode history and skips elsewhere. A deliberate failing assertion still exits
non-zero.

Done when: the suite covers every mapping category that can silently produce a
wrong number.

### Step 8: Verification script and manual audit (1 h)

Files:

- `scripts/read-local.mjs`
- root `package.json` (`reader` script)

Modes:

| Flag              | Output                                                |
| ----------------- | ----------------------------------------------------- |
| `--schema`        | detected schema, tables, counts                       |
| `--rows`          | row and instruction counts                            |
| `--summary`       | counts, tokens, observed cost, instructions, warnings |
| `--reconcile`     | aggregate deltas and warning count                    |
| `--session <id>`  | one session's counts and cost                         |
| `--check-privacy` | walk the serialized dataset and fail on banned keys   |
| `--json`          | the summary as JSON                                   |

Banned keys: `text`, `summary`, `content`, `state`, `output`. Titles, paths,
and hashes are allowed.

Full manual audit on a stable snapshot:

```bash
DB="$HOME/.local/share/opencode/opencode.db"
SNAP="/tmp/munin-phase2-snapshot.db"
rm -f "$SNAP"
sqlite3 "$DB" ".backup '$SNAP'"

npm run reader -- --db "$SNAP" --schema
npm run reader -- --db "$SNAP" --rows
npm run reader -- --db "$SNAP" --summary
npm run reader -- --db "$SNAP" --reconcile
npm run reader -- --db "$SNAP" --check-privacy
```

Check against the same snapshot:

```bash
sqlite3 "$SNAP" "SELECT count(*) FROM session_v2;"
sqlite3 "$SNAP" \
  "SELECT type, count(*) FROM session_message GROUP BY type;"
sqlite3 "$SNAP" \
  "SELECT sum(json_extract(data,'$.tokens.input')),
          sum(json_extract(data,'$.tokens.output')),
          sum(json_extract(data,'$.tokens.reasoning')),
          sum(json_extract(data,'$.tokens.cache.read')),
          sum(json_extract(data,'$.tokens.cache.write')),
          sum(coalesce(json_extract(data,'$.cost'),0))
   FROM session_message WHERE type IN ('assistant','compaction');"
```

No-write proof:

```bash
before=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
npm run reader -- --db "$SNAP" --summary >/dev/null
after=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
test "$before" = "$after" && echo "database unchanged"
```

Windows equivalent: `Get-FileHash` before and after. Quit OpenCode first if
hashing the live database; the snapshot avoids that problem.

Also confirm the state directory stays untouched:

```bash
MUNIN_DIR=$(mktemp -d) npm run reader -- --db "$SNAP" --summary
ls -A "$MUNIN_DIR"   # must print nothing
```

### Step 9: Documentation and exit review (30 min)

Files:

- `docs/readers.md` (schema map, policies, tool names, limits)
- `docs/diagnostics.md` (Phase 2 warning codes)
- `docs/plans/phase-2-readers.md` (this file: status, exit record)
- `docs/project.md` (Phase 2 status line)

`docs/readers.md` covers: the reader API, V2 and V1 mapping, mixed policy,
instruction hashing, text stripping, read-only guarantees, and the manual
verification commands.

Exit checklist:

- [ ] `npm run typecheck` and `npm run build` green
- [ ] `npm test` passes, including V1 and V2 fixture tests
- [ ] integration test reads the real database, or skips with a clear message
- [ ] counts, tokens, and observed cost match SQL on the same snapshot
- [ ] reconciliation count matches SQL
- [ ] `--check-privacy` passes; sentinel test passes
- [ ] database hash unchanged after reading
- [ ] state directory untouched
- [ ] mixed-schema fixture keeps V1-only sessions and counts V2 once
- [ ] no pricing, analysis, CLI commands, ledger, or dashboard work leaked in

## Final deliverables

| Deliverable           | Proof                                              |
| --------------------- | -------------------------------------------------- |
| Read-only SQLite seam | missing/unreadable/busy tests, unchanged file hash |
| V2 reader             | real database counts, tokens, and cost match SQL   |
| V2 normalization      | fixture test with tools, compaction, instructions  |
| V1 reader             | fixture test with two calls from one message       |
| Mixed-schema merge    | schema test with V1-only and shared sessions       |
| Reconciliation        | warning count matches SQL                          |
| Instruction metadata  | 21 sessions, 42 blobs, stable prefix hashes        |
| Privacy               | banned-key check and sentinel test                 |
| Developer harness     | `npm run reader -- ...`                            |
| Documentation         | `docs/readers.md`, updated diagnostics and plan    |

## Out of scope

- `UsageEvent` construction, pricing, estimated cost, and `unpriced` handling
- Analysis, findings, rules, savings, reports
- Product CLI commands, JSON command contract, dashboard
- Ledger writes, incremental scans, live polling, replay
- Real V1 integration coverage and other providers

## Risks

- **Windows WAL locking** can block read-only opens. Mitigation: busy timeout,
  never write, and a documented copy fallback. Test on Windows before release.
- **Text leakage** is the highest-severity failure. Mitigation: strip in SQL,
  sentinel test, banned-key check, and review of every selected column.
- **V1 is unvalidated against real data.** The fixture keeps the port honest but
  cannot prove a migrated database works. Mixed tests cover the handoff.
- **Live database drift** makes manual numbers move. Use `.backup` snapshots.
- **Aggregate disagreement is expected.** Never "fix" totals by trusting session
  columns; the warning exists to surface the gap.
- **Instruction blobs may be missing or reused.** Count per key, warn on missing
  hashes, and never read blob text into the result.
- **Large tool output** can exhaust memory if selected. Strip it in SQL and keep
  only lengths.
- **Pagination across mixed sources is approximate.** Document it; full scans are
  the default for local databases.
