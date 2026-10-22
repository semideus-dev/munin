# Readers

How Munin turns local coding-agent history into the source model (`Dataset`).
Readers own every filesystem, SQLite, process, and crypto operation. They do not
price, aggregate, or produce findings; that is Phase 3 analysis.

Settled decisions live in
[ADR-0001](./adr/0001-readers-live-in-local.md) and
[ADR-0002](./adr/0002-message-level-accounting.md).

## API

```ts
import { readDataset } from "@munin/local";

const dataset = readDataset({
  db: "/path/to/opencode.db", // optional; env and settings are also honoured
  sinceDays: 30, // optional session filter
  limit: 100, // optional session page
  offset: 0, // optional session page
});
```

`readDataset()` always returns a `Dataset`:

```ts
interface Dataset {
  schema: "v1" | "v2" | "mixed" | "none";
  sessions: SourceSession[];
  messages: SourceMessage[];
  warnings: SourceWarning[];
  sources: string[];
}
```

Expected failures (missing database, unreadable file, no schema, empty
history, busy database) return an empty or partial dataset with a warning. They
do not throw. Only programmer errors throw.

Low-level entry points are exported for tests and tools:

- `detectSchema(db)` returns the schema and table inventory.
- `readV1Rows(db, options)` and `readV2Rows(db, options)` return raw rows.
- `readInstructions(db, sessionIds)` returns instruction keys, character
  totals, and prefix hashes.
- `openReadOnly(path)` returns a configured read-only handle.

## Data flow

```text
database file
  |
  +-- openReadOnly() -------- read-only handle, busy timeout, query_only
  |
  +-- detectSchema() -------- v1 / v2 / mixed / none
  |
  +-- readV2Rows() ---------- sessions, messages, tool projections, text lengths
  +-- readV1Rows() ---------- session, message, part
  +-- readInstructions() ---- instruction keys, character totals, prefix hash
  |
  +-- normalizeOpenCodeV2() - rows to source model
  +-- normalizeOpenCodeV1() - rows to source model
  |
  +-- mergeDatasets() ------- mixed-schema merge, V2 wins on a shared id
  |
  +-- reconcileAggregates() - warning-only aggregate cross-check
  |
  Dataset
```

Raw row types are the seam. They live in
`packages/core/src/normalize/rows.ts`; mapping lives in `@munin/core` and stays
free of Node builtins.

## Schema detection and mixed history

Detection uses table presence and row counts:

| Tables found      | Schema  |
| ----------------- | ------- |
| `session_v2` only | `v2`    |
| `session` only    | `v1`    |
| both, with rows   | `mixed` |
| neither           | `none`  |

For a mixed database Munin reads both generations and merges sessions by id:

- a session id present in both keeps the V2 version entirely;
- V1-only sessions are kept;
- one `source.mixed-schema` warning records both counts.

A partially migrated V2 session therefore does not inherit older V1 messages.
The warning makes that trade-off visible instead of double counting or silently
dropping history.

## V2 mapping

OpenCode 2.x stores one row per message in `session_message` and session
metadata in `session_v2`.

### Sessions

| Source                                           | Target                             |
| ------------------------------------------------ | ---------------------------------- |
| `session_v2.id`                                  | `SourceSession.id`                 |
| `parent_id`                                      | `parentId`                         |
| `project_id`                                     | `projectId`                        |
| worktree basename, else directory basename       | `project` label                    |
| `title`, `directory`, `agent`                    | same names                         |
| `model` JSON (`providerID`, `id`, `variant`)     | `ModelRef`                         |
| `time_created`, `time_updated`                   | ISO 8601 timestamps                |
| `tokens_*`, `cost`                               | `aggregateUsage`, `aggregateCost`  |
| `instruction_state` joined to `instruction_blob` | `instructions` (keys, chars, hash) |

Subagent relationships come from `parent_id`, never from an agent name.
OpenCode names subagent sessions `explore` or similar; only `parentId` is
authoritative.

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

Assistant and compaction messages may carry usage. `time.completed` becomes
`completedAt`, `finish` becomes `stopReason`, and `error.type` becomes
`errorType`. `textChars` is a character count, never the text.

### Tokens and cost

Phase 2 preserves the provider's categories exactly:

| Source               | Target                                |
| -------------------- | ------------------------------------- |
| `tokens.input`       | `TokenCounts.input`                   |
| `tokens.output`      | `TokenCounts.output`                  |
| `tokens.reasoning`   | `TokenCounts.thinking`                |
| `tokens.cache.read`  | `TokenCounts.cacheRead`               |
| `tokens.cache.write` | `TokenCounts.cacheWrite`              |
| `cost`               | `SourceUsage.observedUsd` when finite |

Phase 2 does not combine output and reasoning; Phase 3 defines priced output as
`output + thinking`, with `thinking` kept as the reported subset. A finite
observed cost of zero is preserved as zero. A missing cost is recorded as
`source.missing-cost`, never coerced to zero.

### Tools

Tool elements are projected from assistant `content[]` entries of type `tool`.
Only `name`, `id`, `state.input`, `state.status`, and the length of
`state.content` reach JavaScript.

- `id`: tool `id`, falling back to `name + index`.
- `name`: canonical name where known, otherwise the raw name.
- `signature`: a stable identity used for repeat detection.
- `target`: `input.path` or `input.filePath`, for every file tool.
- `resultChars`: SQL `length(state.content)`.
- `isError`: `state.status === "error"`.

Canonical names:

| Raw name(s)             | Canonical   |
| ----------------------- | ----------- |
| `read`                  | `Read`      |
| `write`                 | `Write`     |
| `edit`                  | `Edit`      |
| `shell`, `bash`, `exec` | `Bash`      |
| `execute`               | `Execute`   |
| `grep`                  | `Grep`      |
| `glob`                  | `Glob`      |
| `ls`                    | `LS`        |
| `webfetch`, `fetch`     | `WebFetch`  |
| `search`                | `Search`    |
| `find`                  | `Find`      |
| `print_tree`            | `PrintTree` |

Unknown names stay raw, so a new tool degrades to a distinct name rather than
collapsing into a known one.

Signatures read both OpenCode and Claude field spellings:

| Tool        | Signature                     |
| ----------- | ----------------------------- |
| `Read`      | `Read:path#offset:limit`      |
| `Write`     | `Write:path#contentHash`      |
| `Edit`      | `Edit:path#oldTextHash`       |
| `Bash`      | `Bash:command`                |
| `Execute`   | `Execute:command`             |
| `Grep`      | `Grep:pattern\|include\|path` |
| `Glob`      | `Glob:pattern\|path`          |
| `LS`        | `LS:path`                     |
| `Find`      | `Find:pattern\|path`          |
| `Search`    | `Search:query`                |
| `PrintTree` | `PrintTree:path`              |
| `WebFetch`  | `WebFetch:url`                |

`Grep` reads `pattern` or `regex` and `include` or `include_pattern`. `Glob`
reads `pattern` or `glob`. `Edit` reads `oldString` or `old_text`. The path is
part of grep and glob identities, so the same pattern in two directories is not
a false repeat.

`Edit` and `Write` signatures carry an 8-character FNV-1a hash of the changed
text, not the text. Two different edits to one file differ; the source code
never enters the serialised dataset. The hash is an identity aid, not a
security control.

## V1 mapping

OpenCode 1.x stores `session`, `message`, and `part`. Each `step-finish` part is
one model call, so it becomes one `SourceMessage` with id
`<messageId>#<partId>`. Tool parts before a `step-finish` part attach to that
call, then reset for the next call. `part.cost` becomes `observedUsd`.

V1 has no aggregate columns and no instruction-state table on this machine, so
those fields stay absent. The same tool normalization and signature rules
apply.

## Instructions and prefix hashes

For each session with `instruction_state`:

1. Parse `current_values` as a key-to-blob-hash map.
2. Sort keys.
3. Sum `length(instruction_blob.value)` per key. A missing blob produces
   `source.instruction-missing`.
4. Build `prefixHash` as the full SHA-256 hex digest over sorted `key=hash`
   lines.

The hash covers instruction blob identity only. It does **not** include agent,
provider, model, or variant, because hashing lives in `@munin/local` and receives
only the instruction join. Phase 3 groups cache identity by
`prefixHash + agent + model + variant` so two sessions with the same
instructions but different models are not treated as one cache prefix.

The character total counts instruction blobs only. Tool definitions and other
injected context are not included.

## Text stripping and privacy

The reader must never persist prompts, completions, compaction summaries, or
tool output. Stripping happens in SQL before rows reach JavaScript:

- `json_remove` drops `$.text`, `$.summary`, `$.recent`;
- nested `content[]` keeps structure but drops `*.text` and `*.state.content`;
- tool output is replaced by `length(state.content)`;
- instruction blob values are never selected, only joined lengths and hashes.

The V2 fixture inserts sentinel strings for prompt text, compaction summaries,
tool output, edit text, and write content, then asserts none survive
`JSON.stringify(dataset)`. Tool patterns and paths intentionally remain in
signatures. `scripts/read-local.mjs --check-privacy` walks the serialised
dataset and fails on banned keys (`text`, `summary`, `content`, `state`,
`output`). Titles, paths, hashes, and counts are allowed.

## Read-only guarantees

- Open with `new DatabaseSync(path, { readOnly: true })`.
- Set `PRAGMA busy_timeout = 5000` and `PRAGMA query_only = ON`.
- Never change journal mode, vacuum, create tables, or write.
- Close in `finally`, including when mapping throws.
- If the database stays busy, return `source.busy` rather than crashing.

On Windows, a read-only open of a WAL database can fail when the `-shm` file
cannot be created. Copy `opencode.db`, `-wal`, and `-shm` to a temporary
directory and read the copy. Do not write to the source to work around it.

## Warnings

Reader warnings are non-fatal and aggregated by code:

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

Each expected failure becomes a warning, not an exception. Diagnostics and
stream rules are in [`diagnostics.md`](./diagnostics.md).

## Manual verification

Use a stable snapshot because the live database changes while OpenCode runs:

```bash
DB="$HOME/.local/share/opencode/opencode.db"
SNAP="/tmp/munin-readers-snapshot.db"
rm -f "$SNAP"
sqlite3 "$DB" ".backup '$SNAP'"

npm run reader -- --db "$SNAP" --schema
npm run reader -- --db "$SNAP" --rows
npm run reader -- --db "$SNAP" --summary
npm run reader -- --db "$SNAP" --summary --json
npm run reader -- --db "$SNAP" --reconcile
npm run reader -- --db "$SNAP" --check-privacy
npm run reader -- --db "$SNAP" --session <session-id>
```

`--summary` reports subagent sessions from `parentId`. Message totals come from
messages, never from session aggregates; aggregates are only reconciled.

No-write proof:

```bash
before=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
npm run reader -- --db "$SNAP" --summary >/dev/null 2>&1 || true
after=$(shasum -a 256 "$SNAP" | cut -d' ' -f1)
test "$before" = "$after" && echo "database unchanged"
```

State directory proof:

```bash
MUNIN_DIR=$(mktemp -d) npm run reader -- --db "$SNAP" --summary
ls -A "$MUNIN_DIR"   # must print nothing
```

## Limits

- Only OpenCode 1.x and 2.x are read. Claude Code, Codex, Gemini, and import
  readers are deferred.
- Project identity uses the source's `project_id`. Labels are basenames, so two
  ids can share a label; analysis reports that collision rather than merging.
- Pagination across mixed sources is approximate. A full scan is the default.
- Aggregate disagreement is expected on a live database. Reconciliation warns;
  it never overrides message-level totals.
