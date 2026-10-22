import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConfigStore, ConfigValueSnapshot, MuninConfigKey } from "@munin/core";

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`Munin config must contain a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function validateKey(key: string): asserts key is MuninConfigKey {
  if (key !== "days" && key !== "tz") {
    throw new TypeError(`Munin config key is not an apply target: ${key}`);
  }
}

function validateValue(key: MuninConfigKey, snapshot: ConfigValueSnapshot): void {
  if (!snapshot.exists) return;
  if (
    key === "days" &&
    (typeof snapshot.value !== "number" || !Number.isFinite(snapshot.value) || snapshot.value <= 0)
  ) {
    throw new TypeError("Munin config 'days' must be a positive finite number");
  }
  if (key === "tz" && (typeof snapshot.value !== "string" || snapshot.value.trim() === "")) {
    throw new TypeError("Munin config 'tz' must be a non-empty string");
  }
}

/**
 * Restricted store for Munin-owned analysis settings. It deliberately cannot
 * alter `db`, OpenCode configuration, arbitrary files, or agent prompts.
 */
export function openMuninConfigStore(path: string): ConfigStore {
  return {
    read(key) {
      validateKey(key);
      const config = readObject(path);
      return Object.hasOwn(config, key) ? { exists: true, value: config[key] } : { exists: false };
    },
    write(key, snapshot) {
      validateKey(key);
      validateValue(key, snapshot);
      const config = readObject(path);
      if (snapshot.exists) config[key] = snapshot.value;
      else delete config[key];
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    },
    snapshot() {
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    restoreSnapshot(snapshot) {
      if (snapshot === null) {
        if (existsSync(path)) unlinkSync(path);
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, snapshot, "utf8");
    },
  };
}
