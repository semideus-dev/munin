/**
 * The repeated-context detector: instruction prefixes that several sessions on
 * one agent, model and variant re-send uncached, call after call.
 *
 * The cache identity is `prefixHash + agent + model + variant`, never the
 * prefix hash alone: two agents on one model share nothing at request time. A
 * finding needs at least 3 sessions, 10 calls, and 20,000 uncached input
 * tokens, so single-conversation noise cannot trigger it. The saving is what a
 * longer cache TTL would have served from cache instead: this is an inference,
 * not a measurement, and the one-time longer-TTL write cost is not deducted.
 */
import type { DetectionContext, FindingDraft, FindingCandidate } from "../../domain/finding.js";
import type { UsageEvent } from "../../domain/usage.js";
import { PRICING_AS_OF } from "../../pricing/providers.js";
import { eventRates } from "../findings.js";

export const REPEATED_CONTEXT_THRESHOLDS = {
  /** Sessions sharing one identity before it counts. */
  sessions: 3,
  /** Calls re-sending the prefix before it counts. */
  calls: 10,
  /** Uncached input tokens on the prefix before it counts. */
  uncachedInputTokens: 20_000,
} as const;

interface IdentityGroup {
  prefixHash: string;
  agent: string;
  model: string;
  variant: string | undefined;
  events: UsageEvent[];
  sessions: Set<string>;
}

/**
 * Group by the full cache identity. Events without instruction metadata
 * (no `prefixHash`) cannot repeat a prefix, so they are not grouped.
 */
function identityGroups(events: UsageEvent[]): IdentityGroup[] {
  const groups = new Map<string, IdentityGroup>();
  for (const event of events) {
    if (event.prefixHash === undefined) continue;
    const agent = event.agent ?? "unknown";
    const model = `${event.provider}/${event.model}`;
    const variant = event.variant ?? undefined;
    const key = `${event.prefixHash}\u0000${agent}\u0000${model}\u0000${variant ?? "-"}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        prefixHash: event.prefixHash,
        agent,
        model,
        variant,
        events: [event],
        sessions: new Set([event.sessionId]),
      });
    } else {
      group.events.push(event);
      group.sessions.add(event.sessionId);
    }
  }
  return [...groups.values()];
}

export function detectRepeatedContext(context: DetectionContext): readonly FindingDraft[] {
  const drafts: FindingDraft[] = [];

  for (const group of identityGroups(context.events)) {
    if (group.sessions.size < REPEATED_CONTEXT_THRESHOLDS.sessions) continue;
    if (group.events.length < REPEATED_CONTEXT_THRESHOLDS.calls) continue;

    const uncachedInputTokens = group.events.reduce((sum, event) => sum + event.inputTokens, 0);
    if (uncachedInputTokens < REPEATED_CONTEXT_THRESHOLDS.uncachedInputTokens) continue;

    // One rate for the group: the identity pins the model, and the rate is
    // taken at the group's own last call so a dated card never rewrites rates.
    const lastEvent = group.events[group.events.length - 1]!;
    const rates = eventRates(lastEvent);
    // The gross saving before the (un-deducted) one-time longer-TTL write cost.
    const saving =
      rates === null
        ? 0
        : (uncachedInputTokens * (rates.inputPerM - rates.cachedInputPerM)) / 1_000_000;

    const evidence =
      rates === null
        ? {
            kind: "inferred" as const,
            basis: `Uncached re-sends counted directly; no rate card for ${group.model}`,
          }
        : {
            kind: "inferred" as const,
            basis: `Uncached re-sends counted directly and priced at the ${rates.cardFrom} rate card for ${group.model}`,
          };

    const candidate: FindingCandidate = {
      kind: "enable-cache",
      description: `Give the shared ${group.agent} prefix on ${group.model} a longer cache TTL so re-sent instructions are served from cache.`,
    };

    drafts.push({
      rule: "repeated-context",
      category: "caching",
      title: `${group.sessions.size} sessions re-send the same ${group.agent} prefix on ${group.model}`,
      why: "Every session starts by paying full price for identical instructions, then pays the cached rate for the rest of the run; a prefix that always re-arrives is paying input price for nothing.",
      detail: `${group.sessions.size} sessions re-sent the same instruction prefix across ${group.events.length} calls, ${uncachedInputTokens.toLocaleString("en-US")} uncached input tokens in total. The prefix is identical by hash, agent, model and variant, so none of it is unique work: it re-arrives because each session starts cold.`,
      tier: "try",
      wastedUsd: saving,
      tokensWasted: uncachedInputTokens,
      events: group.events,
      evidence,
      confidence: {
        level: "medium",
        basis: "medium because the fix changes what the model receives, not what it outputs",
      },
      impact: "medium",
      risk: "needs-verification",
      assumptions: [
        "A longer cache TTL would capture this prefix, so the uncached input would be served at the cached rate instead.",
        `The one-time longer-TTL write cost is not deducted; this is the gross saving on the ${rates?.cardFrom ?? PRICING_AS_OF} rate card.`,
      ],
      calculation: `${uncachedInputTokens.toLocaleString("en-US")} uncached input tokens x (input rate - cached-input rate) / 1,000,000, on the ${rates?.cardFrom ?? PRICING_AS_OF} rate card.`,
      observations: [
        `${group.agent} on ${group.model}${group.variant === undefined ? "" : ` (${group.variant})`}: ${group.sessions.size} sessions, ${group.events.length} calls, ${uncachedInputTokens.toLocaleString("en-US")} uncached input tok`,
      ],
      fix: "Move the shared instructions to a cached, longer-TTL prefix (prompt caching with an extended TTL, or a warm-up request per session) so repeats are served from cache instead of re-billed at input price.",
      candidate,
    });
  }

  // Most expensive first: sessions sort by their modelled saving, then identity.
  return drafts.sort((a, b) => {
    if (a.wastedUsd !== b.wastedUsd) return b.wastedUsd - a.wastedUsd;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return 0;
  });
}
