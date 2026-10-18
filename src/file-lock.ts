import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_INTERVAL_MS = 25;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

interface ActiveLockEntry {
  depth: number;
  acquiredAt?: number;
  holderStack?: string;
}
// 登记当前进程内"锁被首次持有且 operation 尚未返回"的调用现场，
// 供等待方超时时区分：operation 真的卡死（登记还在）vs 锁文件泄漏（登记已清）。
const ACTIVE_LOCKS = new Map<string, ActiveLockEntry>();

interface FileLockRecord {
  token: string;
  pid: number;
  createdAt: number;
}

function sleepSync(ms: number): void {
  // Atomics.wait 对 NaN 超时会无限等待并冻结主线程，必须收敛为有限值。
  const delay = Number.isFinite(ms) ? Math.max(1, Math.floor(ms)) : 1;
  Atomics.wait(WAIT_ARRAY, 0, 0, delay);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describeHolder(lockPath: string): string {
  const entry = activeHolder(lockPath);
  if (entry) {
    return `in-process holder since ${new Date(entry.acquiredAt || 0).toISOString()} at ${entry.holderStack}`;
  }
  return 'no in-process holder (leaked lock file: operation returned without releasing)';
}

// 与 describeHolder 使用完全相同的口径（depth > 0 才算活跃持有）。
// 历史缺陷：回收保护曾用 ACTIVE_LOCKS.has() 判断，与诊断口径不一致，
// 会出现在 Map 中残留 depth=0 条目时"报 no in-process holder 却回收不掉"的自相矛盾，
// 使泄漏锁永久阻塞后续写入。
function activeHolder(lockPath: string): ActiveLockEntry | undefined {
  const entry = ACTIVE_LOCKS.get(lockPath);
  return entry && entry.depth > 0 ? entry : undefined;
}

// 释放/回收失败时的现场快照：锁文件当前 inode 与内容，用于定位"谁在何时替换/占用了锁"。
function describeLockFile(lockPath: string): string {
  try {
    const stat = fs.statSync(lockPath);
    let content = '';
    try { content = fs.readFileSync(lockPath, 'utf8'); } catch { content = '<unreadable>'; }
    return `dev=${stat.dev} ino=${stat.ino} mtimeMs=${stat.mtimeMs} content=${content}`;
  } catch (error) {
    return `missing (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`;
  }
}

function unlinkIfUnchanged(lockPath: string, expected: fs.Stats): boolean {
  try {
    const current = fs.statSync(lockPath);
    if (current.dev !== expected.dev || current.ino !== expected.ino) return false;
    return unlinkWithRenameFallback(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

// External tools (safe-delete guards, backup/snapshot agents) may replace a lock
// file via copy-back: the inode changes while the recorded content — including
// this call's token — survives. Releasing by inode alone then misreports the file
// as someone else's lock and leaks it permanently. If the token on disk is still
// the one this call wrote, the file is ours and safe to unlink.
function unlinkIfTokenMatches(lockPath: string, token: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<FileLockRecord>;
    if (parsed.token !== token) return false;
    return unlinkWithRenameFallback(lockPath);
  } catch {
    return false;
  }
}

// An unlink can fail for non-filesystem reasons: developer-tool shims injected
// through NODE_OPTIONS (e.g. CodeBuddy's node-language-shim) hook fs.unlinkSync
// and throw interactive-confirmation errors (SAFE_DELETE_BULK_CONFIRM_REQUIRED)
// once a per-turn bulk-delete threshold (500) is reached. A background daemon
// can never confirm those, which historically deadlocked every lock release
// after a few minutes of mirror reconcile churn. Renaming the file aside is not
// a delete: it restores lock semantics immediately and leaves the stray file
// for opportunistic cleanup. Callers must already have verified the file is
// safe to remove (inode or token match).
function unlinkWithRenameFallback(lockPath: string): boolean {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    try {
      const aside = `${lockPath}.stale-${process.pid}-${Date.now()}`;
      fs.renameSync(lockPath, aside);
      try { fs.unlinkSync(aside); } catch { /* best effort; harmless leftover */ }
      console.error(
        `[file-lock] released ${lockPath} via rename fallback (unlink rejected: ${(error as Error).message.slice(0, 200)})`,
      );
      return true;
    } catch {
      return false;
    }
  }
}

function removeStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    const stat = fs.statSync(lockPath);
    let ownerPid = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<FileLockRecord>;
      ownerPid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    } catch {
      // An unreadable old lock can be reclaimed after the stale threshold.
    }
    if (ownerPid === process.pid) {
      const holder = activeHolder(lockPath);
      if (holder) {
        // A synchronous operation cannot still hold the lock while this waiter runs
        // on the same JS thread unless the in-process registry disagrees with the
        // lock file (e.g. a leaked reentrant entry, or a wedged operation on a
        // separate module instance). All guarded mutations are millisecond-level
        // JSON writes, so holding past the stale threshold is treated as wedged
        // and force-reclaimed instead of blocking every future writer forever.
        const heldMs = Date.now() - (holder.acquiredAt ?? 0);
        if (Number.isFinite(heldMs) && heldMs < staleAfterMs) return false;
        console.error(
          `[file-lock] force-reclaiming own lock ${lockPath} held for ${heldMs}ms`
          + ` (threshold ${staleAfterMs}ms); holder acquired at ${holder.holderStack ?? 'unknown site'}`,
        );
      }
      const reclaimed = unlinkIfUnchanged(lockPath, stat);
      if (reclaimed) {
        console.error(`[file-lock] reclaimed leaked own lock ${lockPath} (leaked since ${new Date(stat.mtimeMs).toISOString()})`);
      }
      return reclaimed;
    }
    if (Date.now() - stat.mtimeMs < staleAfterMs) return false;
    if (ownerPid && isProcessAlive(ownerPid)) return false;
    return unlinkIfUnchanged(lockPath, stat);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function withFileLock<T>(
  targetPath: string,
  operation: () => T,
  options?: { timeoutMs?: number; staleAfterMs?: number },
): T {
  const lockPath = `${targetPath}.lock`;
  const active = ACTIVE_LOCKS.get(lockPath);
  if (active && active.depth > 0) {
    ACTIVE_LOCKS.set(lockPath, { ...active, depth: active.depth + 1 });
    try {
      return operation();
    } finally {
      const entry = ACTIVE_LOCKS.get(lockPath);
      const nextDepth = (entry?.depth || 1) - 1;
      if (nextDepth > 0 && entry) ACTIVE_LOCKS.set(lockPath, { ...entry, depth: nextDepth });
      else ACTIVE_LOCKS.delete(lockPath);
    }
  }

  const timeoutMs = Math.max(0, options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const staleAfterMs = Math.max(timeoutMs, options?.staleAfterMs ?? DEFAULT_STALE_LOCK_MS);
  const deadline = Date.now() + timeoutMs;
  const record: FileLockRecord = {
    token: crypto.randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
  };
  let handle: number | null = null;

  while (handle === null) {
    let opened: number;
    try {
      opened = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (removeStaleLock(lockPath, staleAfterMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for file lock: ${lockPath}; ${describeHolder(lockPath)}`
            + ` (lock record: ${fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : 'missing'})`,
        );
      }
      sleepSync(Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }
    try {
      fs.writeFileSync(opened, JSON.stringify(record), 'utf8');
      handle = opened;
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (!unlinkIfUnchanged(lockPath, fs.fstatSync(opened))) {
          throw new Error(`lock file was replaced before acquisition completed; current lock file: ${describeLockFile(lockPath)}`);
        }
      } catch (failure) {
        cleanupError = failure;
      } finally {
        try { fs.closeSync(opened); } catch (failure) { cleanupError ??= failure; }
      }
      if (cleanupError) {
        throw new AggregateError([error, cleanupError], `Failed to clean up file lock after acquisition error: ${lockPath}`);
      }
      throw error;
    }
  }

  try {
    ACTIVE_LOCKS.set(lockPath, {
      depth: 1,
      acquiredAt: Date.now(),
      holderStack: new Error('lock acquisition site').stack,
    });
    return operation();
  } finally {
    ACTIVE_LOCKS.delete(lockPath);
    let releaseError: unknown;
    try {
      const heldFile = fs.fstatSync(handle);
      if (!unlinkIfUnchanged(lockPath, heldFile) && !unlinkIfTokenMatches(lockPath, record.token)) {
        throw new Error(
          `lock file was replaced before release; held dev=${heldFile.dev} ino=${heldFile.ino},`
            + ` current lock file: ${describeLockFile(lockPath)}`,
        );
      }
    } catch (error) {
      releaseError = error;
    } finally {
      try { fs.closeSync(handle); } catch (error) { releaseError ??= error; }
    }
    if (releaseError) {
      throw new Error(`Failed to release file lock: ${lockPath}`, { cause: releaseError });
    }
  }
}

export function withFileLocks<T>(targetPaths: string[], operation: () => T): T {
  const paths = Array.from(new Set(targetPaths)).sort();
  const acquire = (index: number): T => {
    if (index >= paths.length) return operation();
    return withFileLock(paths[index], () => acquire(index + 1));
  };
  return acquire(0);
}
