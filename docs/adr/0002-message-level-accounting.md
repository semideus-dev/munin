# Accounting authority is the message, not the session aggregate

OpenCode 2.x stores usage twice: per `session_message` row and as per-session aggregates on `session_v2`. They disagree. On the author's real database the gap reaches 13% (1,082,691 input tokens aggregated versus 960,138 from messages), and parent-session aggregates do not include child sessions. We treat message-level usage as authoritative and the session aggregate as a warning-only cross-check, reporting any difference above 1% under data health. Compaction messages count as real model calls because they carry model, cost, and token fields; their summary text is never stored.

## Considered options

- Trust the session aggregate: simplest totals, but no model, agent, project, tool, or per-call attribution, which every rule needs.
- Merge with precedence: hides the disagreement instead of surfacing it.

## Consequences

- Every rule reads `UsageEvent` list, never session columns.
- Reconciliation deltas are user-visible, so a schema change cannot silently skew the report.
