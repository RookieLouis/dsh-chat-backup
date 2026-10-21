import test from 'node:test';
import assert from 'node:assert/strict';
import { installLifecycle } from '../lib/lifecycle.js';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture operation timed out')), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
}

const config = {
  enabled: true, sourceRoot: 'fixture-source', destinationRoot: 'old-backup',
  intervalMinutes: 60, debounceSeconds: 0.01, backupAfterTurn: true,
};

function makeHost(flush = async () => {}) {
  const cleanups = [];
  const listeners = new Map();
  const warnings = [];
  let ready;
  const ctx = {
    sessions: { flush },
    logger: () => ({ info() {}, warn: message => warnings.push(message) }),
    get: () => ({ onReady(callback) { ready = callback; return () => { ready = undefined; }; } }),
    effect(setup) { cleanups.push(setup()); },
    on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); },
  };
  return {
    ctx, warnings,
    ready: () => ready?.(),
    emit: () => listeners.get('session/event')?.({ id: 'fixture-session' }, { type: 'turn/end' }),
    async dispose() { for (const cleanup of [...cleanups].reverse()) await cleanup(); },
  };
}

test('scope teardown drains pending startup verification before settings switch to a new destination', async () => {
  const checking = deferred();
  const verified = deferred();
  const metadata = { destinationRoot: 'old-backup' };
  const writes = [];
  let backups = 0;
  const host = makeHost();
  installLifecycle(host.ctx, config, {
    backup: async () => { backups += 1; return { state: 'success' }; },
    startup: async () => {
      checking.resolve();
      await verified.promise;
      metadata.destinationRoot = 'old-backup';
      writes.push('old verification completed');
      return { state: 'verified' };
    },
  });
  host.ready();
  await within(checking.promise);
  let disposed = false;
  const disposing = host.dispose().then(() => { disposed = true; });
  try {
    await Promise.resolve();
    assert.equal(disposed, false, 'cleanup must await verification even when no backup is active');
    verified.resolve();
    await within(disposing);
    metadata.destinationRoot = 'new-backup';
    writes.push('new settings applied');
    await Promise.resolve();
    assert.equal(metadata.destinationRoot, 'new-backup');
    assert.deepEqual(writes, ['old verification completed', 'new settings applied']);
    assert.equal(backups, 0);
  } finally {
    verified.resolve();
    await disposing;
  }
});

test('failed session flush reports the exact failure and teardown awaits its persistence', async () => {
  const error = new Error('fixture flush rejected');
  const reporting = deferred();
  const persisted = deferred();
  const reports = [];
  let stored = false;
  let backups = 0;
  const host = makeHost(async () => { throw error; });
  installLifecycle(host.ctx, config, {
    backup: async () => { backups += 1; return { state: 'success' }; },
    reportFailure: async (reported, trigger) => {
      reports.push({ reported, trigger });
      reporting.resolve();
      await persisted.promise;
      stored = true;
    },
  });
  assert.equal(host.emit(), undefined, 'event dispatch must not wait for flush reporting');
  await within(reporting.promise);
  let disposed = false;
  const disposing = host.dispose().then(() => { disposed = true; });
  try {
    await Promise.resolve();
    assert.deepEqual(reports, [{ reported: error, trigger: 'flush' }]);
    assert.equal(stored, false);
    assert.equal(disposed, false, 'cleanup must drain asynchronous failure reporting');
    persisted.resolve();
    await within(disposing);
    assert.equal(stored, true);
    assert.equal(backups, 0, 'failed flush must not schedule a backup of unflushed data');
    assert.ok(host.warnings.some(message => message.includes(error.message)));
  } finally {
    persisted.resolve();
    await disposing;
  }
});

test('a rejected flush failure reporter is drained and logged without rejecting teardown', async () => {
  const flushError = new Error('fixture flush unavailable');
  const reportError = new Error('fixture local status unavailable');
  const host = makeHost(async () => { throw flushError; });
  const reports = [];
  installLifecycle(host.ctx, config, {
    backup: async () => assert.fail('failed flush must not start backup'),
    reportFailure: async (error, trigger) => {
      reports.push({ error, trigger });
      throw reportError;
    },
  });
  assert.equal(host.emit(), undefined);
  await assert.doesNotReject(() => host.dispose());
  assert.deepEqual(reports, [{ error: flushError, trigger: 'flush' }]);
  assert.ok(host.warnings.some(message => message.includes(flushError.message)));
  assert.ok(host.warnings.some(message => message.includes(reportError.message)));
});
