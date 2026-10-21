import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createController } from '../lib/controller.js';

const TODAY = new Date(2026, 8, 30, 12, 0, 0);

function success(snapshotId = 'current-snapshot') {
  return { state: 'success', snapshotId, files: 3, finishedAt: TODAY.toISOString() };
}

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

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-controller-extra-'));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'backup');
  const statePath = path.join(sourceRoot, 'storages', 'dsh-chat-backup.json');
  const controllers = [];
  const create = async overrides => {
    const controller = await createController({
      sourceRoot, destinationRoot, now: () => new Date(TODAY),
      backup: async () => success(), readStatus: async () => null,
      verifySnapshot: async () => ({ valid: true, sourceRoot: await fs.realpath(sourceRoot) }),
      ...overrides,
    });
    controllers.push(controller);
    return controller;
  };
  try {
    await fs.mkdir(sourceRoot);
    await run({ root, sourceRoot, destinationRoot, statePath, create });
  } finally {
    for (const controller of controllers) await controller.dispose();
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}

test('today’s valid snapshot from another source retries startup without announcing the prior success', async () => {
  await withFixture(async fixture => {
    const started = deferred();
    const recovered = deferred();
    const checks = [];
    const runs = [];
    const controller = await fixture.create({
      readStatus: async () => success('other-source-snapshot'),
      backup: async options => {
        runs.push(options);
        started.resolve();
        return recovered.promise;
      },
      verifySnapshot: async (destination, snapshotId) => {
        checks.push({ destination, snapshotId });
        return { valid: true, sourceRoot: snapshotId === 'other-source-snapshot'
          ? path.join(fixture.root, 'different-source') : await fs.realpath(fixture.sourceRoot) };
      },
    });
    const starting = controller.startup(trigger => controller.perform({ trigger }));
    try {
      await within(started.promise);
      assert.deepEqual(runs.map(run => run.trigger), ['startup']);
      assert.equal(controller.getState().lastAttempt.state, 'running');
      assert.equal(controller.getState().notice, null, 'another source cannot produce a success popup');
      recovered.resolve(success());
      await within(starting);
      assert.deepEqual(checks, [
        { destination: fixture.destinationRoot, snapshotId: 'other-source-snapshot' },
        { destination: fixture.destinationRoot, snapshotId: 'current-snapshot' },
      ]);
      assert.equal(controller.getState().lastAttempt.snapshotId, 'current-snapshot');
      assert.equal(controller.getState().notice.kind, 'success');
    } finally {
      recovered.resolve(success());
      await starting;
    }
  });
});

test('a recovery success clears a pending failure after today’s success was acknowledged', async () => {
  await withFixture(async fixture => {
    const controller = await fixture.create();
    await controller.perform({ trigger: 'startup' });
    const successNotice = controller.getState().notice;
    assert.equal(successNotice.kind, 'success');
    assert.equal(await controller.acknowledge({ id: successNotice.id }), true);
    await controller.reportFailure(new Error('fixture temporarily unavailable disk'), 'interval');
    const failureNotice = controller.getState().notice;
    assert.equal(failureNotice.kind, 'failure');
    await controller.perform({ trigger: 'manual' });
    assert.equal(controller.getState().lastAttempt.state, 'success');
    assert.equal(controller.getState().notice, null, 'recovery must dismiss stale failure without repeating today’s success');
    assert.equal(await controller.acknowledge({ id: failureNotice.id }), false);
    const stored = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
    assert.equal(stored.successShownDate, '2026-09-30');
    assert.equal(stored.lastAttempt.state, 'success');
  });
});

test('a newly active destination replaces metadata while an old path’s last attempt stays hidden', async () => {
  await withFixture(async fixture => {
    const oldController = await fixture.create();
    await oldController.reportFailure(new Error('fixture failure on old path'), 'startup');
    await oldController.dispose();
    const newDestination = path.join(fixture.root, 'new-backup');
    const newController = await fixture.create({ destinationRoot: newDestination });
    const state = newController.getState();
    assert.equal(state.destinationRoot, newDestination);
    assert.equal(state.needsSetup, false);
    assert.equal(state.running, false);
    assert.equal(state.lastAttempt, null, 'old destination status must not appear as current path status');
    const stored = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
    assert.equal(stored.destinationRoot, newDestination, 'metadata must follow the active destination');
    assert.equal(stored.lastAttempt.destinationRoot, fixture.destinationRoot, 'prior status remains available for provenance');
    await newController.dispose();
    const restarted = await fixture.create({ destinationRoot: newDestination });
    assert.equal(restarted.getState().destinationRoot, newDestination);
    assert.equal(restarted.getState().lastAttempt, null);
    assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).destinationRoot, newDestination);
  });
});

test('a casing-only Windows destination change cannot hide a later local failure', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFixture(async fixture => {
    const previous = await fixture.create({ destinationRoot: fixture.destinationRoot.toUpperCase() });
    await previous.reportFailure(new Error('fixture destination unavailable'), 'interval');
    await previous.dispose();
    const earlier = new Date(2026, 8, 30, 10, 0, 0);
    const restarted = await fixture.create({
      destinationRoot: fixture.destinationRoot.toLowerCase(),
      readStatus: async () => ({ ...success(), finishedAt: earlier.toISOString() }),
    });
    const triggers = [];
    await restarted.startup(async trigger => { triggers.push(trigger); });
    assert.deepEqual(triggers, ['startup'], 'the same physical destination must retry the newer failed attempt');
    assert.equal(restarted.getState().notice, null, 'an earlier destination success must not replace the failed attempt');
  });
});

test('a success queued before midnight records the local day on which the popup becomes visible', async () => {
  await withFixture(async fixture => {
    let current = new Date(2026, 8, 30, 23, 59, 59);
    const controller = await fixture.create({
      now: () => new Date(current),
      backup: async () => ({ ...success(), finishedAt: current.toISOString() }),
    });
    await controller.perform({ trigger: 'startup' });
    const notice = controller.getState().notice;
    assert.equal(notice.day, '2026-09-30');
    current = new Date(2026, 9, 1, 0, 0, 1);
    assert.equal(await controller.acknowledge({ id: notice.id }), true);
    const saved = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
    assert.equal(saved.successShownDate, '2026-10-01', 'daily suppression starts when the app actually displays the popup');
    await controller.perform({ trigger: 'interval' });
    assert.equal(controller.getState().notice, null, 'success must stay quiet on the actual display day');
    await controller.reportFailure(new Error('fixture later failure'), 'interval');
    assert.equal(controller.getState().notice.kind, 'failure', 'display-day success suppression never suppresses failures');
  });
});
