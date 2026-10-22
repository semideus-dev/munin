import type { ToolCall } from "../domain/usage.js";
import type { RawToolProjectionRow } from "./rows.js";

function canonicalToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "read") return "Read";
  if (lower === "edit") return "Edit";
  if (lower === "shell") return "Bash";
  if (lower === "bash") return "Bash";
  if (lower === "grep") return "Grep";
  if (lower === "glob") return "Glob";
  if (lower === "ls") return "LS";
  if (lower === "webfetch") return "WebFetch";
  if (lower === "fetch") return "WebFetch";
  return name;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function signature(name: string, parsedInput: Record<string, unknown> | undefined): string {
  const canonical = canonicalToolName(name);

  if (canonical === "Read") {
    const path = readString(parsedInput, "path") ?? "";
    const offset = parsedInput?.offset;
    const limit = parsedInput?.limit;
    const offsetText = typeof offset === "number" ? String(offset) : "";
    const limitText = typeof limit === "number" ? String(limit) : "";
    return `Read:${path}#${offsetText}:${limitText}`;
  }

  if (canonical === "Edit") {
    const path = readString(parsedInput, "path") ?? readString(parsedInput, "filePath") ?? "";
    const oldText = readString(parsedInput, "old_text") ?? "";
    return `Edit:${path}#${oldText.slice(0, 40)}`;
  }

  if (canonical === "Bash") {
    const command = readString(parsedInput, "command") ?? "";
    return `Bash:${command}`;
  }

  if (canonical === "Grep") {
    const pattern = readString(parsedInput, "regex") ?? "";
    const include = readString(parsedInput, "include_pattern") ?? "";
    return `Grep:${pattern}|${include}`;
  }

  if (canonical === "Glob") {
    return `Glob:${readString(parsedInput, "glob") ?? ""}`;
  }

  if (canonical === "WebFetch") {
    return `WebFetch:${readString(parsedInput, "url") ?? ""}`;
  }

  const prefix = parsedInput === undefined ? "" : JSON.stringify(parsedInput).slice(0, 80);
  return `${name}:${prefix}`;
}

function parseInput(inputJson: string | null): Record<string, unknown> | undefined {
  if (inputJson === null) {
    return undefined;
  }
  try {
    return asObject(JSON.parse(inputJson));
  } catch {
    return undefined;
  }
}

export function normalizeToolCalls(rows: RawToolProjectionRow[]): ToolCall[] {
  return rows.map((row, index) => {
    const rawName = row.tool_name ?? "unknown";
    const parsedInput = parseInput(row.tool_input_json);
    const id = row.tool_id && row.tool_id.length > 0 ? row.tool_id : `${rawName}-${index}`;
    const target = readString(parsedInput, "path") ?? readString(parsedInput, "filePath");
    return {
      id,
      name: canonicalToolName(rawName),
      signature: signature(rawName, parsedInput),
      ...(target === undefined ? {} : { target }),
      ...(row.tool_output_chars === null ? {} : { resultChars: row.tool_output_chars }),
      ...(row.tool_status === "error" ? { isError: true } : {}),
    };
  });
}
