import type { Snapshot, SnapshotDiff } from "../domain/ledger.js";

/** Compare two compact ledger snapshots without re-running analysis. */
export function diffSnapshots(previous: Snapshot, current: Snapshot): SnapshotDiff {
  const beforeModels = new Map(
    previous.byModel.map((row) => [`${row.provider}\0${row.model}`, row]),
  );
  const afterModels = new Map(current.byModel.map((row) => [`${row.provider}\0${row.model}`, row]));
  const modelKeys = [...new Set([...beforeModels.keys(), ...afterModels.keys()])].sort();
  const byModel = modelKeys
    .map((key) => {
      const before = beforeModels.get(key);
      const after = afterModels.get(key);
      const [provider, model] = key.split("\0");
      return {
        provider: provider ?? "",
        model: model ?? "",
        calls: (after?.calls ?? 0) - (before?.calls ?? 0),
        totalTokens: (after?.totalTokens ?? 0) - (before?.totalTokens ?? 0),
        headlineUsd: (after?.headlineUsd ?? 0) - (before?.headlineUsd ?? 0),
      };
    })
    .filter((row) => row.calls !== 0 || row.totalTokens !== 0 || row.headlineUsd !== 0);

  const beforeFindings = new Map(previous.findings.map((row) => [row.rule, row]));
  const afterFindings = new Map(current.findings.map((row) => [row.rule, row]));
  const appeared: string[] = [];
  const disappeared: string[] = [];
  const grew: string[] = [];
  for (const rule of new Set([...beforeFindings.keys(), ...afterFindings.keys()])) {
    const before = beforeFindings.get(rule);
    const after = afterFindings.get(rule);
    if (!before && after) appeared.push(rule);
    else if (before && !after) disappeared.push(rule);
    else if (
      before &&
      after &&
      (after.count > before.count || after.claimedWindowUsd > before.claimedWindowUsd)
    ) {
      grew.push(rule);
    }
  }

  const beforeSessions = previous.state.sessionsTracked;
  const afterSessions = current.state.sessionsTracked;
  return {
    fromId: previous.id,
    toId: current.id,
    sessions: {
      before: beforeSessions,
      after: afterSessions,
      delta: afterSessions - beforeSessions,
    },
    totals: {
      calls: current.totals.calls - previous.totals.calls,
      totalTokens: current.totals.totalTokens - previous.totals.totalTokens,
      headlineUsd: current.totals.headlineUsd - previous.totals.headlineUsd,
      observedUsd: current.totals.observedUsd - previous.totals.observedUsd,
      estimatedUsd: current.totals.estimatedUsd - previous.totals.estimatedUsd,
    },
    byModel,
    findings: {
      appeared: appeared.sort(),
      disappeared: disappeared.sort(),
      grew: grew.sort(),
    },
  };
}
