# Diagnostics

How Munin reports failure and non-fatal warnings. This is process behaviour,
not report content. What a scan read and could not read is data health and
belongs in the report.

## Streams

- **stdout** carries only the requested data. With `--json`, stdout is a single
  valid JSON document: no banners, no progress. A streaming command (`munin
live`) is the exception: with `--json` it writes one JSON object per event,
  one per line.
- **stderr** carries warnings, progress, and errors.
- **The exit code** is the signal scripts should branch on.

## Exit codes

| Code | Meaning                           | Examples                                           |
| ---- | --------------------------------- | -------------------------------------------------- |
| `0`  | Success, with or without warnings | scan completed                                     |
| `1`  | Runtime error                     | missing database, unreadable file, malformed input |
| `2`  | Unsupported or not automatable    | applying a behavioural rule, replay unavailable    |
| `64` | Usage error                       | unknown flag, flag without a value                 |

An unexpected exception is a bug and exits `1` with code `internal`.

## Errors

Commands throw `MuninError`:

```ts
new MuninError({
  code: "source.missing-db",
  kind: "source",
  message: "No OpenCode database at /home/ana/.local/share/opencode/opencode.db",
});
```

| Kind     | Exit | Covers                                      |
| -------- | ---- | ------------------------------------------- |
| `usage`  | `64` | bad flags or arguments                      |
| `action` | `2`  | a rule that cannot be applied automatically |
| `config` | `1`  | unreadable or invalid configuration         |
| `source` | `1`  | missing or unreadable source history        |
| `ledger` | `1`  | Munin's own state is corrupt or unwritable  |

Codes are dot-namespaced (`config.*`, `source.*`, `ledger.*`, `action.*`). A code
is stable once released; change the message, not the code.

The command dispatcher also uses these `cli.*` codes:

| Code                   | Exit | Meaning                                            |
| ---------------------- | ---- | -------------------------------------------------- |
| `cli.unknown-command`  | `64` | no command by that name in the command table       |
| `cli.missing-value`    | `64` | a value flag was given without a value             |
| `cli.missing-argument` | `64` | a required positional argument was omitted         |
| `cli.invalid-value`    | `64` | a value flag was given a value that cannot be used |
| `cli.not-implemented`  | `2`  | a recognised command is not wired in this build    |

Command-specific codes follow the same rules:

| Code                     | Exit | Meaning                                                 |
| ------------------------ | ---- | ------------------------------------------------------- |
| `rules.unknown-rule`     | `64` | a rule id passed to `show` is not in the registry       |
| `state.lock-held`        | `1`  | another writer holds the scan lock                      |
| `state.lock-unremovable` | `1`  | a stale scan lock exists and cannot be removed          |
| `ledger.scan-failed`     | `1`  | a scan failed for a reason without a more specific code |

Rules:

- No stack trace for an expected failure.
- No stack trace in `--json` mode at all.
- `MUNIN_DEBUG=1` prints the stack to stderr, after the normal message.
- A `cause` is kept for the debug path, never serialised by default.

## Warnings

Warnings are non-fatal: the command still succeeds. They use `SourceWarning`:

```ts
{ code: "config.unparseable", message: "config.json is not valid JSON; using defaults" }
```

Registry (frozen in `WARNING_CODES`, `packages/core/src/diagnostics.ts`):

| Code                  | Meaning                                    |
| --------------------- | ------------------------------------------ |
| `config.unreadable`   | settings file exists but could not be read |
| `config.unparseable`  | settings file is not valid JSON            |
| `config.invalid`      | settings file is not a JSON object         |
| `config.invalid-db`   | `db` is not a non-empty string             |
| `config.invalid-days` | `days` is not a positive number            |
| `config.invalid-tz`   | `tz` is not a non-empty string             |

Phase 2 adds `source.*` codes for skipped records, unknown schemas, and
aggregate reconciliation. Phase 3 adds `price.*` and `analysis.*` codes.

| Code                               | Meaning                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `price.unpriced-model`             | a model has calls but no card; aggregated by model, with its call count and observed spend |
| `analysis.no-events`               | the dataset contains no usage-bearing model calls                                          |
| `analysis.project-label-collision` | one project label maps to more than one project id                                         |
| `analysis.invalid-finding`         | a detector produced a finding without its calculation or assumptions                       |
| `analysis.detector-error`          | a detector threw and was skipped; named with the rule that failed                          |

Aggregation: one line per code, with `count` when it covers many records. Do not
print the same warning N times.

Phase 5 adds `state.*`, `ledger.*` and `watch.*` codes for the scan and watch
runtime. `scan` and `live` both print them to stderr, deduplicated by code.

| Code                            | Meaning                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `state.cursor-unreadable`       | the stored scan cursor could not be read; the next scan is full |
| `state.lock-recovered`          | a provably stale writer lock was reclaimed                      |
| `ledger.slice-lines-skipped`    | malformed slice journal lines were skipped, with the count      |
| `ledger.snapshot-lines-skipped` | malformed snapshot journal lines were skipped, with the count   |
| `ledger.reconciliation-drift`   | a full read found session slices that differ from the ledger    |
| `watch.full-rescan`             | `live` saw the source replaced or truncated and rescanned all   |

## JSON contract

Success:

```json
{
  "ok": true,
  "data": {},
  "warnings": []
}
```

Failure:

```json
{
  "ok": false,
  "error": { "code": "source.missing-db", "message": "No OpenCode database at ..." }
}
```

`warnings` is always present on success, even when empty. `data` is the
command's documented payload. Nothing else is printed to stdout.

## Presentation

- Plain punctuation. No emoji, no box drawing, no em dashes.
- Colour only when stdout is a TTY, `NO_COLOR` is unset, and `TERM` is not
  `dumb`. Piped output is always plain.
- Windows consoles: never rely on ANSI for meaning, and keep output ASCII
  where practical. Paths keep their native separators.
- Paths are printed absolute. `~` is never expanded by Munin; shells do that.

## Not covered here

- Data health: schema detected, records skipped, unpriced models,
  reconciliation deltas. That is report content.
- Command-specific error codes. Add them with the command and register them in
  this file.
