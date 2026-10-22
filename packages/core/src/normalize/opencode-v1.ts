import type { Dataset, ModelRef, SourceMessage, SourceSession, TokenCounts } from "../domain/index.js";
import { projectLabel } from "./text.js";
import { toIso } from "./time.js";
import type { RawMessageV1Row, RawPartV1Row, RawSessionV1Row, RawToolProjectionRow } from "./rows.js";
import { normalizeToolCalls } from "./tools.js";

export interface NormalizeV1Input {
  sessions: RawSessionV1Row[];
  messages: RawMessageV1Row[];
  parts: RawPartV1Row[];
  sourcePath: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseObject(json: string | null): Record<string, unknown> | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    return asObject(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function mapTokens(data: Record<string, unknown> | undefined): TokenCounts | undefined {
  const tokens = asObject(data?.tokens);
  if (tokens === undefined) {
    return undefined;
  }

  const cache = asObject(tokens.cache);
  return {
    input: asNumber(tokens.input) ?? 0,
    output: asNumber(tokens.output) ?? 0,
    thinking: asNumber(tokens.reasoning) ?? 0,
    cacheRead: asNumber(cache?.read) ?? 0,
    cacheWrite: asNumber(cache?.write) ?? 0,
  };
}

function toolPartToRow(part: RawPartV1Row, index: number): RawToolProjectionRow {
  const data = parseObject(part.data_json);
  const name = asString(data?.name) ?? "unknown";
  const toolId = asString(data?.id);
  const state = asObject(data?.state);
  const input = asObject(state?.input);

  return {
    message_id: part.message_id,
    tool_id: toolId ?? `${name}-${index}`,
    tool_name: name,
    tool_input_json: input === undefined ? null : JSON.stringify(input),
    tool_status: asString(state?.status) ?? null,
    tool_output_chars: part.tool_output_chars,
  };
}

export function normalizeOpenCodeV1(input: NormalizeV1Input): Dataset {
  const sessions: SourceSession[] = input.sessions.map((row) => ({
    id: row.id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    projectId: row.project_id ?? "unknown",
    project: projectLabel(row.project_worktree, row.directory),
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.directory === null ? {} : { directory: row.directory }),
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(mapModel(parseObject(row.model)) === undefined ? {} : { model: mapModel(parseObject(row.model)) }),
    schema: "v1",
    timeCreated: toIso(row.time_created) ?? new Date(0).toISOString(),
    timeUpdated: toIso(row.time_updated) ?? new Date(0).toISOString(),
  }));

  const partsByMessage = new Map<string, RawPartV1Row[]>();
  for (const part of input.parts) {
    const current = partsByMessage.get(part.message_id);
    if (current === undefined) {
      partsByMessage.set(part.message_id, [part]);
    } else {
      current.push(part);
    }
  }

  const messages: SourceMessage[] = [];

  for (const messageRow of input.messages) {
    const parts = (partsByMessage.get(messageRow.id) ?? []).sort((a, b) => a.seq - b.seq);

    const pendingTools: RawPartV1Row[] = [];
    for (const part of parts) {
      if (part.type === "tool") {
        pendingTools.push(part);
        continue;
      }

      if (part.type !== "step-finish") {
        continue;
      }

      const data = parseObject(part.data_json);
      const usageTokens = mapTokens(data);
      const completedAt = toIso(asNumber(asObject(data?.time)?.completed));
      const model = mapModel(asObject(data?.model));

      const toolRows = pendingTools.map((tool, index) => toolPartToRow(tool, index));
      const toolCalls = normalizeToolCalls(toolRows);

      const sourceMessage: SourceMessage = {
        id: `${messageRow.id}#${part.id}`,
        sessionId: messageRow.session_id,
        seq: part.seq,
        type: "assistant",
        timeCreated: toIso(messageRow.time_created) ?? new Date(0).toISOString(),
        timeUpdated: toIso(messageRow.time_updated),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(asString(data?.agent) === undefined ? {} : { agent: asString(data?.agent) }),
        ...(model === undefined ? {} : { model }),
        ...(asString(data?.finish) === undefined ? {} : { stopReason: asString(data?.finish) }),
        ...(asString(asObject(data?.error)?.type) === undefined
          ? {}
          : { errorType: asString(asObject(data?.error)?.type) }),
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
      };

      if (usageTokens !== undefined) {
        sourceMessage.usage = {
          tokens: usageTokens,
          ...(part.cost === null ? {} : { observedUsd: part.cost }),
        };
      }

      messages.push(sourceMessage);
      pendingTools.length = 0;
    }
  }

  return {
    schema: "v1",
    sessions,
    messages,
    warnings: [],
    sources: [input.sourcePath],
  };
}
