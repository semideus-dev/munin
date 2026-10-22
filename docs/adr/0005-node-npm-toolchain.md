# Node and npm are the contract; Bun is optional

The plan prefers Bun where it works, but the reference's SQLite access is `node:sqlite`, its tests are `node --test` against built output, and the author's machine runs Node 24 with a stable `node:sqlite`. Dual-runtime debugging is the documented risk. We therefore make `npm install && npm run build && npm test` the contract and keep Bun as an optional runner, not a dependency of any script. ESM, TypeScript, and the `packages/core` + `packages/local` + `apps/cli` workspace shape are preserved from the reference.
