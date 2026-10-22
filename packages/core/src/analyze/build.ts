/**
 * Build priced events from a Phase 2 dataset.
 *
 * This is the seam between what the source recorded and what reports read. It
 * is pure: no filesystem, network, or clock access. Every price is selected
 * from the call's own timestamp.
 */
import { WARNING_CODES } from "../diagnostics.js";
import type { CallAttempt, PricedDataset, Window } from "../domain/analysis.js";
import type {
  Dataset,
  SourceMessage,
  SourceSchema,
  SourceSession,
  SourceWarning,
} from "../domain/source.js";
import type { SchemaVersion, UsageEvent } from "../domain/usage.js";
import { billableTokens, estimateCost } from "../pricing/cost.js";
import { resolvePrice } from "../pricing/resolve.js";
import { messageContexts, type MessageContext } from "./turns.js";

function isModelCall(message: SourceMessage): boolean {
  return message.type === "assistant" || message.type === "compaction";
}

function schemaFor(dataset: Dataset, session: SourceSession | undefined): SchemaVersion {
  if (session !== undefined) return session.schema;
  if (dataset.schema === "v1" || dataset.schema === "v2") return dataset.schema;
  // A message without its session should not happen. When it does, keep the
  // event usable rather than throwing; the missing session is already visible
  // in data health.
  return "v2";
}

function latencyMs(start: string, end: string | undefined): number | undefined {
  if (end === undefined) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  const delta = endMs - startMs;
  return delta >= 0 ? delta : undefined;
}

function attemptFrom(message: SourceMessage, session: SourceSession | undefined): CallAttempt {
  const model = message.model ?? session?.model;
  const agent = message.agent ?? session?.agent;

  return {
    id: message.id,
    sessionId: message.sessionId,
    ts: message.timeCreated,
    type: message.type === "compaction" ? "compaction" : "assistant",
    ...(model === undefined ? {} : { model: { ...model } }),
    ...(agent === undefined ? {} : { agent }),
    ...(message.usage === undefined
      ? {}
      : {
          usage: {
            tokens: { ...message.usage.tokens },
            ...(message.usage.observedUsd === undefined
              ? {}
              : { observedUsd: message.usage.observedUsd }),
          },
        }),
    ...(message.usage?.observedUsd === undefined ? {} : { observedUsd: message.usage.observedUsd }),
    ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
    ...(message.errorType === undefined ? {} : { errorType: message.errorType }),
  };
}

function eventFrom(
  dataset: Dataset,
  message: SourceMessage,
  session: SourceSession | undefined,
  context: MessageContext | undefined,
): UsageEvent {
  // The caller guarantees usage; the assertion keeps the map below total.
  const usage = message.usage!;
  const billed = billableTokens(usage.tokens);

  const model = message.model ?? session?.model;
  const variant = message.model?.variant ?? session?.model?.variant;
  const agent = message.agent ?? session?.agent;
  const modelId = model?.model ?? "unknown";
  const instructions = session?.instructions;
  const endTs = message.completedAt;
  const latency = latencyMs(message.timeCreated, endTs);
  const turn = context ?? { contextEpoch: 0 };

  return {
    id: message.id,
    source: "opencode",
    schema: schemaFor(dataset, session),
    provider: model?.provider ?? "unknown",
    model: modelId,
    ...(variant === undefined ? {} : { variant }),
    ...(agent === undefined ? {} : { agent }),

    ts: message.timeCreated,
    sessionId: message.sessionId,
    ...(session?.parentId === undefined ? {} : { parentSessionId: session.parentId }),
    ...(session?.projectId === undefined ? {} : { projectId: session.projectId }),
    project: session?.project ?? session?.projectId ?? "unknown",

    ...(turn.turnId === undefined ? {} : { turnId: turn.turnId }),
    ...(turn.turnStartedAt === undefined ? {} : { turnStartedAt: turn.turnStartedAt }),
    ...(endTs === undefined ? {} : { endTs }),
    contextEpoch: turn.contextEpoch,

    inputTokens: billed.input,
    // Priced output includes reasoning, which the provider bills as output.
    outputTokens: billed.output,
    thinkingTokens: billed.thinking,
    cacheReadTokens: billed.cacheRead,
    cacheWrite5mTokens: billed.cacheWrite,
    cacheWrite1hTokens: 0,

    ...(latency === undefined ? {} : { latencyMs: latency }),
    ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
    isSubagent: session?.parentId !== undefined,

    tools: (message.toolCalls ?? []).map((tool) => ({ ...tool })),

    ...(instructions === undefined
      ? {}
      : {
          instructionKeys: [...instructions.keys],
          instructionChars: instructions.chars,
          prefixHash: instructions.prefixHash,
        }),

    cost: estimateCost({
      tokens: billed,
      model: modelId,
      ...(usage.observedUsd === undefined ? {} : { observedUsd: usage.observedUsd }),
      at: message.timeCreated,
    }),
  };
}

function compareEvents(a: UsageEvent, b: UsageEvent): number {
  if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
  if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
  return a.id.localeCompare(b.id);
}

/** Stable source ordering shared by batch and ledger report builds. */
export function sortUsageEvents(events: readonly UsageEvent[]): UsageEvent[] {
  return [...events].sort(compareEvents);
}

function compareAttempts(a: CallAttempt, b: CallAttempt): number {
  if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
  if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
  return a.id.localeCompare(b.id);
}

/** First event time to the last end (or start) time; never less than one day. */
export function windowOf(events: UsageEvent[]): Window {
  const first = events[0];
  if (first === undefined) return { start: null, end: null, days: 0 };

  let startMs = Date.parse(first.ts);
  let start = first.ts;
  let end = first.endTs ?? first.ts;
  let endMs = Date.parse(end);

  for (const event of events) {
    const startCandidateMs = Date.parse(event.ts);
    if (Number.isFinite(startCandidateMs) && startCandidateMs < startMs) {
      // Same rule as sorted input: the earliest start wins. buildEvents() output
      // is sorted, so this matches its window exactly and survives unsorted input.
      startMs = startCandidateMs;
      start = event.ts;
    }
    const candidate = event.endTs ?? event.ts;
    const candidateMs = Date.parse(candidate);
    if (Number.isFinite(candidateMs) && (!Number.isFinite(endMs) || candidateMs > endMs)) {
      end = candidate;
      endMs = candidateMs;
    }
  }

  // startMs is always the earliest finite start: initialised from the first
  // event and only ever lowered by a valid timestamp.
  const days =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
      ? Math.max(1, (endMs - startMs) / 86_400_000)
      : 1;

  return { start, end, days };
}

/**
 * One `price.unpriced-model` per model with no card, aggregated with its call
 * count and observed spend. An observed charge does not make a model priced: it
 * makes that call's headline observed, but the model still cannot be estimated.
 */
function addPricingWarnings(events: UsageEvent[], warnings: SourceWarning[]): void {
  const unpriced = new Map<string, { calls: number; observedUsd: number }>();

  for (const event of events) {
    if (resolvePrice(event.model) !== null) continue;
    const row = unpriced.get(event.model) ?? { calls: 0, observedUsd: 0 };
    row.calls += 1;
    row.observedUsd += event.cost.observedUsd ?? 0;
    unpriced.set(event.model, row);
  }

  for (const [model, row] of [...unpriced.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    warnings.push({
      code: WARNING_CODES.priceUnpricedModel,
      message: `No price card for ${model}: ${row.calls} call(s), observed spend $${row.observedUsd}`,
      count: row.calls,
    });
  }
}

/**
 * Turn a dataset into priced events, every attempt, a window, and warnings.
 * The input dataset is never mutated.
 */
export function buildEvents(dataset: Dataset): PricedDataset {
  const sessions = new Map(dataset.sessions.map((session) => [session.id, session]));
  const contexts = messageContexts(dataset.messages);

  const events: UsageEvent[] = [];
  const attempts: CallAttempt[] = [];

  for (const message of dataset.messages) {
    if (!isModelCall(message)) continue;

    const session = sessions.get(message.sessionId);
    attempts.push(attemptFrom(message, session));

    if (message.usage === undefined) continue;
    events.push(eventFrom(dataset, message, session, contexts.get(message.id)));
  }

  events.sort(compareEvents);
  attempts.sort(compareAttempts);

  const warnings: SourceWarning[] = [...dataset.warnings];
  addPricingWarnings(events, warnings);
  if (events.length === 0) {
    warnings.push({
      code: WARNING_CODES.analysisNoEvents,
      message: "No usage-bearing model calls were found",
    });
  }

  return {
    schema: dataset.schema,
    events,
    attempts,
    window: windowOf(events),
    warnings,
  };
}
