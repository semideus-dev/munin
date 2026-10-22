# Readers live in `@munin/local`; core stays pure

Optimaizr's own contributor guide says `packages/core` must not import `fs`, `net`, or read `process.env`, yet all four history readers live there and do exactly that. We are resolving the contradiction in favour of the documented rule: `@munin/core` holds normalization, pricing, analysis, rules, and report contracts and receives data plus injected ports; `@munin/local` owns every filesystem, SQLite, process, and network access. The cost is one `DbHandle`-style seam and moving schema detection out of core. The benefit is that rules stay testable with plain fixtures and the dashboard server cannot reach the filesystem except through `local`.

## Consequences

- Ported ingestion code splits: SQL/pragma access to `local/readers`, record mapping to `core/normalize`.
- Core takes normalized records and price overrides; it never opens the source database.
- Any future reader (V1, imports) follows the same seam.
