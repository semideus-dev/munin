# Local ledger and privacy

Munin keeps derived runtime state in `~/.munin` by default. `MUNIN_DIR` or
`--state-dir` selects a different state directory. The OpenCode database is
separate and is always opened read-only; Munin never writes to source history.
OpenCode prompt text and tool-result text are not read into or copied to the
ledger.

## Files in the state directory

| File                 | Contents                                                                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.jsonl`       | One priced `UsageEvent` slice per scanned session. A later slice for the same session replaces it when read. It contains model/provider identifiers, timestamps, usage/cost figures, normalized tool names/signatures, and limited instruction metadata—not message bodies or tool results. |
| `snapshots.jsonl`    | One compact summary per successful scan: scope, tracked counts, window, totals, per-model totals, finding counts/claimed amounts, cleanliness and warning counts. It does not contain a report or finding details.                                                                          |
| `cursors.json`       | Atomic JSON cursor with the source schema, the independent V1/V2 `time_updated` watermarks, and the cursor timestamp. A missing/invalid cursor causes a full read; it is never guessed.                                                                                                     |
| `changes.jsonl`      | Phase 4 apply/undo manifest entries for Munin-owned settings. Entries include rule/status information and the captured previous Munin-config bytes needed for safe undo. This is local configuration state, not OpenCode history; do not store prompts in Munin configuration.              |
| `decisions.json`     | Recommendation decisions keyed by rule, with status and timestamp.                                                                                                                                                                                                                          |
| `verifications.json` | Verification state keyed by rule, including mode, outcome and timestamp.                                                                                                                                                                                                                    |
| `config.json`        | Optional Munin settings such as source database path, reporting window and timezone.                                                                                                                                                                                                        |
| `scan.lock`          | Temporary single-writer lock containing the owning PID, start time and purpose. It is removed when the scan releases the lock; dead-process locks can be recovered.                                                                                                                         |

Instruction metadata contains instruction key names, character counts and a
one-way prefix hash only. Instruction text is not stored.

## Refresh and recovery

`npm run scan` performs an incremental read. It polls OpenCode at the session
level through SQLite, re-reads sessions in the 30-second watermark overlap,
and replaces their ledger slices rather than adding their usage again. The
watch mode polls the source file (2 seconds by default) and runs a scan when
its fingerprint changes. On restart, it resumes from `cursors.json`.

Use `npm run scan -- --full` to read all sessions and compare fresh slices with
the ledger. Drift is reported; `npm run scan -- --full --repair` explicitly
rewrites slices from the full read when drift or torn slice lines are found.
Malformed JSONL records are skipped and counted during ordinary reads. A
privacy-checked scan is stricter: invalid or unsafe ledger records fail that
cycle, and the cursor is not advanced.

`npm run scan -- --snapshots` lists saved summaries and the latest trend diff.
`npm run scan -- --results` compares saved, priced usage against applied periods
from `changes.jsonl`; neither command rereads the OpenCode database. Results use
generic cost-per-turn (or cost-per-call) and call-load comparisons. If the apply
journal has no applied entries, the command reports that explicitly.

## Privacy check

Run `npm run scan -- --check-privacy` to validate the slice and snapshot
journals and candidate cursor during a scan, or keep it enabled in watch mode
with `npm run scan -- --watch --check-privacy`. Slice and snapshot serializers
validate their schemas and refuse unexpected fields; the privacy walk also
refuses the sensitive field names `text`, `summary`, `content`, `state`,
`output`, `prompt`, and `oldString`. The usage-cost field `cost.output` is the
only matching key that is part of the approved schema. Snapshot `state` is
limited to its validated numeric counters; arbitrary state payloads are still
refused.

To remove all Munin state, remove the selected state directory (the default is
`~/.munin`), for example `rm -rf "${MUNIN_DIR:-$HOME/.munin}"`. This also
deletes local settings, decisions, verifications and the apply/undo history.
The OpenCode database is not affected; a later scan can rebuild derived usage
state from it.
