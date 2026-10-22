/**
 * Per-session summaries.
 *
 * A subagent session stays its own row and is linked to its parent only by
 * `parentSessionId`; nothing here rolls a child into its parent, so session
 * sums always add back to the totals exactly once.
 */
import type { CallAttempt, SessionSummary } from "../domain/analysis.js";
import type { SourceSession } from "../domain/source.js";
import type { UsageEvent } from "../domain/usage.js";

/** Codepoint order, so results never depend on the runtime locale. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Summarise the sessions behind priced events.
 *
 * `sessions` contributes source metadata such as titles. `attempts` makes the
 * compaction count exact (it covers failed compactions too); without it the
 * count falls back to the highest context epoch observed in the session.
 * Events should be in the stable order buildEvents() returns.
 */
export function sessionSummaries(
  events: UsageEvent[],
  sessions?: SourceSession[],
  attempts?: CallAttempt[],
): SessionSummary[] {
  const meta = new Map<string, SourceSession>();
  for (const session of sessions ?? []) meta.set(session.id, session);

  const grouped = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.sessionId);
    if (list === undefined) grouped.set(event.sessionId, [event]);
    else list.push(event);
  }

  const compactions = new Map<string, number>();
  if (attempts !== undefined) {
    for (const attempt of attempts) {
      if (attempt.type !== "compaction") continue;
      compactions.set(attempt.sessionId, (compactions.get(attempt.sessionId) ?? 0) + 1);
    }
  } else {
    for (const [id, list] of grouped) {
      let maxEpoch = 0;
      for (const event of list) {
        const epoch = event.contextEpoch ?? 0;
        if (epoch > maxEpoch) maxEpoch = epoch;
      }
      if (maxEpoch > 0) compactions.set(id, maxEpoch);
    }
  }

  const summaries: SessionSummary[] = [];

  for (const [id, list] of grouped) {
    const first = list[0];
    if (first === undefined) continue;
    const session = meta.get(id);

    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let observedUsd = 0;
    let estimatedUsd = 0;
    let headlineUsd = 0;
    let observedCalls = 0;
    let unpriced = false;

    const agents = new Set<string>();
    const models = new Set<string>();
    const turnIds = new Set<string>();

    let firstTs: string | null = null;
    let firstMs = Number.POSITIVE_INFINITY;
    let lastTs: string | null = null;
    let lastMs = Number.NEGATIVE_INFINITY;

    for (const event of list) {
      inputTokens += event.inputTokens;
      outputTokens += event.outputTokens;
      thinkingTokens += event.thinkingTokens;
      cacheReadTokens += event.cacheReadTokens;
      cacheWriteTokens += event.cacheWrite5mTokens + event.cacheWrite1hTokens;
      observedUsd += event.cost.observedUsd ?? 0;
      if (event.cost.estimatedUsd !== null) estimatedUsd += event.cost.estimatedUsd;
      headlineUsd += event.cost.total;
      if (event.cost.observedUsd !== null) observedCalls += 1;
      if (event.cost.unpriced) unpriced = true;

      agents.add(event.agent ?? "unknown");
      models.add(`${event.provider}/${event.model}`);
      if (event.turnId !== undefined) turnIds.add(event.turnId);

      const eventMs = Date.parse(event.ts);
      if (Number.isFinite(eventMs) && eventMs < firstMs) {
        firstMs = eventMs;
        firstTs = event.ts;
      }
      const end = event.endTs ?? event.ts;
      const endMs = Date.parse(end);
      if (Number.isFinite(endMs) && endMs > lastMs) {
        lastMs = endMs;
        lastTs = end;
      }
    }

    const inputSide = inputTokens + cacheReadTokens + cacheWriteTokens;
    const summary: SessionSummary = {
      id,
      ...(session?.title === undefined ? {} : { title: session.title }),
      ...(first.projectId === undefined ? {} : { projectId: first.projectId }),
      project: first.project,
      ...(first.parentSessionId === undefined ? {} : { parentSessionId: first.parentSessionId }),
      isSubagent: first.isSubagent === true,
      agents: [...agents].sort(asc),
      models: [...models].sort(asc),
      schema: session?.schema ?? first.schema,
      firstTs,
      lastTs,
      calls: list.length,
      turns: turnIds.size,
      inputTokens,
      outputTokens,
      thinkingTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      observedUsd,
      estimatedUsd,
      headlineUsd,
      cacheHitRate: inputSide === 0 ? null : cacheReadTokens / inputSide,
      unpriced,
      compactions: compactions.get(id) ?? 0,
      observedCoverage: observedCalls / list.length,
    };
    summaries.push(summary);
  }

  return summaries.sort((a, b) =>
    a.headlineUsd !== b.headlineUsd ? b.headlineUsd - a.headlineUsd : asc(a.id, b.id),
  );
}
