/**
 * Turn and context-epoch assignment.
 *
 * A turn starts at a user message. A context epoch starts at zero and advances
 * after each compaction, so calls on either side of a summary are never treated
 * as sharing a cache prefix.
 */
import type { SourceMessage } from "../domain/source.js";

export interface MessageContext {
  /** Number of compaction messages earlier in the session. */
  contextEpoch: number;
  /** The most recent user message at or before this message. */
  turnId?: string;
  turnStartedAt?: string;
}

function bySourceOrder(a: SourceMessage, b: SourceMessage): number {
  if (a.timeCreated !== b.timeCreated) return a.timeCreated.localeCompare(b.timeCreated);
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id.localeCompare(b.id);
}

/**
 * Map every source message to its session-local context.
 *
 * Messages are grouped by session and sorted by the source's own order before
 * walking. The input array is not sorted in place.
 */
export function messageContexts(messages: SourceMessage[]): Map<string, MessageContext> {
  const bySession = new Map<string, SourceMessage[]>();
  for (const message of messages) {
    const current = bySession.get(message.sessionId);
    if (current === undefined) bySession.set(message.sessionId, [message]);
    else current.push(message);
  }

  const contexts = new Map<string, MessageContext>();
  for (const sessionMessages of bySession.values()) {
    sessionMessages.sort(bySourceOrder);

    let contextEpoch = 0;
    let turnId: string | undefined;
    let turnStartedAt: string | undefined;

    for (const message of sessionMessages) {
      contexts.set(message.id, {
        contextEpoch,
        ...(turnId === undefined ? {} : { turnId }),
        ...(turnStartedAt === undefined ? {} : { turnStartedAt }),
      });

      if (message.type === "user") {
        turnId = message.id;
        turnStartedAt = message.timeCreated;
      }
      if (message.type === "compaction") {
        contextEpoch += 1;
      }
    }
  }

  return contexts;
}
