import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, listSnapshots, verifySnapshot } from '../lib/backup.js';

let deadPidPromise;

function hasExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

async function deadPid() {
  deadPidPromise ??= (async () => {
    const candidate = 2147483647;
    if (hasExited(candidate)) return candidate;
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.ok(hasExited(child.pid), 'the owned child PID must be confirmed absent before writing a stale lock');
    return child.pid;
  })();
  return deadPidPromise;
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function withFixture(run, { large = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chat-lock-test-'));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'backup');
  const logDir = path.join(sourceRoot, 'sessions', '2026', '09', '30');
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(path.join(logDir, 'session.v1.jsonl'), '{"role":"user","content":"lock fixture"}\n');
    if (large) {
      await fs.mkdir(path.join(sourceRoot, 'attachments'));
      await fs.writeFile(path.join(sourceRoot, 'attachments', 'large-fixture.bin'), Buffer.alloc(4 * 1024 * 1024, 0x6d));
    }
    await fs.mkdir(destinationRoot);
    await run({ root, sourceRoot, destinationRoot, lockPath: path.join(destinationRoot, '.backup.lock') });
  } finally {
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}

async function writeStaleLock(lockPath) {
  const lock = { pid: await deadPid(), token: randomUUID(), createdAt: '2000-01-01T00:00:00.000Z' };
  assert.ok(hasExited(lock.pid), 'stale-owner PID must still be absent');
  const content = JSON.stringify(lock);
  await fs.writeFile(lockPath, content);
  return { lock, content };
}

async function recoveryMarkers(destinationRoot) {
  return (await fs.readdir(destinationRoot)).filter((name) => name.startsWith('.recover-') && name.endsWith('.lock'));
}

async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a confirmed dead owner is reclaimed and successful backup removes both locks', async () => {
  await withFixture(async ({ sourceRoot, destinationRoot, lockPath }) => {
    await writeStaleLock(lockPath);
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-stale-lock' });
    assert.equal(result.state, 'success');
    assert.equal((await verifySnapshot(destinationRoot, result.snapshotId)).valid, true);
    assert.equal(await exists(lockPath), false);
    assert.deepEqual(await recoveryMarkers(destinationRoot), []);
  });
});

test('an existing stale-owner recovery barrier returns busy without changing either file', async () => {
  await withFixture(async ({ sourceRoot, destinationRoot, lockPath }) => {
    const { lock, content } = await writeStaleLock(lockPath);
    const barrierPath = path.join(destinationRoot, `.recover-${lock.token}.lock`);
    const barrier = JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() });
    await fs.writeFile(barrierPath, barrier);
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-existing-recovery' });
    assert.equal(result.state, 'busy');
    assert.equal(result.stale, true);
    assert.equal(await fs.readFile(lockPath, 'utf8'), content);
    assert.equal(await fs.readFile(barrierPath, 'utf8'), barrier);
    assert.deepEqual(await recoveryMarkers(destinationRoot), [path.basename(barrierPath)]);
    assert.equal(await exists(path.join(destinationRoot, 'snapshots')), false);
  });
});

test('four contenders recover one stale lock without stealing a new owner or publishing invalid snapshots', async () => {
  await withFixture(async ({ sourceRoot, destinationRoot, lockPath }) => {
    await writeStaleLock(lockPath);
    const outcomes = await within(Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
      backup({ sourceRoot, destinationRoot, trigger: `test-stale-contender-${index}` }))), 'concurrent stale-lock backups');
    assert.deepEqual(outcomes.filter((outcome) => outcome.status === 'rejected'), [],
      'a contender must not delete the active owner lock or cause an ownership/release failure');
    const results = outcomes.map((outcome) => outcome.value);
    assert.ok(results.every((result) => ['success', 'unchanged', 'busy'].includes(result.state)));
    assert.ok(results.some((result) => result.state === 'success'));
    const snapshots = await listSnapshots(destinationRoot);
    assert.ok(snapshots.length >= 1);
    assert.equal(snapshots.length, results.filter((result) => result.state === 'success').length);
    for (const snapshot of snapshots) {
      const checked = await verifySnapshot(destinationRoot, snapshot.id);
      assert.equal(checked.valid, true);
      assert.equal(checked.files, 2);
    }
    assert.equal(await exists(lockPath), false);
    assert.deepEqual(await recoveryMarkers(destinationRoot), []);
  }, { large: true });
});

test('malformed lock files remain busy and untouched', async (t) => {
  const absentPid = await deadPid();
  const validToken = randomUUID();
  const cases = [
    ['unparseable JSON', '{broken-json'],
    ['unsafe token', JSON.stringify({ pid: absentPid, token: '../escape' })],
    ['missing token', JSON.stringify({ pid: absentPid })],
    ['missing pid', JSON.stringify({ token: validToken })],
    ['zero pid', JSON.stringify({ pid: 0, token: validToken })],
    ['negative pid', JSON.stringify({ pid: -1, token: validToken })],
    ['fractional pid', JSON.stringify({ pid: 1.5, token: validToken })],
    ['string pid', JSON.stringify({ pid: String(absentPid), token: validToken })],
  ];
  for (const [name, content] of cases) {
    await t.test(name, async () => {
      await withFixture(async ({ sourceRoot, destinationRoot, lockPath }) => {
        await fs.writeFile(lockPath, content);
        const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-malformed-lock' });
        assert.equal(result.state, 'busy');
        assert.equal(await fs.readFile(lockPath, 'utf8'), content);
        assert.deepEqual(await recoveryMarkers(destinationRoot), []);
        assert.equal(await exists(path.join(destinationRoot, 'snapshots')), false);
      });
    });
  }
});
