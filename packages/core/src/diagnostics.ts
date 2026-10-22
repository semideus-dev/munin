/**
 * Process-level diagnostics: how a command names and reports failure.
 *
 * This is not report content. "Data health" is the scan's account of what it
 * read; diagnostics are how the process tells a human or a script that
 * something went wrong. See `docs/diagnostics.md`.
 */

/** What kind of failure occurred, which decides the process exit code. */
export type MuninErrorKind = "usage" | "config" | "source" | "ledger" | "action";

export interface MuninErrorOptions {
  /** Stable, dot-namespaced code, e.g. `source.missing-db`. */
  code: string;
  kind: MuninErrorKind;
  /** One sentence for a human. Never includes a stack trace. */
  message: string;
  cause?: unknown;
}

/**
 * An expected failure. Commands throw this for conditions a user can fix:
 * a missing database, an unreadable file, an unsupported rule.
 */
export class MuninError extends Error {
  readonly code: string;
  readonly kind: MuninErrorKind;

  constructor(options: MuninErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MuninError";
    this.code = options.code;
    this.kind = options.kind;
  }
}

/**
 * Every non-fatal warning code Munin can emit. Frozen so docs and tests cannot
 * drift from the implementation. Phase 2 adds `source.*`; Phase 3 adds
 * `price.*` and `analysis.*`.
 */
export const WARNING_CODES = {
  configUnreadable: "config.unreadable",
  configUnparseable: "config.unparseable",
  configInvalid: "config.invalid",
  configInvalidDb: "config.invalid-db",
  configInvalidDays: "config.invalid-days",
  configInvalidTz: "config.invalid-tz",

  sourceMissingDb: "source.missing-db",
  sourceUnreadable: "source.unreadable",
  sourceBusy: "source.busy",
  sourceNoSchema: "source.no-schema",
  sourceEmpty: "source.empty",
  sourceMixedSchema: "source.mixed-schema",
  sourceInvalidJson: "source.invalid-json",
  sourceUnknownType: "source.unknown-type",
  sourceUnknownModel: "source.unknown-model",
  sourceMissingCost: "source.missing-cost",
  sourceAggregateMismatch: "source.aggregate-mismatch",
  sourceInstructionMissing: "source.instruction-missing",

  priceUnpricedModel: "price.unpriced-model",

  analysisNoEvents: "analysis.no-events",
  analysisProjectLabelCollision: "analysis.project-label-collision",
  analysisInvalidFinding: "analysis.invalid-finding",
  analysisDetectorError: "analysis.detector-error",
} as const;

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES];
