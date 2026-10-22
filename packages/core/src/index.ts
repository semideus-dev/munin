// The pure engine: normalization, pricing, analysis, rules, and report contracts.
// No fs, net, or process access belongs here (docs/adr/0001-readers-live-in-local.md).
export * from "./domain/index.js";
export * from "./normalize/rows.js";
export * from "./normalize/time.js";
export * from "./normalize/text.js";
export * from "./normalize/tools.js";
export * from "./normalize/opencode-v2.js";
export * from "./normalize/opencode-v1.js";
export * from "./normalize/reconcile.js";
export * from "./normalize/merge.js";
export * from "./pricing/index.js";
export * from "./analyze/index.js";
export * from "./report/report.js";
export * from "./diagnostics.js";
