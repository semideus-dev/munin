import { WARNING_CODES, type Dataset, type SourceMessage, type SourceSession, type SourceWarning } from "../index.js";

export interface MergeDatasetsOptions {
  v1: Dataset;
  v2: Dataset;
  v1Count: number;
  v2Count: number;
  limit?: number;
  offset?: number;
}

function byTimeUpdatedDesc(a: SourceSession, b: SourceSession): number {
  return b.timeUpdated.localeCompare(a.timeUpdated);
}

function byMessageOrder(a: SourceMessage, b: SourceMessage): number {
  if (a.timeCreated !== b.timeCreated) {
    return a.timeCreated.localeCompare(b.timeCreated);
  }
  return a.seq - b.seq;
}

export function mergeDatasets(options: MergeDatasetsOptions): Dataset {
  const v2SessionIds = new Set(options.v2.sessions.map((session) => session.id));

  const sessionMap = new Map<string, SourceSession>();
  for (const session of options.v1.sessions) {
    sessionMap.set(session.id, session);
  }
  for (const session of options.v2.sessions) {
    sessionMap.set(session.id, session);
  }

  let sessions = [...sessionMap.values()].sort(byTimeUpdatedDesc);

  // Approximation policy: limit/offset are applied per source first, then merged,
  // then applied again to merged sessions.
  const offset = options.offset ?? 0;
  const limit = options.limit;
  if (offset > 0 || limit !== undefined) {
    sessions = sessions.slice(offset, limit === undefined ? undefined : offset + limit);
  }

  const keptSessionIds = new Set(sessions.map((session) => session.id));

  const v1Messages = options.v1.messages.filter(
    (message) => keptSessionIds.has(message.sessionId) && !v2SessionIds.has(message.sessionId),
  );
  const v2Messages = options.v2.messages.filter((message) => keptSessionIds.has(message.sessionId));
  const messages = [...v1Messages, ...v2Messages].sort(byMessageOrder);

  const warnings: SourceWarning[] = [...options.v1.warnings, ...options.v2.warnings];
  warnings.push({
    code: WARNING_CODES.sourceMixedSchema,
    message: "Both v1 and v2 sessions are present; v2 rows take precedence for shared session ids",
    count: options.v1Count + options.v2Count,
  });

  const sources = [...new Set([...options.v1.sources, ...options.v2.sources])];

  return {
    schema: "mixed",
    sessions,
    messages,
    warnings,
    sources,
  };
}
