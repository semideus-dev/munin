import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface LockRecord {
  pid: number;
  startedAt: string;
  purpose: string;
}

export interface ScanLock {
  warning?: string;
  release(): void;
}

export interface AcquireScanLockOptions {
  now?: () => Date;
  maxAgeMs?: number;
  pid?: number;
}

/** Acquire an exclusive writer lock, recovering only a provably stale lock. */
export function acquireScanLock(
  path: string,
  purpose: string,
  options: AcquireScanLockOptions = {},
): ScanLock {
  if (!purpose.trim()) throw new TypeError("Scan lock purpose is required");
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  mkdirSync(dirname(path), { recursive: true });

  let warning: string | undefined;
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    warning = recoverStaleLock(path, maxAgeMs, now().getTime());
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (retryError) {
      if (isAlreadyExists(retryError))
        throw new Error(`Another Munin scan holds the lock: ${path}`);
      throw retryError;
    }
  }

  const record: LockRecord = { pid, startedAt: now().toISOString(), purpose };
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }
  closeSync(fd);
  const ownedInode = statSync(path).ino;

  return {
    ...(warning === undefined ? {} : { warning }),
    release() {
      if (!existsSync(path)) return;
      try {
        const current: unknown = JSON.parse(readFileSync(path, "utf8"));
        const currentStat = statSync(path);
        if (
          isRecord(current) &&
          currentStat.ino === ownedInode &&
          current.pid === record.pid &&
          current.startedAt === record.startedAt &&
          current.purpose === record.purpose
        )
          unlinkSync(path);
      } catch {
        // Do not remove a lock whose ownership cannot be established.
      }
    },
  };
}

function recoverStaleLock(path: string, maxAgeMs: number, nowMs: number): string | undefined {
  let current: unknown;
  let ageMs: number;
  try {
    ageMs = Math.max(0, nowMs - statSync(path).mtimeMs);
    current = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(current) && typeof current.startedAt === "string") {
      const startedAtMs = Date.parse(current.startedAt);
      if (Number.isFinite(startedAtMs)) ageMs = Math.max(0, nowMs - startedAtMs);
    }
  } catch {
    try {
      ageMs = Math.max(0, nowMs - statSync(path).mtimeMs);
    } catch {
      return undefined;
    }
  }

  const validRecord =
    isRecord(current) &&
    Number.isInteger(current.pid) &&
    (current.pid as number) > 0 &&
    typeof current.startedAt === "string" &&
    Number.isFinite(Date.parse(current.startedAt)) &&
    typeof current.purpose === "string";
  const lockRecord = validRecord ? (current as LockRecord) : undefined;
  if (lockRecord !== undefined && isProcessAlive(lockRecord.pid)) {
    throw new Error(`Another Munin scan holds the lock (pid ${lockRecord.pid}): ${path}`);
  }
  if (!validRecord && ageMs <= maxAgeMs) {
    throw new Error(`Cannot verify existing Munin scan lock; it is not stale yet: ${path}`);
  }

  try {
    unlinkSync(path);
  } catch {
    throw new Error(`Could not remove stale Munin scan lock: ${path}`);
  }
  return `Removed stale scan lock${lockRecord === undefined ? "" : ` from pid ${lockRecord.pid}`}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
