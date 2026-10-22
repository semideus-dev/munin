import type { DetectionContext, FindingDraft } from "../../domain/finding.js";
import { PRICING_AS_OF } from "../../pricing/providers.js";
import { eventRates } from "../findings.js";
import { confidenceOf } from "./confidence.js";

const MILLION = 1_000_000;

function avg(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function eventTotalTokens(event: DetectionContext["events"][number]): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheWrite5mTokens +
    event.cacheWrite1hTokens
  );
}

export function detectOversizedInput(context: DetectionContext): readonly FindingDraft[] {
  const THRESHOLD = 12_000;
  const events = context.events.filter((e) => e.inputTokens >= THRESHOLD);
  if (events.length < 3) return [];
  let wastedUsd = 0;
  let wastedTokens = 0;
  for (const event of events) {
    const excess = event.inputTokens - THRESHOLD;
    if (excess <= 0) continue;
    const rates = eventRates(event);
    wastedUsd += rates === null ? 0 : (excess * rates.inputPerM) / MILLION;
    wastedTokens += excess;
  }
  if (wastedTokens === 0) return [];
  return [
    {
      rule: "oversized-input",
      category: "context-bloat",
      title: `${events.length} calls carried oversized input payloads`,
      detail: `Calls above ${THRESHOLD.toLocaleString("en-US")} input tokens likely include avoidable context carry-over.`,
      why: "Large repeated input raises cost on every call and usually slows iteration.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events,
      evidence: { kind: "measured", basis: "Input tokens counted directly per call" },
      confidence: confidenceOf({
        measured: true,
        sample: events.length,
        tokenProfileStable: false,
      }),
      impact: "medium",
      risk: "needs-verification",
      assumptions: [
        `Input above ${THRESHOLD.toLocaleString("en-US")} tokens is partly removable via tighter context selection.`,
      ],
      calculation: `Sum(max(0, input - ${THRESHOLD}) x input-rate / 1,000,000) on each call's dated card (${PRICING_AS_OF} catalogue).`,
      observations: events.slice(0, 5).map((e) => `${e.id}: in=${e.inputTokens.toLocaleString("en-US")}`),
      fix: "Trim carried context and prefer targeted reads/chunks over full-history replay.",
      candidate: { kind: "trim-prompt", description: "Reduce repeated context in request input." },
    },
  ];
}

export function detectOversizedOutput(context: DetectionContext): readonly FindingDraft[] {
  const THRESHOLD = 3_000;
  const events = context.events.filter((e) => e.outputTokens >= THRESHOLD);
  if (events.length < 3) return [];
  let wastedUsd = 0;
  let wastedTokens = 0;
  for (const event of events) {
    const excess = event.outputTokens - THRESHOLD;
    if (excess <= 0) continue;
    const rates = eventRates(event);
    wastedUsd += rates === null ? 0 : (excess * rates.outputPerM) / MILLION;
    wastedTokens += excess;
  }
  if (wastedTokens === 0) return [];
  return [
    {
      rule: "oversized-output",
      category: "context-bloat",
      title: `${events.length} calls produced oversized outputs`,
      detail: `Outputs above ${THRESHOLD.toLocaleString("en-US")} tokens are expensive and often exceed what later turns need.`,
      why: "Over-long responses cost more and are frequently re-summarized later.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events,
      evidence: { kind: "measured", basis: "Output tokens counted directly per call" },
      confidence: confidenceOf({
        measured: true,
        sample: events.length,
        tokenProfileStable: false,
      }),
      impact: "medium",
      risk: "needs-verification",
      assumptions: ["A shorter response format would preserve quality for most of these calls."],
      calculation: `Sum(max(0, output - ${THRESHOLD}) x output-rate / 1,000,000) on each call's dated card (${PRICING_AS_OF} catalogue).`,
      observations: events.slice(0, 5).map((e) => `${e.id}: out=${e.outputTokens.toLocaleString("en-US")}`),
      fix: "Constrain response length/format and ask for concise outputs by default.",
      candidate: { kind: "trim-prompt", description: "Constrain response format to reduce excess output." },
    },
  ];
}

export function detectOversizedToolOutput(context: DetectionContext): readonly FindingDraft[] {
  const THRESHOLD = 4_000;
  const touched: typeof context.events = [];
  let wastedTokens = 0;
  let wastedUsd = 0;
  for (const event of context.events) {
    let localWaste = 0;
    for (const tool of event.tools) {
      const chars = tool.resultChars ?? 0;
      const tokens = Math.round(chars / 4);
      if (tokens <= THRESHOLD) continue;
      localWaste += tokens - THRESHOLD;
    }
    if (localWaste <= 0) continue;
    touched.push(event);
    wastedTokens += localWaste;
    const rates = eventRates(event);
    wastedUsd += rates === null ? 0 : (localWaste * rates.inputPerM) / MILLION;
  }
  if (touched.length < 2) return [];
  return [
    {
      rule: "oversized-tool-output",
      category: "context-bloat",
      title: `${touched.length} calls ingested oversized tool output`,
      detail: "Large tool payloads were inserted into context in full where summaries or slices would likely suffice.",
      why: "Oversized tool output inflates next-call input and repeated-context costs.",
      tier: "fix",
      wastedUsd,
      tokensWasted: wastedTokens,
      events: touched,
      evidence: { kind: "measured", basis: "Tool result sizes counted from captured result characters" },
      confidence: confidenceOf({
        measured: true,
        sample: touched.length,
        tokenProfileStable: true,
      }),
      impact: "none",
      risk: "safe",
      assumptions: ["Only the excess above a large payload threshold is treated as removable waste."],
      calculation: `Sum(max(0, tool-result-tokens - ${THRESHOLD}) x input-rate / 1,000,000) on each call's dated card (${PRICING_AS_OF} catalogue).`,
      observations: touched.slice(0, 5).map((e) => `${e.id}: oversized tool output observed`),
      fix: "Replace full tool dumps with targeted ranges, summaries, or filtered output.",
    },
  ];
}

export function detectSpendConcentration(context: DetectionContext): readonly FindingDraft[] {
  if (context.events.length < 20 || context.totalUsd <= 0) return [];
  const bySession = new Map<string, { usd: number; events: typeof context.events }>();
  for (const event of context.events) {
    const row = bySession.get(event.sessionId) ?? { usd: 0, events: [] };
    row.usd += event.cost.total;
    row.events.push(event);
    bySession.set(event.sessionId, row);
  }
  const top = [...bySession.entries()].sort((a, b) => b[1].usd - a[1].usd)[0];
  if (top === undefined) return [];
  const [sessionId, row] = top;
  const share = row.usd / context.totalUsd;
  if (share < 0.65) return [];
  const wastedUsd = row.usd * (share - 0.5);
  return [
    {
      rule: "spend-concentration",
      category: "concentration",
      title: `One session holds ${(share * 100).toFixed(1)}% of spend`,
      detail: `Session ${sessionId} dominates window spend, which raises optimization leverage and risk concentration.`,
      why: "When spend concentrates in one lane, a small fix there has outsized impact.",
      tier: "test",
      wastedUsd,
      tokensWasted: row.events.reduce((s, e) => s + eventTotalTokens(e), 0),
      events: row.events,
      evidence: { kind: "measured", basis: "Spend share computed from per-call headline costs" },
      confidence: confidenceOf({ measured: true, sample: row.events.length, tokenProfileStable: true }),
      impact: "low",
      risk: "needs-verification",
      advisory: true,
      assumptions: ["Concentration indicates optimization leverage, not guaranteed removability."],
      calculation: `Top-session spend share = session-headline / window-headline; advisory sized as (share - 50%) of top session spend.`,
      observations: [`${sessionId}: ${row.events.length} calls, share ${(share * 100).toFixed(1)}%`],
      fix: "Inspect the dominant session first (model choice, context size, retries, and tool-output volume).",
    },
  ];
}

export function detectReasoningEffort(context: DetectionContext): readonly FindingDraft[] {
  const events = context.events.filter((e) => e.thinkingTokens > 0 && e.outputTokens > 0);
  if (events.length < 10) return [];
  const shares = events.map((e) => e.thinkingTokens / Math.max(1, e.outputTokens));
  const share = avg(shares);
  if (share < 0.55) return [];
  let wastedTokens = 0;
  let wastedUsd = 0;
  for (const event of events) {
    const targetThinking = Math.round(event.outputTokens * 0.35);
    const excess = Math.max(0, event.thinkingTokens - targetThinking);
    wastedTokens += excess;
    const rates = eventRates(event);
    wastedUsd += rates === null ? 0 : (excess * rates.outputPerM) / MILLION;
  }
  if (wastedTokens === 0) return [];
  return [
    {
      rule: "reasoning-effort",
      category: "reasoning",
      title: `Reasoning tokens are ${(share * 100).toFixed(1)}% of priced output on sampled calls`,
      detail: "High reasoning-token share suggests calls may be running at a heavier effort profile than required.",
      why: "Reasoning tokens are billed as output and can dominate cost for routine tasks.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events,
      evidence: { kind: "inferred", basis: "Reasoning share inferred from provider token categories" },
      confidence: confidenceOf({ measured: true, sample: events.length, tokenProfileStable: false }),
      impact: "medium",
      risk: "needs-verification",
      assumptions: ["A lower reasoning effort profile would preserve quality for part of this traffic."],
      calculation: "Per call: max(0, thinking - 35% of output) x output-rate / 1,000,000, then summed.",
      observations: events.slice(0, 5).map((e) => `${e.id}: thinking=${e.thinkingTokens}, out=${e.outputTokens}`),
      fix: "Try a lower reasoning effort/default for routine operations and verify output quality.",
      candidate: { kind: "lower-effort", description: "Lower reasoning effort for routine traffic." },
    },
  ];
}

export function detectCostSpike(context: DetectionContext): readonly FindingDraft[] {
  if (context.events.length < 20) return [];
  const daily = new Map<string, { usd: number; events: typeof context.events }>();
  for (const event of context.events) {
    const day = event.ts.slice(0, 10);
    const row = daily.get(day) ?? { usd: 0, events: [] };
    row.usd += event.cost.total;
    row.events.push(event);
    daily.set(day, row);
  }
  if (daily.size < 2) return [];
  const rows = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const costs = rows.map(([, row]) => row.usd);
  const baseline = avg(costs);
  const top = rows.sort((a, b) => b[1].usd - a[1].usd)[0];
  if (top === undefined) return [];
  const [day, row] = top;
  if (row.usd < baseline * 1.8 || row.usd - baseline < 0.25) return [];
  return [
    {
      rule: "cost-spike",
      category: "anomaly",
      title: `Spend spike on ${day} (${row.usd.toFixed(6)} USD vs ${baseline.toFixed(6)} baseline)`,
      detail: "One day stands well above the window baseline and merits root-cause review.",
      why: "Spikes often indicate retries, oversized context, or model-choice drift.",
      tier: "test",
      wastedUsd: Math.max(0, row.usd - baseline),
      tokensWasted: row.events.reduce((s, e) => s + eventTotalTokens(e), 0),
      events: row.events,
      evidence: { kind: "measured", basis: "Daily spend grouped from per-call headline costs" },
      confidence: confidenceOf({ measured: true, sample: row.events.length, tokenProfileStable: true }),
      impact: "low",
      risk: "needs-verification",
      advisory: true,
      assumptions: ["Baseline uses simple daily average over the observed window."],
      calculation: "wasted = max(0, top-day spend - average daily spend).",
      observations: [`${day}: ${row.events.length} calls, $${row.usd.toFixed(6)}`],
      fix: "Inspect that day by model, session, retries, and context size to isolate cause.",
    },
  ];
}

export function detectHeavyStart(context: DetectionContext): readonly FindingDraft[] {
  const bySession = new Map<string, typeof context.events>();
  for (const event of context.events) {
    const row = bySession.get(event.sessionId) ?? [];
    row.push(event);
    bySession.set(event.sessionId, row);
  }
  const touched: typeof context.events = [];
  let wastedUsd = 0;
  let wastedTokens = 0;
  for (const row of bySession.values()) {
    const sorted = [...row].sort((a, b) => a.ts.localeCompare(b.ts));
    if (sorted.length < 3) continue;
    const first = sorted[0]!;
    const next = sorted.slice(1, 3);
    const nextAvg = avg(next.map((e) => e.inputTokens));
    if (first.inputTokens < nextAvg * 1.8 || first.inputTokens < 8_000) continue;
    const excess = Math.max(0, first.inputTokens - nextAvg);
    const rates = eventRates(first);
    wastedUsd += rates === null ? 0 : (excess * rates.inputPerM) / MILLION;
    wastedTokens += excess;
    touched.push(first);
  }
  if (touched.length === 0) return [];
  return [
    {
      rule: "heavy-start",
      category: "context-bloat",
      title: `${touched.length} sessions start with unusually heavy first calls`,
      detail: "Initial calls are much larger than immediate follow-ups, indicating cold-start context overloading.",
      why: "Heavy starts pay full input rates before cache/read patterns stabilize.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events: touched,
      evidence: { kind: "inferred", basis: "First-call input compared to early-session baseline" },
      confidence: confidenceOf({ measured: true, sample: touched.length, tokenProfileStable: false }),
      impact: "low",
      risk: "needs-verification",
      assumptions: ["Early follow-up calls approximate the session's steady-state input size."],
      calculation: "Per session: max(0, first-call input - avg(input of calls 2-3)) x input-rate / 1,000,000.",
      observations: touched.slice(0, 5).map((e) => `${e.sessionId}: first input=${e.inputTokens}`),
      fix: "Move rarely-needed setup context out of the first call or split warm-up from active work.",
      candidate: { kind: "trim-prompt", description: "Lighten session cold-start context." },
    },
  ];
}

export function detectColdResume(context: DetectionContext): readonly FindingDraft[] {
  const DAY_MS = 86_400_000;
  const touched: typeof context.events = [];
  let wastedTokens = 0;
  let wastedUsd = 0;
  const bySession = new Map<string, typeof context.events>();
  for (const event of context.events) {
    const row = bySession.get(event.sessionId) ?? [];
    row.push(event);
    bySession.set(event.sessionId, row);
  }
  for (const row of bySession.values()) {
    const sorted = [...row].sort((a, b) => a.ts.localeCompare(b.ts));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const gap = Date.parse(cur.ts) - Date.parse(prev.ts);
      if (!Number.isFinite(gap) || gap < 2 * 60 * 60 * 1000 || gap > DAY_MS * 14) continue;
      if (cur.inputTokens < 6_000) continue;
      const assumedResend = Math.round(cur.inputTokens * 0.35);
      touched.push(cur);
      wastedTokens += assumedResend;
      const rates = eventRates(cur);
      wastedUsd += rates === null ? 0 : (assumedResend * rates.inputPerM) / MILLION;
    }
  }
  if (touched.length < 2) return [];
  return [
    {
      rule: "cold-resume",
      category: "context-bloat",
      title: `${touched.length} resumed calls look like cold restarts`,
      detail: "After long pauses, resumed calls carry large input payloads, suggesting context had to be rebuilt.",
      why: "Cold resumes re-pay context setup at full input rates.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events: touched,
      evidence: { kind: "inferred", basis: "Large post-gap inputs used as cold-resume proxy" },
      confidence: confidenceOf({ measured: true, sample: touched.length, tokenProfileStable: false }),
      impact: "low",
      risk: "needs-verification",
      assumptions: [
        "For long gaps, 35% of resumed input is treated as rebuild overhead unless proven otherwise.",
      ],
      calculation: "For each qualifying post-gap call: 35% x input tokens x input-rate / 1,000,000.",
      observations: touched.slice(0, 5).map((e) => `${e.id}: resumed input=${e.inputTokens}`),
      fix: "Use compact handoff notes/checkpoints so resumed sessions avoid full context rebuild.",
      candidate: { kind: "trim-prompt", description: "Use resume checkpoints to reduce rebuild context." },
    },
  ];
}

export function detectCacheChurn(context: DetectionContext): readonly FindingDraft[] {
  const events = context.events.filter((e) => e.inputTokens + e.cacheReadTokens >= 2_000);
  if (events.length < 10) return [];
  const totalInputSide = events.reduce(
    (s, e) => s + e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens,
    0,
  );
  if (totalInputSide <= 0) return [];
  const hit = events.reduce((s, e) => s + e.cacheReadTokens, 0) / totalInputSide;
  if (hit >= 0.35) return [];
  let wastedUsd = 0;
  let wastedTokens = 0;
  for (const event of events) {
    const recoverable = Math.round(event.inputTokens * 0.25);
    wastedTokens += recoverable;
    const rates = eventRates(event);
    if (rates === null) continue;
    wastedUsd += (recoverable * Math.max(0, rates.inputPerM - rates.cachedInputPerM)) / MILLION;
  }
  return [
    {
      rule: "cache-churn",
      category: "caching",
      title: `Low cache hit rate (${(hit * 100).toFixed(1)}%) on substantial input traffic`,
      detail: "Input-side reuse is low for this window, so repeated prefixes are likely being re-billed at input rates.",
      why: "When cache misses dominate, repeated context keeps paying full input cost.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events,
      evidence: { kind: "inferred", basis: "Cache hit rate and input traffic measured per call" },
      confidence: confidenceOf({ measured: true, sample: events.length, tokenProfileStable: false }),
      impact: "low",
      risk: "needs-verification",
      assumptions: ["A quarter of uncached input is treated as potentially recoverable via better cache reuse."],
      calculation: "Per call: 25% of input tokens x (input-rate - cached-input-rate) / 1,000,000.",
      observations: [`cache hit ${(hit * 100).toFixed(1)}% across ${events.length} calls`],
      fix: "Increase reusable cached prefixes and reduce context churn between adjacent calls.",
      candidate: { kind: "enable-cache", description: "Increase reuse of cacheable prefixes." },
    },
  ];
}

export function detectPromptBloat(context: DetectionContext): readonly FindingDraft[] {
  const events = context.events.filter(
    (e) => (e.instructionChars ?? 0) > 0 && e.inputTokens >= 2000,
  );
  if (events.length < 6) return [];
  const bloated = events.filter((e) => (e.instructionChars ?? 0) / Math.max(1, e.inputTokens) > 3.2);
  if (bloated.length < 4) return [];
  let wastedUsd = 0;
  let wastedTokens = 0;
  for (const event of bloated) {
    const estInstructionTokens = Math.round((event.instructionChars ?? 0) / 4);
    const excess = Math.max(0, estInstructionTokens - Math.round(event.inputTokens * 0.4));
    wastedTokens += excess;
    const rates = eventRates(event);
    wastedUsd += rates === null ? 0 : (excess * rates.inputPerM) / MILLION;
  }
  if (wastedTokens === 0) return [];
  return [
    {
      rule: "prompt-bloat",
      category: "context-bloat",
      title: `${bloated.length} calls show heavy instruction overhead`,
      detail: "Instruction payload appears to dominate request input on repeated calls.",
      why: "Prompt bloat pays input cost repeatedly and can crowd out task-specific context.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events: bloated,
      evidence: { kind: "inferred", basis: "Instruction chars mapped to token proxy and compared against input" },
      confidence: confidenceOf({ measured: true, sample: bloated.length, tokenProfileStable: false }),
      impact: "medium",
      risk: "needs-verification",
      assumptions: ["Instruction characters are approximated at 4 chars/token for sizing only."],
      calculation: "excess ~= max(0, instructionTokens - 40% of input) priced at input rates.",
      observations: bloated.slice(0, 5).map((e) => `${e.id}: instructionChars=${e.instructionChars ?? 0}`),
      fix: "Consolidate system instructions and keep only always-needed policy/context.",
      candidate: { kind: "trim-prompt", description: "Reduce repeated instruction payload." },
    },
  ];
}

export function detectErrorLoops(context: DetectionContext): readonly FindingDraft[] {
  const errored = context.events.filter((e) => (e.stopReason ?? "") === "error");
  if (errored.length < 3) return [];
  const byKey = new Map<string, typeof context.events>();
  for (const event of errored) {
    const key = `${event.sessionId}\u0000${event.model}\u0000${event.inputTokens}`;
    const row = byKey.get(key) ?? [];
    row.push(event);
    byKey.set(key, row);
  }
  const loops = [...byKey.values()].filter((row) => row.length >= 2).flat();
  if (loops.length < 2) return [];
  const wastedUsd = loops.reduce((s, e) => s + e.cost.total, 0);
  const wastedTokens = loops.reduce((s, e) => s + eventTotalTokens(e), 0);
  return [
    {
      rule: "error-loops",
      category: "retries",
      title: `${loops.length} errored calls look like retry loops`,
      detail: "Similar failing calls were retried in the same session/model lane.",
      why: "Repeated failures burn tokens and cost without progressing work.",
      tier: "fix",
      wastedUsd,
      tokensWasted: wastedTokens,
      events: loops,
      evidence: { kind: "measured", basis: "Errored stop reasons and repeated call shapes counted directly" },
      confidence: confidenceOf({ measured: true, sample: loops.length, tokenProfileStable: true }),
      impact: "none",
      risk: "safe",
      assumptions: ["A repeated failing shape in one session is treated as avoidable retry overhead."],
      calculation: "Sum headline cost and tokens for repeated errored call shapes.",
      observations: loops.slice(0, 5).map((e) => `${e.id}: ${e.model} input=${e.inputTokens}`),
      fix: "Add retry guards/backoff and stop after first repeated error shape.",
    },
  ];
}

export function detectContextCompaction(context: DetectionContext): readonly FindingDraft[] {
  const events = context.events.filter((e) => (e.contextEpoch ?? 0) >= 2);
  if (events.length < 5) return [];
  let wastedTokens = 0;
  let wastedUsd = 0;
  for (const event of events) {
    const assumed = Math.round(event.inputTokens * 0.15);
    wastedTokens += assumed;
    const rates = eventRates(event);
    wastedUsd += rates === null ? 0 : (assumed * rates.inputPerM) / MILLION;
  }
  return [
    {
      rule: "context-compaction",
      category: "context-bloat",
      title: `${events.length} calls happened after repeated compaction epochs`,
      detail: "Frequent compaction cycles indicate context pressure and repeated rebuild overhead.",
      why: "Repeated compaction often means the conversation is carrying too much stale context.",
      tier: "try",
      wastedUsd,
      tokensWasted: wastedTokens,
      events,
      evidence: { kind: "inferred", basis: "Compaction epochs inferred from message sequencing" },
      confidence: confidenceOf({ measured: true, sample: events.length, tokenProfileStable: false }),
      impact: "medium",
      risk: "needs-verification",
      assumptions: ["15% of post-compaction input is treated as avoidable rebuild overhead."],
      calculation: "For events with epoch >= 2: 15% of input tokens priced at input-rate.",
      observations: events.slice(0, 5).map((e) => `${e.id}: contextEpoch=${e.contextEpoch ?? 0}`),
      fix: "Use tighter context windows and periodic checkpoint summaries before pressure builds.",
      candidate: { kind: "trim-prompt", description: "Reduce context pressure that leads to repeated compactions." },
    },
  ];
}

export function detectPricingChange(context: DetectionContext): readonly FindingDraft[] {
  const priced = context.events.filter((e) => e.cost.observedUsd !== null && e.inputTokens > 0);
  if (priced.length < 10) return [];
  const byModel = new Map<string, typeof priced>();
  for (const event of priced) {
    const key = `${event.provider}/${event.model}`;
    const row = byModel.get(key) ?? [];
    row.push(event);
    byModel.set(key, row);
  }
  let worst: { key: string; delta: number; events: typeof priced } | undefined;
  for (const [key, events] of byModel) {
    if (events.length < 6) continue;
    const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
    const cut = Math.floor(sorted.length / 2);
    const early = sorted.slice(0, cut);
    const late = sorted.slice(cut);
    if (early.length < 3 || late.length < 3) continue;
    const earlyRate = avg(
      early.map((e) => (e.cost.observedUsd ?? 0) / Math.max(1, eventTotalTokens(e))),
    );
    const lateRate = avg(
      late.map((e) => (e.cost.observedUsd ?? 0) / Math.max(1, eventTotalTokens(e))),
    );
    const delta = lateRate - earlyRate;
    if (delta <= 0) continue;
    if (worst === undefined || delta > worst.delta) worst = { key, delta, events: late };
  }
  if (worst === undefined || worst.delta < 1e-8) return [];
  const tokens = worst.events.reduce((s, e) => s + eventTotalTokens(e), 0);
  const wastedUsd = worst.delta * tokens;
  return [
    {
      rule: "pricing-change",
      category: "pricing",
      title: `Observed effective rate increased for ${worst.key}`,
      detail: "Observed cost per token rose between earlier and later traffic windows for this model lane.",
      why: "Rate increases change optimization priority and may justify model/default adjustments.",
      tier: "test",
      wastedUsd,
      tokensWasted: tokens,
      events: worst.events,
      evidence: { kind: "measured", basis: "Observed effective $/token compared across time slices" },
      confidence: confidenceOf({ measured: true, sample: worst.events.length, tokenProfileStable: true }),
      impact: "low",
      risk: "needs-verification",
      advisory: true,
      assumptions: ["Effective-rate comparison uses simple early-vs-late split for the same model lane."],
      calculation: "(late observed $/token - early observed $/token) x later-window tokens.",
      observations: [`${worst.key}: delta=${worst.delta.toExponential(3)} USD/token`],
      fix: "Re-check model pricing/current defaults and rerank optimization actions under the new rate.",
    },
  ];
}

export function detectModelDefault(context: DetectionContext): readonly FindingDraft[] {
  if (context.events.length < 20) return [];
  const byModel = new Map<string, { calls: number; usd: number; events: typeof context.events }>();
  for (const event of context.events) {
    const key = `${event.provider}/${event.model}`;
    const row = byModel.get(key) ?? { calls: 0, usd: 0, events: [] };
    row.calls += 1;
    row.usd += event.cost.total;
    row.events.push(event);
    byModel.set(key, row);
  }
  const total = context.events.length;
  const top = [...byModel.entries()].sort((a, b) => b[1].calls - a[1].calls)[0];
  if (top === undefined) return [];
  const [model, row] = top;
  const share = row.calls / total;
  if (share < 0.9) return [];
  return [
    {
      rule: "model-default",
      category: "model-selection",
      title: `${model} handles ${(share * 100).toFixed(1)}% of calls`,
      detail: "One default model dominates usage, reducing specialization opportunities.",
      why: "Single-model defaults can overpay for easy traffic and underfit complex traffic.",
      tier: "test",
      wastedUsd: row.usd * 0.05,
      tokensWasted: row.events.reduce((s, e) => s + eventTotalTokens(e), 0),
      events: row.events,
      evidence: { kind: "measured", basis: "Call distribution measured by model" },
      confidence: confidenceOf({ measured: true, sample: row.calls, tokenProfileStable: true }),
      impact: "low",
      risk: "needs-verification",
      advisory: true,
      assumptions: ["A mixed default policy could improve fit for part of this traffic."],
      calculation: "Advisory sizing at 5% of dominant-model spend.",
      observations: [`${model}: ${row.calls}/${total} calls`],
      fix: "Review default model routing so easy and hard tasks are separated.",
    },
  ];
}

export function detectModelFit(context: DetectionContext): readonly FindingDraft[] {
  if (context.events.length < 25) return [];
  const byModel = new Map<string, { usd: number; calls: number; out: number; events: typeof context.events }>();
  for (const event of context.events) {
    const key = `${event.provider}/${event.model}`;
    const row = byModel.get(key) ?? { usd: 0, calls: 0, out: 0, events: [] };
    row.usd += event.cost.total;
    row.calls += 1;
    row.out += event.outputTokens;
    row.events.push(event);
    byModel.set(key, row);
  }
  if (byModel.size < 2) return [];
  const ranked = [...byModel.entries()].sort((a, b) => b[1].usd - a[1].usd);
  const [expensiveModel, expensive] = ranked[0]!;
  const [candidateModel, candidate] = ranked[ranked.length - 1]!;
  const expensiveAvgUsd = expensive.usd / Math.max(1, expensive.calls);
  const candidateAvgUsd = candidate.usd / Math.max(1, candidate.calls);
  const expensiveAvgOut = expensive.out / Math.max(1, expensive.calls);
  if (expensiveAvgUsd < candidateAvgUsd * 1.8 || expensiveAvgOut > 1200) return [];
  const movedCalls = Math.floor(expensive.calls * 0.2);
  const wastedUsd = Math.max(0, (expensiveAvgUsd - candidateAvgUsd) * movedCalls);
  if (wastedUsd <= 0) return [];
  return [
    {
      rule: "model-fit",
      category: "model-selection",
      title: `${expensiveModel} appears over-provisioned for part of traffic`,
      detail: `High average cost per call on ${expensiveModel} with low average output suggests some calls could run on a cheaper lane.`,
      why: "Misfit model selection raises cost without proportional output gains.",
      tier: "try",
      wastedUsd,
      tokensWasted: Math.round(expensiveAvgOut * movedCalls),
      events: expensive.events,
      evidence: { kind: "inferred", basis: "Per-model cost/call and output/call compared within the same window" },
      confidence: confidenceOf({ measured: true, sample: expensive.calls, tokenProfileStable: false }),
      impact: "medium",
      risk: "needs-verification",
      assumptions: ["Roughly 20% of expensive-lane calls are simple enough for a cheaper lane."],
      calculation: "(avg cost/call expensive lane - avg cost/call cheaper lane) x 20% of expensive-lane calls.",
      observations: [
        `${expensiveModel}: avg $${expensiveAvgUsd.toFixed(6)}/call, avg out ${Math.round(expensiveAvgOut)} tok`,
        `${candidateModel}: avg $${candidateAvgUsd.toFixed(6)}/call`,
      ],
      fix: "Route routine traffic to a cheaper model lane and keep the expensive lane for complex calls.",
      candidate: {
        kind: "swap-model",
        from: expensiveModel,
        to: candidateModel,
        description: "Move simple traffic to a cheaper model lane.",
      },
    },
  ];
}
