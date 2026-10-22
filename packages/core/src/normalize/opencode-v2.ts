import { WARNING_CODES } from "../diagnostics.js";
import type {
  Dataset,
  ModelRef,
  SourceMessage,
  SourceMessageType,
  SourceSession,
  SourceWarning,
  TokenCounts,
} from "../domain/index.js";
import { projectLabel } from "./text.js";
import { toIso } from "./time.js";
import { normalizeToolCalls } from "./tools.js";
import type {
  RawInstructionEntryRow,
  RawMessageTextLengthRow,
  RawSessionMessageRow,
  RawSessionV2Row,
  RawToolProjectionRow,
} from "./rows.js";

export interface V2InstructionSummary {
  sessionId: string;
  keys: string[];
  chars: number;
  prefixHash: string;
}

export interface NormalizeV2Input {
  sessions: RawSessionV2Row[];
  messages: RawSessionMessageRow[];
  tools: RawToolProjectionRow[];
  textLengths: RawMessageTextLengthRow[];
  instructionEntries?: RawInstructionEntryRow[];
  instructionBySession?: V2InstructionSummary[];
  invalidJsonRows?: number;
  sourcePath: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(json: string | null): Record<string, unknown> | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    return asObject(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapModel(value: unknown): ModelRef | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  const model = asString(object.id);
  const provider = asString(object.providerID);
  if (model === undefined || provider === undefined) {
    return undefined;
  }
  const variant = asString(object.variant);
  return variant === undefined ? { provider, model } : { provider, model, variant };
}

function mapType(type: string): SourceMessageType {
  if (
    type === "assistant" ||
    type === "user" ||
    type === "compaction" ||
    type === "idle" ||
    type === "model-switched" ||
    type === "agent-switched" ||
    type === "system" ||
    type === "synthetic"
  ) {
    return type;
  }
  return "unknown";
}

function tokenCounts(data: Record<string, unknown> | undefined): TokenCounts | undefined {
  const tokens = asObject(data?.tokens);
  if (tokens === undefined) {
    return undefined;
  }

  const cache = asObject(tokens.cache);
  const input = asFiniteNumber(tokens.input) ?? 0;
  const output = asFiniteNumber(tokens.output) ?? 0;
  const thinking = asFiniteNumber(tokens.reasoning) ?? 0;
  const cacheRead = asFiniteNumber(cache?.read) ?? 0;
  const cacheWrite = asFiniteNumber(cache?.write) ?? 0;

  return {
    input,
    output,
    thinking,
    cacheRead,
    cacheWrite,
  };
}

function observedCost(data: Record<string, unknown> | undefined): number | undefined {
  const value = asFiniteNumber(data?.cost);
  return value === undefined ? undefined : value;
}

function messageWarnings(input: NormalizeV2Input): SourceWarning[] {
  const warnings: SourceWarning[] = [];

  if ((input.invalidJsonRows ?? 0) > 0) {
    warnings.push({
      code: WARNING_CODES.sourceInvalidJson,
      message: "One or more message rows contain invalid JSON",
      count: input.invalidJsonRows,
    });
  }

  if (input.instructionEntries !== undefined) {
    const missing = input.instructionEntries.filter((entry) => entry.char_count === null).length;
    if (missing > 0) {
      warnings.push({
        code: WARNING_CODES.sourceInstructionMissing,
        message: "One or more instruction blobs referenced by hash are missing",
        count: missing,
      });
    }
  }

  return warnings;
}

export function normalizeOpenCodeV2(input: NormalizeV2Input): Dataset {
  const textByMessage = new Map(input.textLengths.map((row) => [row.message_id, row.text_chars]));

  const toolsByMessage = new Map<string, RawToolProjectionRow[]>();
  for (const row of input.tools) {
    const current = toolsByMessage.get(row.message_id);
    if (current === undefined) {
      toolsByMessage.set(row.message_id, [row]);
    } else {
      current.push(row);
    }
  }

  const instructionsBySession = new Map(
    (input.instructionBySession ?? []).map((row) => [row.sessionId, row]),
  );

  const sessions: SourceSession[] = input.sessions.map((row) => {
    const model = parseJsonObject(row.model);
    const sessionModel = mapModel(model);
    const isoCreated = toIso(row.time_created) ?? new Date(0).toISOString();
    const isoUpdated = toIso(row.time_updated) ?? isoCreated;

    const instruction = instructionsBySession.get(row.id);

    return {
      id: row.id,
      ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
      projectId: row.project_id,
      project: projectLabel(row.project_worktree, row.directory),
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.directory === null ? {} : { directory: row.directory }),
      ...(row.agent === null ? {} : { agent: row.agent }),
      ...(sessionModel === undefined ? {} : { model: sessionModel }),
      schema: "v2",
      timeCreated: isoCreated,
      timeUpdated: isoUpdated,
      aggregateUsage: {
        input: row.tokens_input,
        output: row.tokens_output,
        thinking: row.tokens_reasoning,
        cacheRead: row.tokens_cache_read,
        cacheWrite: row.tokens_cache_write,
      },
      aggregateCost: row.cost,
      ...(instruction === undefined
        ? {}
        : {
            instructions: {
              keys: instruction.keys,
              chars: instruction.chars,
              prefixHash: instruction.prefixHash,
            },
          }),
    };
  });

  const unknownTypeCount = input.messages.filter((row) => mapType(row.type) === "unknown").length;

  const messages: SourceMessage[] = input.messages.map((row) => {
    const data = parseJsonObject(row.data_json);
    const mappedType = mapType(row.type);
    const usageTokens = tokenCounts(data);
    const isModelCall = mappedType === "assistant" || mappedType === "compaction";

    const timeObject = asObject(data?.time);
    const completedAt = toIso(asFiniteNumber(timeObject?.completed));

    const toolRows = toolsByMessage.get(row.id) ?? [];
    const toolCalls = normalizeToolCalls(toolRows);

    const model = mapModel(asObject(data?.model));

    const message: SourceMessage = {
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      type: mappedType,
      ...(mappedType === "unknown" ? { rawType: row.type } : {}),
      timeCreated: toIso(row.time_created) ?? new Date(0).toISOString(),
      ...(row.time_updated === null ? {} : { timeUpdated: toIso(row.time_updated) }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(asString(data?.agent) === undefined ? {} : { agent: asString(data?.agent) }),
      ...(model === undefined ? {} : { model }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(asString(data?.finish) === undefined ? {} : { stopReason: asString(data?.finish) }),
      ...(asString(asObject(data?.error)?.type) === undefined
        ? {}
        : { errorType: asString(asObject(data?.error)?.type) }),
      ...(textByMessage.has(row.id) ? { textChars: textByMessage.get(row.id) } : {}),
    };

    if (isModelCall && usageTokens !== undefined) {
      message.usage = {
        tokens: usageTokens,
        ...(observedCost(data) === undefined ? {} : { observedUsd: observedCost(data) }),
      };
    }

    return message;
  });

  const warnings = messageWarnings(input);

  if (unknownTypeCount > 0) {
    warnings.push({
      code: WARNING_CODES.sourceUnknownType,
      message: "One or more message types were mapped to unknown",
      count: unknownTypeCount,
    });
  }

  const modelCalls = messages.filter((message) => message.type === "assistant" || message.type === "compaction");
  const unknownModelCount = modelCalls.filter((message) => message.model === undefined).length;
  if (unknownModelCount > 0) {
    warnings.push({
      code: WARNING_CODES.sourceUnknownModel,
      message: "One or more model calls are missing model identifiers",
      count: unknownModelCount,
    });
  }

  const missingCostCount = modelCalls.filter(
    (message) => message.usage !== undefined && message.usage.observedUsd === undefined,
  ).length;
  if (missingCostCount > 0) {
    warnings.push({
      code: WARNING_CODES.sourceMissingCost,
      message: "One or more model calls are missing observed cost",
      count: missingCostCount,
    });
  }

  return {
    schema: "v2",
    sessions,
    messages,
    warnings,
    sources: [input.sourcePath],
  };
}
