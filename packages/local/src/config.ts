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
import { WARNING_CODES, type SourceWarning } from "@munin/core";
import { absolutePath, pathFor, resolvePlatformPaths } from "./paths.js";
import type { MuninPaths } from "./paths.js";

export interface ResolvePathsOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides `MUNIN_DIR`; used by tests and by an explicit flag. */
  stateDir?: string;
  /** Defaults to `process.platform`; tests pass `win32` to prove Windows rules. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. `HOME` is never consulted. */
  home?: string;
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

/**
 * Resolve paths without touching the filesystem.
 *
 * Home comes from `os.homedir()`, not `HOME`. Git Bash on Windows sets
 * `HOME=/c/Users/...`, which is not a native path and would corrupt every
 * `path.join` below it.
 */
export function resolvePaths(options: ResolvePathsOptions = {}): MuninPaths {
  return resolvePlatformPaths({
    platform: options.platform ?? process.platform,
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  });
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
          code: WARNING_CODES.configUnreadable,
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
        {
          code: WARNING_CODES.configUnparseable,
          message: `${settingsPath} is not valid JSON; using defaults`,
        },
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      settings: {},
      warnings: [
        {
          code: WARNING_CODES.configInvalid,
          message: `${settingsPath} must contain a JSON object; using defaults`,
        },
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
      warnings.push({
        code: WARNING_CODES.configInvalidDb,
        message: "config.json `db` must be a non-empty string",
      });
    }
  }

  if (object.days !== undefined) {
    if (typeof object.days === "number" && Number.isFinite(object.days) && object.days > 0) {
      settings.days = object.days;
    } else {
      warnings.push({
        code: WARNING_CODES.configInvalidDays,
        message: "config.json `days` must be a positive number",
      });
    }
  }

  if (object.tz !== undefined) {
    if (typeof object.tz === "string" && object.tz.trim().length > 0) {
      settings.tz = object.tz;
    } else {
      warnings.push({
        code: WARNING_CODES.configInvalidTz,
        message: "config.json `tz` must be a non-empty string",
      });
    }
  }

  return { settings, warnings };
}

/**
 * Resolve the full local configuration: paths, settings, and the database path
 * with its origin. Does not check whether anything exists.
 */
export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const platform = options.platform ?? process.platform;
  const impl = pathFor(platform);
  const paths = resolvePaths(options);
  const { settings, warnings } = loadSettings(paths.settingsPath);

  if (options.db !== undefined && options.db.length > 0) {
    return {
      paths,
      dbPath: absolutePath(options.db, platform),
      dbOrigin: "flag",
      settings,
      warnings,
    };
  }
  if (paths.envDbPath !== undefined) {
    return { paths, dbPath: paths.envDbPath, dbOrigin: "env", settings, warnings };
  }
  if (settings.db !== undefined) {
    // Relative settings paths belong to the state directory, not the cwd: the
    // config travels with the state root it lives in.
    const dbPath = impl.isAbsolute(settings.db)
      ? impl.normalize(settings.db)
      : impl.resolve(paths.stateDir, settings.db);
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
