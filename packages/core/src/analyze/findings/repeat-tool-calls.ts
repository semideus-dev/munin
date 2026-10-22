/**
 * The repeated-read detector: the same read-only tool call made again in one
 * context, with nothing changed in between.
 *
 * A duplicate is not one extra read: it is written into the cacheable prefix
 * and re-read by every later call in the context, so it compounds. An edit to
 * the file, or any change at all for a search, makes the next read fresh. A
 * subagent starts with an empty context, so its reads are not repeats of the
 * parent; neither is a read after a compaction.
 *
 * Unknown tools count as mutating, so duplicates are under-counted, never
 * over-counted (Phase 3 plan, Step 6).
 */
import type { DetectionContext, FindingDraft } from "../../domain/finding.js";
import type { ToolCall, UsageEvent } from "../../domain/usage.js";
import { PRICING_AS_OF } from "../../pricing/providers.js";
import { eventRates } from "../findings.js";
import { confidenceOf } from "../rules/confidence.js";

/** Tools whose results are pure context, so re-reading them is waste. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "LS",
  "Search",
  "Find",
  "PrintTree",
]);

/** Tools that change state; unknown names land here by policy. */
const MUTATING_TOOLS = new Set(["Edit", "Write", "Bash", "Execute", "Subagent"]);

/** Result feeds a mutation makes stale as a class. */
const SEARCH_TOOLS = new Set(["Grep", "Search"]);
const LISTING_TOOLS = new Set(["Glob", "WebFetch", "PrintTree", "LS"]);

/** A result under this mark is noise the context had already absorbed. */
const MIN_RESULT_TOKENS = 50;
const CHARS_PER_TOKEN = 4;

function resultTokensOf(tool: ToolCall): number {
  if (typeof tool.resultTokens === "number") return tool.resultTokens;
  return (tool.resultChars ?? 0) / CHARS_PER_TOKEN;
}

/** The file a Read signature points at, without the `#offset:limit` tail. */
function readFileOfSignature(signature: string): string | null {
  if (!signature.startsWith("Read:")) return null;
  return signature.slice(5).replace(/#[^#]*$/, "");
}

/**
 * One group of calls that share a context: a main conversation between
 * compactions, or one subagent run.
 */
interface ContextGroup {
  events: UsageEvent[];
}

/** `sessionId + (isSubagent ? turnId : "main") + contextEpoch`. */
function contexts(events: UsageEvent[]): ContextGroup[] {
  const out = new Map<string, ContextGroup>();
  for (const event of events) {
    const who = event.isSubagent === true ? `sub:${event.turnId ?? ""}` : "main";
    const key = `${event.sessionId}|${who}|${event.contextEpoch ?? 0}`;
    const group = out.get(key);
    if (group === undefined) out.set(key, { events: [event] });
    else group.events.push(event);
  }
  return [...out.values()];
}

/**
 * Apply one mutation to what the context has seen. An edit or write retires
 * reads of the file it touched only; searches, globs, fetches and tree
 * listings go stale under any mutation. An unknown tool could have changed
 * anything, so it retires every read.
 */
function retire(tool: ToolCall, seen: Map<string, number>, unknownTool: boolean): void {
  if (tool.target !== undefined) {
    for (const signature of [...seen.keys()]) {
      if (signature.startsWith("Read:") && readFileOfSignature(signature) === tool.target) {
        seen.delete(signature);
      }
    }
  } else if (unknownTool) {
    for (const signature of [...seen.keys()]) {
      if (signature.startsWith("Read:")) seen.delete(signature);
    }
  }
  for (const signature of [...seen.keys()]) {
    const kind = signature.slice(0, signature.indexOf(":"));
    if (SEARCH_TOOLS.has(kind) || LISTING_TOOLS.has(kind)) seen.delete(signature);
  }
}

export function detectRepeatToolCalls(context: DetectionContext): readonly FindingDraft[] {
  interface PerSignature {
    count: number;
    cost: number;
    tokens: number;
    sample: string;
  }
  const perSignature = new Map<string, PerSignature>();
  const touched = new Set<UsageEvent>();
  let wastedUsd = 0;
  let wastedTokens = 0;

  for (const group of contexts(context.events)) {
    const seen = new Map<string, number>();
    for (let index = 0; index < group.events.length; index += 1) {
      const event = group.events[index]!;
      const remaining = group.events.length - index - 1;
      const rates = eventRates(event);
      for (const tool of event.tools) {
        // An errored result carried no content into the context, and an
        // errored mutation must not retire anything: both are skipped.
        if (tool.isError === true) continue;

        if (MUTATING_TOOLS.has(tool.name)) {
          retire(tool, seen, false);
          continue;
        }
        if (!READ_ONLY_TOOLS.has(tool.name)) {
          retire(tool, seen, true);
          continue;
        }

        const prior = seen.get(tool.signature) ?? 0;
        seen.set(tool.signature, prior + 1);
        if (prior === 0) continue;

        const tokens = resultTokensOf(tool);
        if (tokens < MIN_RESULT_TOKENS) continue;

        // The rate card, not the source provider, decides how cache traffic
        // is billed. A duplicate is re-written (one cache write) and then
        // re-read by every remaining call in this context.
        const cost =
          rates === null
            ? 0
            : (tokens * (rates.cacheWrite5mPerM + remaining * rates.cachedInputPerM)) / 1_000_000;
        wastedUsd += cost;
        wastedTokens += tokens;
        touched.add(event);

        const row = perSignature.get(tool.signature) ?? {
          count: 0,
          cost: 0,
          tokens: 0,
          sample: tool.signature,
        };
        row.count += 1;
        row.cost += cost;
        row.tokens += tokens;
        perSignature.set(tool.signature, row);
      }
    }
  }

  if (perSignature.size === 0) return [];

  const observations = [...perSignature.values()]
    .sort((a, b) => b.cost - a.cost)
    .map(
      (row) =>
        `${row.sample.slice(0, 60)}: ${row.count} duplicate${row.count === 1 ? "" : "s"}, ${Math.round(row.tokens)} tok, $${row.cost.toFixed(6)}`,
    );

  const totalRepeats = [...perSignature.values()].reduce((sum, row) => sum + row.count, 0);
  const anyEvent = [...touched][0];
  const cardDate =
    anyEvent === undefined ? PRICING_AS_OF : (eventRates(anyEvent)?.cardFrom ?? PRICING_AS_OF);
  const confidence = confidenceOf({
    measured: true,
    sample: [...perSignature.values()].reduce((sum, row) => sum + row.count, 0),
    tokenProfileStable: true,
  });

  const draft: FindingDraft = {
    rule: "repeat-tool-calls",
    category: "context-bloat",
    title: `${totalRepeats} redundant re-read${totalRepeats === 1 ? "" : "s"} of content already in context`,
    detail:
      "The same file or search was fetched again in the same context, with nothing edited in between. Re-reads after an edit, after a compaction, or by a subagent are not counted. Each duplicate re-enters the cacheable prefix and is re-read by every later call, so the cost compounds with context length.",
    why: "A repeat is written into the conversation again and re-read by every later call, so it keeps costing until the conversation ends or is compacted.",
    tier: "fix",
    wastedUsd,
    tokensWasted: wastedTokens,
    events: [...touched],
    evidence: {
      kind: "measured",
      basis: "Duplicate results counted directly and priced at the card in force",
    },
    confidence,
    impact: "none",
    risk: "safe",
    assumptions: [
      "A duplicate read returns the same content the context already had: no edit to that file, and no change at all for a search, came in between.",
      "The duplicate stays in the prefix until the context ends or a compaction clears it.",
      "Removing it changes nothing else about the call.",
    ],
    calculation: `For each duplicate: result tokens x (cache-write rate + remaining calls in context x cache-read rate) / 1,000,000, on the ${cardDate} rate card, at the duplicate's own model and time.`,
    observations,
    fix: "Keep a per-session record of what has already been read and serve repeats from it. In agent harnesses, prefer a targeted re-read (offset/limit) over refetching a whole file.",
  };
  return [draft];
}
