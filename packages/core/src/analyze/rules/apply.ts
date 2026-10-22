import type { Finding } from "../../domain/finding.js";
import type { VerificationMode } from "../../domain/finding.js";
import type { ResolvedVerification } from "../verification.js";

/** Munin-owned analysis settings only. Source DB selection is deliberately excluded. */
export type MuninConfigKey = "days" | "tz";

export interface ConfigValueSnapshot {
  exists: boolean;
  value?: unknown;
}

export interface MuninConfigChange {
  rule: string;
  key: MuninConfigKey;
  value: number | string;
}

/** Host-injected access to Munin's own settings, never OpenCode configuration. */
export interface ConfigStore {
  read(key: MuninConfigKey): ConfigValueSnapshot;
  write(key: MuninConfigKey, value: ConfigValueSnapshot): void;
  /** Exact config-file bytes, so undo can preserve formatting and unknown keys. */
  snapshot(): string | null;
  restoreSnapshot(snapshot: string | null): void;
}

export interface ChangeManifestEntry {
  id: string;
  rule: string;
  at: string;
  /** Whole Munin config bytes before the write, including when the file was absent. */
  previousBytes?: string | null;
  keys: MuninConfigKey[];
  previous: Partial<Record<MuninConfigKey, ConfigValueSnapshot>>;
  values: Partial<Record<MuninConfigKey, ConfigValueSnapshot>>;
  status: "pending" | "applied" | "undo-pending" | "undone";
  restoredAt?: string;
  restoredKeys?: MuninConfigKey[];
}

/** Append-only so an interrupted apply leaves its captured prior state intact. */
export interface ChangeManifestStore {
  load(): readonly ChangeManifestEntry[];
  append(entry: ChangeManifestEntry): void;
}

export interface ApplyFindingInput {
  finding: Pick<Finding, "rule" | "fix" | "verification">;
  verification: ResolvedVerification;
  dataHealth: { clean: boolean; reconciliation: { mismatchSessions: number } };
  configStore: ConfigStore;
  changes: ChangeManifestStore;
  at: string;
  /** A change must be declared by trusted rule metadata before it reaches this seam. */
  configChange?: MuninConfigChange;
  confirmed: boolean;
  dryRun?: boolean;
}

export type ApplyOutcome =
  | { kind: "applied"; entry: ChangeManifestEntry }
  | { kind: "already-applied"; rule: string; key: MuninConfigKey }
  | { kind: "queued"; reason: string; next: string }
  | { kind: "refused"; reason: string }
  | { kind: "confirmation-required"; reason: string }
  | { kind: "dry-run"; reason: string; next: string }
  | { kind: "failed"; cause: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextAction(rule: string, fix: string, mode: VerificationMode): string {
  if (mode === "replay")
    return `Verify ${rule} on recorded traffic before applying; no live replay is available yet.`;
  if (mode === "manual")
    return `Validate manually, then run: npm run analyze -- --accept-risk ${rule}.`;
  return `Apply manually: ${fix}`;
}

function validChange(change: MuninConfigChange): boolean {
  if (change.key !== "days" && change.key !== "tz") return false;
  if (change.key === "days")
    return typeof change.value === "number" && Number.isFinite(change.value) && change.value > 0;
  return typeof change.value === "string" && change.value.trim().length > 0;
}

/**
 * Apply a declared Munin-settings change only after confirmation, clean-data,
 * and verification gates. Findings aimed at external agents are queued; this
 * function never edits agent prompts, OpenCode configuration, or source history.
 */
export function applyFinding(input: ApplyFindingInput): ApplyOutcome {
  const { finding, verification, dataHealth, configStore, changes } = input;
  const next = nextAction(finding.rule, finding.fix, verification.mode);

  // Dry-run is first: it never calls either injected store.
  if (input.dryRun === true) {
    return { kind: "dry-run", reason: "Dry run: no configuration or state was changed.", next };
  }
  if (!input.confirmed) {
    return {
      kind: "confirmation-required",
      reason: "Explicit user confirmation is required before applying a change.",
    };
  }
  if (verification.mode !== finding.verification) {
    return {
      kind: "refused",
      reason: "Verification mode does not match this finding; no change was made.",
    };
  }
  if (dataHealth.reconciliation.mismatchSessions > 0) {
    return {
      kind: "refused",
      reason: `Reconciliation has ${dataHealth.reconciliation.mismatchSessions} open mismatch session(s); no change was made.`,
    };
  }
  if (!dataHealth.clean) {
    return { kind: "refused", reason: "The analysis snapshot is not clean; no change was made." };
  }
  if (input.configChange === undefined) {
    if (!verification.canApply) {
      return {
        kind: "queued",
        reason: `${verification.headline} No pre-request integration is installed, so nothing was changed.`,
        next: verification.guidance ?? next,
      };
    }
    return {
      kind: "queued",
      reason: "No pre-request integration is installed, so nothing was changed.",
      next,
    };
  }
  if (input.configChange.rule !== finding.rule) {
    return {
      kind: "refused",
      reason: "Config change is not declared for this rule; no change was made.",
    };
  }
  if (!verification.canApply) {
    return {
      kind: "refused",
      reason: `${verification.headline} ${verification.guidance ?? "Verification has not cleared the apply gate."}`,
    };
  }
  if (!validChange(input.configChange)) {
    return { kind: "failed", cause: `Invalid Munin config value for '${input.configChange.key}'.` };
  }
  if (!Number.isFinite(Date.parse(input.at))) {
    return { kind: "failed", cause: "Apply timestamp must be a valid date." };
  }

  let previous: ConfigValueSnapshot;
  let previousBytes: string | null;
  try {
    previous = configStore.read(input.configChange.key);
    if (
      previous.exists &&
      JSON.stringify(previous.value) === JSON.stringify(input.configChange.value)
    ) {
      return { kind: "already-applied", rule: finding.rule, key: input.configChange.key };
    }
    previousBytes = configStore.snapshot();
  } catch (error) {
    return { kind: "failed", cause: `Could not capture prior config value: ${reasonOf(error)}` };
  }

  let journalLength: number;
  try {
    journalLength = changes.load().length;
  } catch (error) {
    return { kind: "failed", cause: `Could not inspect the changes journal: ${reasonOf(error)}` };
  }

  const entry: ChangeManifestEntry = {
    id: `${input.at}:${finding.rule}:${journalLength}`,
    rule: finding.rule,
    at: input.at,
    previousBytes,
    keys: [input.configChange.key],
    previous: { [input.configChange.key]: previous },
    values: {
      [input.configChange.key]: { exists: true, value: input.configChange.value },
    },
    status: "pending",
  };

  try {
    // Journal the complete previous value before touching configuration.
    changes.append(entry);
  } catch (error) {
    return {
      kind: "failed",
      cause: `Could not record the prior config snapshot: ${reasonOf(error)}`,
    };
  }

  try {
    configStore.write(input.configChange.key, {
      exists: true,
      value: input.configChange.value,
    });
    const actual = configStore.read(input.configChange.key);
    if (
      !actual.exists ||
      JSON.stringify(actual.value) !== JSON.stringify(input.configChange.value)
    ) {
      throw new Error(
        `Config store did not retain the declared value for '${input.configChange.key}'.`,
      );
    }
    const applied = { ...entry, status: "applied" as const };
    changes.append(applied);
    return { kind: "applied", entry: applied };
  } catch (error) {
    return {
      kind: "failed",
      cause: `Config apply failed after journaling prior state: ${reasonOf(error)}`,
    };
  }
}

export type UndoOutcome =
  | { kind: "undone"; entry: ChangeManifestEntry; remainingPending: string[] }
  | { kind: "nothing-to-undo" }
  | { kind: "confirmation-required" }
  | { kind: "dry-run"; entryId: string; remainingPending: string[] }
  | { kind: "failed"; cause: string; remainingPending: string[] };

function pendingIds(
  initial: readonly ChangeManifestEntry[],
  latest: ReadonlyMap<string, ChangeManifestEntry>,
): string[] {
  return initial
    .filter((entry) => {
      const state = latest.get(entry.id)?.status;
      return state === "pending" || state === "applied" || state === "undo-pending";
    })
    .map((entry) => entry.id);
}

/** Restore the most recently applied or interrupted change. */
export function undoLatestChange(input: {
  configStore: ConfigStore;
  changes: ChangeManifestStore;
  at: string;
  confirmed: boolean;
  dryRun?: boolean;
}): UndoOutcome {
  if (!input.confirmed) return { kind: "confirmation-required" };
  if (!Number.isFinite(Date.parse(input.at))) {
    return { kind: "failed", cause: "Undo timestamp must be a valid date.", remainingPending: [] };
  }

  let journal: readonly ChangeManifestEntry[];
  try {
    journal = input.changes.load();
  } catch (error) {
    return {
      kind: "failed",
      cause: `Could not read changes journal: ${reasonOf(error)}`,
      remainingPending: [],
    };
  }

  const initialById = new Map<string, ChangeManifestEntry>();
  const latestById = new Map<string, ChangeManifestEntry>();
  for (const entry of journal) {
    if (!initialById.has(entry.id)) initialById.set(entry.id, entry);
    latestById.set(entry.id, entry);
  }
  const initial = [...initialById.values()];
  const selected = initial
    .slice()
    .reverse()
    .find((entry) => {
      const state = latestById.get(entry.id)?.status;
      return state === "pending" || state === "applied" || state === "undo-pending";
    });
  if (selected === undefined) return { kind: "nothing-to-undo" };

  const remaining = pendingIds(initial, latestById);
  if (input.dryRun === true)
    return { kind: "dry-run", entryId: selected.id, remainingPending: remaining };

  const restoredKeys = [...selected.keys].reverse();
  const undoPending: ChangeManifestEntry = {
    ...selected,
    status: "undo-pending",
    restoredAt: input.at,
    restoredKeys,
  };
  try {
    input.changes.append(undoPending);
  } catch (error) {
    return {
      kind: "failed",
      cause: `Could not record undo intent: ${reasonOf(error)}`,
      remainingPending: remaining,
    };
  }

  try {
    if (Object.hasOwn(selected, "previousBytes")) {
      input.configStore.restoreSnapshot(selected.previousBytes ?? null);
      const actual = input.configStore.snapshot();
      if (actual !== (selected.previousBytes ?? null)) {
        throw new Error("Restored config bytes do not match the saved prior snapshot.");
      }
    } else {
      // Compatibility for an older key-only journal entry.
      for (const key of restoredKeys) {
        const previous = selected.previous[key];
        if (previous === undefined) throw new Error(`Journal has no prior value for '${key}'.`);
        input.configStore.write(key, previous);
      }
      for (const key of restoredKeys) {
        const expected = selected.previous[key];
        const actual = input.configStore.read(key);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`Restored value for '${key}' does not match its saved prior value.`);
        }
      }
    }

    const undone: ChangeManifestEntry = { ...undoPending, status: "undone" };
    input.changes.append(undone);
    const latestAfter = new Map(latestById);
    latestAfter.set(selected.id, undone);
    return {
      kind: "undone",
      entry: undone,
      remainingPending: pendingIds(initial, latestAfter).filter((id) => id !== selected.id),
    };
  } catch (error) {
    return {
      kind: "failed",
      cause: `Undo failed; the journal entry remains pending for retry: ${reasonOf(error)}`,
      remainingPending: remaining,
    };
  }
}
