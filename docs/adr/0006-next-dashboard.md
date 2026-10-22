# Dashboard is a Next application, not a separate API

The dashboard is `apps/dashboard`, a Next.js App Router application with Tailwind and shadcn components. Route handlers import `@munin/core` and `@munin/local` directly, so there is no second backend and no client-side pricing or aggregation; the CLI calls the same core functions. It runs as its own localhost process during development; a `munin dashboard` wrapper is a later convenience. This deviates from the plan's "for example React + Vite" because one process with server-side handlers removes a server boundary and a class of total-mismatch bugs.

## Consequences

- Charts render from server-computed report objects; the browser never sees raw prompts.
- Action endpoints exist only for the three config rules in ADR-0004.
