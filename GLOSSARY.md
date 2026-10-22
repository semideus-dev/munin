# Munin

Munin reads a developer's local coding-agent history and explains where the money went and what could be avoided. It is a rebuild of Optimaizr with OpenCode 2.x support and a local dashboard. Machine names use `munin`; prose uses "Munin".

## Language

**Optimaizr**:
The existing product under `optimaizr/`, kept as a read-only behavioural reference.
_Avoid_: old repo, legacy app, upstream

**Munin**:
This repository: the rebuild.
_Avoid_: optimaizr-rebuild, new app

**Source history**:
The user's local OpenCode database, read but never written.
_Avoid_: data store, input DB

**Ledger**:
Munin's own derived state: analysis snapshots, decisions, and the change journal. It is not a copy of source history.
_Avoid_: database, cache

**Scan**:
One pass over source history that produces normalized records and derived analysis.
_Avoid_: sync, import

**Incremental scan**:
A scan that processes only records newer than the last recorded position.
_Avoid_: delta sync

**Live**:
Repeated incremental scans while the user works, refreshing output in place.
_Avoid_: watch mode, streaming

**Session**:
One OpenCode conversation. Its cost covers its own model calls and excludes any child sessions.
_Avoid_: chat, thread, conversation

**Subagent session**:
A session created by another session, linked by a parent reference. Shown separately and rolled up for display, never double counted.
_Avoid_: child chat, sidechain

**Message**:
One stored record in a session. Messages may be model output, user input, compaction, lifecycle notices, or synthetic context.
_Avoid_: row, entry

**Model call**:
One billable request to a provider: either an assistant message carrying usage or a compaction. The unit of analysis.
_Avoid_: event, request, completion

**Tool call**:
A tool invocation inside a model call, with input, status, and output. Not independently billable.
_Avoid_: tool event

**Turn**:
One user prompt plus the model calls and tool calls it caused.
_Avoid_: step, round

**Instruction set**:
The system-level context attached to a session: agent instructions, skills, and tool definitions, identified by content hashes.
_Avoid_: system prompt, prefix

**Observed cost**:
The cost the provider reported for a call, as recorded in source history. The headline figure.
_Avoid_: actual cost, real cost

**API-equivalent cost**:
What the same tokens would cost at Munin's dated list prices. Secondary and always labelled.
_Avoid_: list cost, theoretical cost

**Savings estimate**:
Money a finding claims could be avoided, with an evidence class, calculation, and assumptions.
_Avoid_: savings, opportunity

**Evidence class**:
One of `measured`, `inferred`, or `estimated`. Every figure carries one.
_Avoid_: confidence

**Recoverable spend**:
The de-overlapped total of savings claims, counting each model call at most once.
_Avoid_: total savings, bankable

**Unpriced call**:
A model call with no rate card. Reported as unpriced; never dropped and never treated as free.
_Avoid_: unknown cost

**Finding**:
A detected opportunity with evidence and a savings estimate. Does not imply that a change was made.
_Avoid_: insight, issue

**Recommendation**:
A finding ranked and phrased as advice, with its trade-offs.
_Avoid_: suggestion, tip

**Rule**:
The detector that produces at most one finding.
_Avoid_: check, heuristic

**Data health**:
The scan's account of what it read and could not read: schema detected, records skipped, unpriced models, and reconciliation deltas.
_Avoid_: diagnostics

**Apply**:
A supported, reversible change written to project-level OpenCode configuration.
_Avoid_: fix, patch

**Undo**:
Restoring the exact configuration that existed before an apply.
_Avoid_: revert, rollback

**Verify**:
Replaying a real request to compare output quality. Distinct from arithmetic simulation.
_Avoid_: test, replay check
