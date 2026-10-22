/**
 * Local configuration and environment.
 *
 * This module answers two questions and nothing else: where Munin keeps its
 * own state, and which OpenCode database it should read. It never opens the
 * database and never writes to the state directory; readers and the ledger do
 * that in later phases.
 *
 * Precedence for the source database:
 *   explicit --db > MUNIN_DB > config.json `db` > the XDG default.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { SourceWarning } from "@munin/core";

/** Files Munin derives from source history. Nothing here mirrors OpenCode's data. */
export interface LedgerPaths {
  root: string;
  events: string;
  snapshots: string;
  changes: string;
  decisions: string;
  verifications: string;
}

export interface MuninPaths {
  /** Where Munin keeps derived state. Defaults to `~/.munin`. */
  stateDir: string;
  settingsPath: string;
  ledger: LedgerPaths;
  /** The OpenCode database path the platform default points at. */
  defaultDbPath: string;
  /** Set only when `MUNIN_DB` names a path. */
  envDbPath?: string;
}

export interface ResolvePathsOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides `MUNIN_DIR`; used by tests and by an explicit flag. */
  stateDir?: string;
}

/** Where the resolved database path came from, so `status` can explain it. */
export type DbOrigin = "flag" | "env" | "settings" | "default";

export interface MuninSettings {
  /** Source database path. Relative values resolve against the state directory. */
  db?: string;
  /** Default reporting window, in days. */
  days?: number;
  /** IANA timezone used for day buckets. */
  tz?: string;
}

export interface SettingsResult {
  settings: MuninSettings;
  warnings: SourceWarning[];
}

export interface ResolvedConfig {
  paths: MuninPaths;
  dbPath: string;
  dbOrigin: DbOrigin;
  settings: MuninSettings;
  warnings: SourceWarning[];
}

export interface LoadConfigOptions extends ResolvePathsOptions {
  /** Explicit `--db` value; the highest-precedence source. */
  db?: string;
}

/**
 * The state of the source database on disk. `missing` and `unreadable` are
 * expected outcomes, not exceptions: a first run has no database yet.
 */
export type SourceDatabaseStatus =
  | { kind: "ready"; path: string; sizeBytes: number; modifiedAt: string }
  | { kind: "missing"; path: string }
  | { kind: "unreadable"; path: string; reason: string };

/** Absolute form of a possibly relative path. Never expands `~`; shells do that. */
function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

/**
 * Resolve paths without touching the filesystem.
 *
 * `XDG_DATA_HOME` is ignored when relative, which is what the XDG spec asks
 * for; a relative data home would otherwise silently point at the cwd.
 */
export function resolvePaths(options: ResolvePathsOptions = {}): MuninPaths {
  const env = options.env ?? process.env;
  const home = homeDir(env);
  const dataHome =
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share");

  // Empty strings are treated as unset; `resolve("")` would quietly mean the cwd.
  const stateOverride =
    options.stateDir && options.stateDir.length > 0 ? options.stateDir : undefined;
  const envState = env.MUNIN_DIR && env.MUNIN_DIR.length > 0 ? env.MUNIN_DIR : undefined;
  const stateDir = absolute(stateOverride ?? envState ?? join(home, ".munin"));

  const envDbPath = env.MUNIN_DB && env.MUNIN_DB.length > 0 ? absolute(env.MUNIN_DB) : undefined;

  return {
    stateDir,
    settingsPath: join(stateDir, "config.json"),
    ledger: {
      root: stateDir,
      events: join(stateDir, "events.jsonl"),
      snapshots: join(stateDir, "snapshots.jsonl"),
      changes: join(stateDir, "changes.jsonl"),
      decisions: join(stateDir, "decisions.json"),
      verifications: join(stateDir, "verifications.json"),
    },
    defaultDbPath: join(dataHome, "opencode", "opencode.db"),
    ...(envDbPath === undefined ? {} : { envDbPath }),
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read `config.json` if it exists. Malformed settings degrade to defaults with
 * a warning: a typo must not stop a scan, and it must not be silent either.
 */
export function loadSettings(settingsPath: string): SettingsResult {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { settings: {}, warnings: [] };
    }
    return {
      settings: {},
      warnings: [
        {
          code: "config.unreadable",
          message: `Could not read ${settingsPath}: ${reasonOf(error)}`,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      settings: {},
      warnings: [
        { code: "config.unparseable", message: `${settingsPath} is not valid JSON; using defaults` },
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      settings: {},
      warnings: [
        { code: "config.invalid", message: `${settingsPath} must contain a JSON object; using defaults` },
      ],
    };
  }

  const object = parsed as Record<string, unknown>;
  const settings: MuninSettings = {};
  const warnings: SourceWarning[] = [];

  if (object.db !== undefined) {
    if (typeof object.db === "string" && object.db.trim().length > 0) {
      settings.db = object.db;
    } else {
      warnings.push({ code: "config.invalid-db", message: "config.json `db` must be a non-empty string" });
    }
  }

  if (object.days !== undefined) {
    if (typeof object.days === "number" && Number.isFinite(object.days) && object.days > 0) {
      settings.days = object.days;
    } else {
      warnings.push({
        code: "config.invalid-days",
        message: "config.json `days` must be a positive number",
      });
    }
  }

  if (object.tz !== undefined) {
    if (typeof object.tz === "string" && object.tz.trim().length > 0) {
      settings.tz = object.tz;
    } else {
      warnings.push({ code: "config.invalid-tz", message: "config.json `tz` must be a non-empty string" });
    }
  }

  return { settings, warnings };
}

/**
 * Resolve the full local configuration: paths, settings, and the database path
 * with its origin. Does not check whether anything exists.
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const paths = resolvePaths(options);
  const { settings, warnings } = loadSettings(paths.settingsPath);

  if (options.db !== undefined && options.db.length > 0) {
    return { paths, dbPath: absolute(options.db), dbOrigin: "flag", settings, warnings };
  }
  if (paths.envDbPath !== undefined) {
    return { paths, dbPath: paths.envDbPath, dbOrigin: "env", settings, warnings };
  }
  if (settings.db !== undefined) {
    // Relative settings paths belong to the state directory, not the cwd: the
    // config travels with the state root it lives in.
    const dbPath = isAbsolute(settings.db) ? settings.db : resolve(paths.stateDir, settings.db);
    return { paths, dbPath, dbOrigin: "settings", settings, warnings };
  }
  return { paths, dbPath: paths.defaultDbPath, dbOrigin: "default", settings, warnings };
}

/** Stat the source database without opening it. */
export function inspectSourceDatabase(path: string): SourceDatabaseStatus {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", path };
    }
    return { kind: "unreadable", path, reason: reasonOf(error) };
  }

  if (!stats.isFile()) {
    return { kind: "unreadable", path, reason: "path exists but is not a file" };
  }

  return {
    kind: "ready",
    path,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}
