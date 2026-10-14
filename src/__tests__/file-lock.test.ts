import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock } from '../file-lock.js';

function tempTarget(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cti-lock-')), 'state.json');
}

describe('withFileLock', () => {
  it('releases the lock file after the operation completes', () => {
    const target = tempTarget();
    const result = withFileLock(target, () => 42);
    assert.equal(result, 42);
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });

  it('cleans up a lock if writing its ownership record fails', () => {
    const target = tempTarget();
    const writeFileSync = fs.writeFileSync;
    try {
      fs.writeFileSync = ((file: Parameters<typeof fs.writeFileSync>[0], ...args: unknown[]) => {
        if (typeof file === 'number') throw new Error('simulated record write failure');
        return (writeFileSync as (...args: unknown[]) => void)(file, ...args);
      }) as typeof fs.writeFileSync;
      assert.throws(() => withFileLock(target, () => undefined), /simulated record write failure/);
    } finally {
      fs.writeFileSync = writeFileSync;
    }
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });

  it('is reentrant for nested locks on the same path within one synchronous operation', () => {
    const target = tempTarget();
    const inner = withFileLock(target, () => withFileLock(target, () => 'nested'));
    assert.equal(inner, 'nested');
    assert.equal(fs.existsSync(`${target}.lock`), false);
  });

  it('reclaims an own ghost lock after the ghost threshold so waiters can recover', () => {
    const target = tempTarget();
    const ghostPath = `${target}.lock`;
    fs.writeFileSync(ghostPath, JSON.stringify({ token: 'ghost', pid: process.pid, createdAt: Date.now() }), 'utf8');
    const old = new Date(Date.now() - 130_000);
    fs.utimesSync(ghostPath, old, old);

    const result = withFileLock(target, () => 'recovered', { timeoutMs: 200, staleAfterMs: 30_000 });
    assert.equal(result, 'recovered');
    assert.equal(fs.existsSync(ghostPath), false);
  });

  it('reclaims an own lock immediately when no synchronous operation holds it', () => {
    const target = tempTarget();
    const lockPath = `${target}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ token: 'orphan', pid: process.pid, createdAt: Date.now() }), 'utf8');

    assert.equal(withFileLock(target, () => 'recovered', { timeoutMs: 80 }), 'recovered');
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('reports a release failure instead of silently leaving a poisoned lock', { skip: process.getuid?.() === 0 }, () => {
    const target = tempTarget();
    const directory = path.dirname(target);
    try {
      assert.throws(() => withFileLock(target, () => {
        fs.chmodSync(directory, 0o500);
      }), /Failed to release file lock/);
      assert.equal(fs.existsSync(`${target}.lock`), true);
    } finally {
      fs.chmodSync(directory, 0o700);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not delete a replacement lock when the original file moves', () => {
    const target = tempTarget();
    const lockPath = `${target}.lock`;
    const movedPath = `${lockPath}.moved`;
    try {
      assert.throws(() => withFileLock(target, () => {
        fs.renameSync(lockPath, movedPath);
        fs.writeFileSync(lockPath, JSON.stringify({ token: 'replacement', pid: 1, createdAt: Date.now() }));
      }), /Failed to release file lock/);
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'replacement');
    } finally {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
    }
  });

  it('still respects locks owned by another live process regardless of age', () => {
    const target = tempTarget();
    const ghostPath = `${target}.lock`;
    // pid 1 (launchd) always exists on macOS/Linux CI hosts.
    fs.writeFileSync(ghostPath, JSON.stringify({ token: 'foreign', pid: 1, createdAt: Date.now() }), 'utf8');
    const old = new Date(Date.now() - 300_000);
    fs.utimesSync(ghostPath, old, old);

    assert.throws(
      () => withFileLock(target, () => 'never', { timeoutMs: 80, staleAfterMs: 30_000 }),
      /Timed out waiting for file lock/,
    );
  });
});
