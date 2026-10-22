import type { ToolCall } from "../domain/usage.js";
import type { RawToolProjectionRow } from "./rows.js";

function canonicalToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "read") return "Read";
  if (lower === "write") return "Write";
  if (lower === "edit") return "Edit";
  if (lower === "shell") return "Bash";
  if (lower === "bash") return "Bash";
  if (lower === "exec") return "Bash";
  if (lower === "execute") return "Execute";
  if (lower === "grep") return "Grep";
  if (lower === "glob") return "Glob";
  if (lower === "ls") return "LS";
  if (lower === "webfetch") return "WebFetch";
  if (lower === "fetch") return "WebFetch";
  if (lower === "search") return "Search";
  if (lower === "find") return "Find";
  if (lower === "print_tree") return "PrintTree";
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

function readPath(input: Record<string, unknown> | undefined): string | undefined {
  return readString(input, "path") ?? readString(input, "filePath");
}

/**
 * A short, stable, non-cryptographic hash. Used only to tell two edits or
 * writes of one file apart without serialising their text.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function signature(name: string, parsedInput: Record<string, unknown> | undefined): string {
  const canonical = canonicalToolName(name);

  if (canonical === "Read") {
    const path = readPath(parsedInput) ?? "";
    const offset = parsedInput?.offset;
    const limit = parsedInput?.limit;
    const offsetText = typeof offset === "number" ? String(offset) : "";
    const limitText = typeof limit === "number" ? String(limit) : "";
    return `Read:${path}#${offsetText}:${limitText}`;
  }

  if (canonical === "Write") {
    const path = readPath(parsedInput) ?? "";
    const content = readString(parsedInput, "content") ?? "";
    return `Write:${path}#${shortHash(content)}`;
  }

  if (canonical === "Edit") {
    const path = readPath(parsedInput) ?? "";
    const oldText =
      readString(parsedInput, "oldString") ?? readString(parsedInput, "old_text") ?? "";
    return `Edit:${path}#${shortHash(oldText)}`;
  }

  if (canonical === "Bash") {
    const command = readString(parsedInput, "command") ?? "";
    return `Bash:${command}`;
  }

  if (canonical === "Execute") {
    const command = readString(parsedInput, "command") ?? readString(parsedInput, "cmd") ?? "";
    return `Execute:${command}`;
  }

  if (canonical === "Grep") {
    const pattern = readString(parsedInput, "pattern") ?? readString(parsedInput, "regex") ?? "";
    const include =
      readString(parsedInput, "include") ?? readString(parsedInput, "include_pattern") ?? "";
    const path = readPath(parsedInput) ?? "";
    return `Grep:${pattern}|${include}|${path}`;
  }

  if (canonical === "Glob") {
    const pattern = readString(parsedInput, "pattern") ?? readString(parsedInput, "glob") ?? "";
    const path = readPath(parsedInput) ?? "";
    return `Glob:${pattern}|${path}`;
  }

  if (canonical === "LS") {
    return `LS:${readPath(parsedInput) ?? ""}`;
  }

  if (canonical === "Find") {
    const pattern = readString(parsedInput, "pattern") ?? "";
    const path = readPath(parsedInput) ?? "";
    return `Find:${pattern}|${path}`;
  }

  if (canonical === "Search") {
    const query = readString(parsedInput, "query") ?? readString(parsedInput, "pattern") ?? "";
    return `Search:${query}`;
  }

  if (canonical === "PrintTree") {
    return `PrintTree:${readPath(parsedInput) ?? ""}`;
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
    const target = readPath(parsedInput);
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
