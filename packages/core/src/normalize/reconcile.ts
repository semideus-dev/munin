import { WARNING_CODES, type Dataset, type SourceWarning } from "../index.js";

type Category = "input" | "output" | "thinking" | "cacheRead" | "cacheWrite";

export interface SessionAggregateMismatch {
  sessionId: string;
  category: Category;
  expected: number;
  actual: number;
  delta: number;
  threshold: number;
}

export interface ReconcileResult {
  checkedSessions: number;
  mismatchSessions: number;
  largestDelta: number;
  mismatches: SessionAggregateMismatch[];
  warning?: SourceWarning;
}

interface MessageSums {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
}

function emptySums(): MessageSums {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 };
}

function thresholdFor(expected: number): number {
  return Math.max(1, Math.abs(expected) * 0.01);
}

export function reconcileAggregates(dataset: Dataset): ReconcileResult {
  const sumsBySession = new Map<string, MessageSums>();

  for (const message of dataset.messages) {
    if (message.type !== "assistant" && message.type !== "compaction") {
      continue;
    }
    if (message.usage === undefined) {
      continue;
    }

    const current = sumsBySession.get(message.sessionId) ?? emptySums();
    current.input += message.usage.tokens.input;
    current.output += message.usage.tokens.output;
    current.thinking += message.usage.tokens.thinking;
    current.cacheRead += message.usage.tokens.cacheRead;
    current.cacheWrite += message.usage.tokens.cacheWrite;
    sumsBySession.set(message.sessionId, current);
  }

  const mismatches: SessionAggregateMismatch[] = [];

  for (const session of dataset.sessions) {
    if (session.aggregateUsage === undefined) {
      continue;
    }

    const actual = sumsBySession.get(session.id) ?? emptySums();
    const expected = session.aggregateUsage;

    const checks: Array<{ category: Category; expected: number; actual: number }> = [
      { category: "input", expected: expected.input, actual: actual.input },
      { category: "output", expected: expected.output, actual: actual.output },
      { category: "thinking", expected: expected.thinking, actual: actual.thinking },
      { category: "cacheRead", expected: expected.cacheRead, actual: actual.cacheRead },
      { category: "cacheWrite", expected: expected.cacheWrite, actual: actual.cacheWrite },
    ];

    for (const check of checks) {
      const delta = Math.abs(check.expected - check.actual);
      const threshold = thresholdFor(check.expected);
      if (delta > threshold) {
        mismatches.push({
          sessionId: session.id,
          category: check.category,
          expected: check.expected,
          actual: check.actual,
          delta,
          threshold,
        });
      }
    }
  }

  const mismatchSessions = new Set(mismatches.map((row) => row.sessionId)).size;
  const largestDelta = mismatches.reduce((max, row) => Math.max(max, row.delta), 0);

  return {
    checkedSessions: dataset.sessions.filter((session) => session.aggregateUsage !== undefined).length,
    mismatchSessions,
    largestDelta,
    mismatches,
    ...(mismatchSessions === 0
      ? {}
      : {
          warning: {
            code: WARNING_CODES.sourceAggregateMismatch,
            message: `Session aggregates disagree with message totals (max delta ${largestDelta} tokens)`,
            count: mismatchSessions,
          },
        }),
  };
}
