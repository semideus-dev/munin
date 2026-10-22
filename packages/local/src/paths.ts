/**
 * Platform path resolution.
 *
 * Kept pure and separate from `config.ts` so Windows rules can be tested on
 * macOS and Linux. OpenCode 2.x resolves its data root the same way on every
 * platform (`XDG_DATA_HOME || <home>/.local/share`), so Munin matches that
 * instead of inventing `%LOCALAPPDATA%` defaults that OpenCode never reads.
 */
import { posix, win32 } from "node:path";

type PathImpl = typeof posix;

/** Files Munin derives from source history. Nothing here mirrors OpenCode's data. */
export interface LedgerPaths {
  root: string;
  events: string;
  snapshots: string;
  cursors: string;
  changes: string;
  decisions: string;
  verifications: string;
  scanLock: string;
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

/** The only environment variables that affect path resolution. */
export interface PathEnvironment {
  MUNIN_DB?: string | undefined;
  MUNIN_DIR?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
}

export interface PlatformPathsInput {
  platform: NodeJS.Platform;
  /** Absolute home directory. Callers pass `os.homedir()`; never `HOME`. */
  home: string;
  env?: PathEnvironment;
  /** Overrides `MUNIN_DIR`; used by tests and by an explicit flag. */
  stateDir?: string;
}

/** The path implementation that matches `platform`, not the host. */
export function pathFor(platform: NodeJS.Platform): PathImpl {
  return platform === "win32" ? win32 : posix;
}

/** Absolute form of a possibly relative path. Never expands `~`; shells do that. */
export function absolutePath(input: string, platform: NodeJS.Platform): string {
  const impl = pathFor(platform);
  return impl.isAbsolute(input) ? impl.normalize(input) : impl.resolve(input);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function rooted(input: string, impl: PathImpl): string {
  return impl.isAbsolute(input) ? impl.normalize(input) : impl.resolve(input);
}

/**
 * Resolve paths without touching the filesystem.
 *
 * `XDG_DATA_HOME` is ignored when relative or empty, which is what the XDG spec
 * asks for; a relative data home would otherwise silently point at the cwd.
 * Empty `MUNIN_DB` and `MUNIN_DIR` values are treated as unset for the same
 * reason.
 */
export function resolvePlatformPaths(input: PlatformPathsInput): MuninPaths {
  if (input.home.length === 0) {
    throw new TypeError("home directory is required to resolve Munin paths");
  }

  const impl = pathFor(input.platform);
  const env = input.env ?? {};
  const xdgDataHome = nonEmpty(env.XDG_DATA_HOME);
  const dataHome =
    xdgDataHome !== undefined && impl.isAbsolute(xdgDataHome)
      ? impl.normalize(xdgDataHome)
      : impl.join(input.home, ".local", "share");

  const stateOverride = nonEmpty(input.stateDir) ?? nonEmpty(env.MUNIN_DIR);
  const stateDir = rooted(stateOverride ?? impl.join(input.home, ".munin"), impl);
  const envDb = nonEmpty(env.MUNIN_DB);

  return {
    stateDir,
    settingsPath: impl.join(stateDir, "config.json"),
    ledger: {
      root: stateDir,
      events: impl.join(stateDir, "events.jsonl"),
      snapshots: impl.join(stateDir, "snapshots.jsonl"),
      cursors: impl.join(stateDir, "cursors.json"),
      changes: impl.join(stateDir, "changes.jsonl"),
      decisions: impl.join(stateDir, "decisions.json"),
      verifications: impl.join(stateDir, "verifications.json"),
      scanLock: impl.join(stateDir, "scan.lock"),
    },
    defaultDbPath: impl.join(dataHome, "opencode", "opencode.db"),
    ...(envDb === undefined ? {} : { envDbPath: rooted(envDb, impl) }),
  };
}
