import type { Finding, VerificationMode } from "../domain/finding.js";
import type { VerificationRecord, VerificationState } from "../domain/verification.js";

export interface VerificationSubject {
  verification?: VerificationMode;
  risk: "safe" | "needs-verification";
  candidate?: Finding["candidate"];
}

/** Decide whether a finding needs no check, replay, or user sign-off. */
export function verificationModeOf(finding: VerificationSubject): VerificationMode {
  if (finding.verification !== undefined) return finding.verification;
  if (finding.risk === "safe") return "not-required";
  return finding.candidate === undefined ? "manual" : "replay";
}

export function stateForVerdict(verdict: "PASS" | "FAIL" | "INCONCLUSIVE"): VerificationState {
  if (verdict === "PASS") return "passed";
  if (verdict === "FAIL") return "failed";
  return "inconclusive";
}

export interface ResolvedVerification {
  state: VerificationState;
  mode: VerificationMode;
  canApply: boolean;
  headline: string;
  guidance: string | null;
  record: VerificationRecord | null;
}

/** Pure gate shared by verification display and the apply seam. */
export function resolveVerification(
  finding: VerificationSubject,
  record: VerificationRecord | null,
): ResolvedVerification {
  const mode = verificationModeOf(finding);

  if (mode === "not-required") {
    return {
      state: "not_required",
      mode,
      canApply: true,
      headline: "No verification required; this change removes waste without changing output.",
      guidance: null,
      record,
    };
  }

  if (mode === "manual") {
    if (record?.mode === "manual" && record.acceptedRiskAt !== undefined) {
      return {
        state: "passed",
        mode,
        canApply: true,
        headline: `Risk accepted on ${record.acceptedRiskAt.slice(0, 10)}; verified by you, not by replay.`,
        guidance: null,
        record,
      };
    }
    return {
      state: "unverified",
      mode,
      canApply: false,
      headline: "This change can alter output, and replay cannot settle it.",
      guidance:
        "Validate the change on your own evaluation or staging traffic, then record acceptance with --accept-risk.",
      record,
    };
  }

  if (record === null || record.mode !== "replay") {
    return {
      state: "unverified",
      mode,
      canApply: false,
      headline: "Not verified.",
      guidance: "This change can alter output; replay verification is required before applying it.",
      record,
    };
  }
  if (record.state === "passed") {
    return {
      state: "passed",
      mode,
      canApply: true,
      headline: `Verified PASS on ${record.at.slice(0, 10)}${record.samples === undefined ? "" : `, ${record.samples} samples`}.`,
      guidance: null,
      record,
    };
  }
  if (record.state === "failed") {
    return {
      state: "failed",
      mode,
      canApply: false,
      headline: `Verification failed on ${record.at.slice(0, 10)}.`,
      guidance: "This change did not clear the quality bar; do not apply it based on this result.",
      record,
    };
  }
  return {
    state: "inconclusive",
    mode,
    canApply: false,
    headline: `Verification was inconclusive on ${record.at.slice(0, 10)}.`,
    guidance: "Capture more samples and verify again; an inconclusive result does not allow apply.",
    record,
  };
}

/** Host-provided persistence. Core has no filesystem or process access. */
export interface VerificationStore {
  load(): Readonly<Record<string, VerificationRecord>>;
  save(all: Readonly<Record<string, VerificationRecord>>): void;
}

export function recordVerification(store: VerificationStore, entry: VerificationRecord): void {
  const all = { ...store.load() };
  const previous = all[entry.rule];
  all[entry.rule] = {
    ...entry,
    ...(entry.acceptedRiskAt === undefined && previous?.acceptedRiskAt !== undefined
      ? { acceptedRiskAt: previous.acceptedRiskAt }
      : {}),
  };
  store.save(all);
}

/** Record the user's explicit acceptance for a manual-only verification mode. */
export function acceptRisk(
  store: VerificationStore,
  rule: string,
  mode: VerificationMode,
  at: string,
  note?: string,
): VerificationRecord {
  if (mode !== "manual")
    throw new TypeError(`risk acceptance is only valid for manual rules: ${rule}`);
  if (!Number.isFinite(Date.parse(at)))
    throw new TypeError("verification timestamp must be a valid date");
  const record: VerificationRecord = {
    rule,
    at,
    mode: "manual",
    state: "passed",
    acceptedRiskAt: at,
    note: note ?? "Risk accepted by the user; replay cannot settle this rule.",
  };
  recordVerification(store, record);
  return record;
}
