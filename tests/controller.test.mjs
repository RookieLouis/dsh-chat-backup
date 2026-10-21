import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createController } from '../lib/controller.js';

const TODAY = new Date(2026, 8, 30, 12, 0, 0);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 1500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function success(at = TODAY, state = 'success') {
  return {
    state, snapshotId: 'fixture-snapshot', files: 3, newObjects: state === 'unchanged' ? 0 : 2,
    bytesCopied: state === 'unchanged' ? 0 : 24,
    startedAt: new Date(at.getTime() - 1000).toISOString(), finishedAt: at.toISOString(), trigger: 'fixture',
  };
}

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chat-controller-test-'));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'backup');
  const statePath = path.join(sourceRoot, 'storages', 'dsh-chat-backup.json');
  try {
    await fs.mkdir(sourceRoot);
    await run({ root, sourceRoot, destinationRoot, statePath });
  } finally {
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}

function optionsFor(fixture, overrides = {}) {
  return {
    sourceRoot: fixture.sourceRoot,
    destinationRoot: fixture.destinationRoot,
    now: () => new Date(TODAY),
    backup: async () => success(),
    verifySnapshot: async (_destination, snapshotId) => ({ valid: true, snapshotId, files: 3, bytes: 24 }),
    readStatus: async () => null,
    ...overrides,
  };
}

function assertNotice(controller, kind) {
  const notice = controller.getState().notice;
  assert.ok(notice, `expected a ${kind} notice`);
  assert.equal(notice.kind, kind);
  assert.equal(typeof notice.id, 'string');
  assert.ok(notice.id.length > 0);
  return notice;
}

test('unset destination requests setup and startup performs no backup', async () => {
  await withFixture(async (fixture) => {
    let runs = 0;
    let backups = 0;
    const controller = await createController(optionsFor(fixture, {
      destinationRoot: '',
      backup: async () => { backups += 1; return success(); },
    }));
    assert.equal(controller.getState().needsSetup, true);
    assert.ok(!controller.getState().destinationRoot);
    await controller.startup(async () => { runs += 1; });
    assert.equal(runs, 0);
    assert.equal(backups, 0);
  });
});

test('perform persists running state and only reports success after backup completes', async () => {
  await withFixture(async (fixture) => {
    const started = deferred();
    const completed = deferred();
    const calls = [];
    const controller = await createController(optionsFor(fixture, {
      backup: async (options) => { calls.push(options); started.resolve(); return completed.promise; },
    }));
    const performing = controller.perform({ trigger: 'startup' });
    try {
      await within(started.promise, 'perform start');
      assert.equal(controller.getState().lastAttempt.state, 'running');
      assert.ok(!controller.getState().notice);
      assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).lastAttempt.state, 'running');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].sourceRoot, fixture.sourceRoot);
      assert.equal(calls[0].destinationRoot, fixture.destinationRoot);
      assert.equal(calls[0].trigger, 'startup');
      completed.resolve(success());
      const result = await within(performing, 'perform completion');
      assert.equal(result.state, 'success');
      assert.equal(controller.getState().lastAttempt.state, 'success');
      assertNotice(controller, 'success');
    } finally {
      completed.resolve(success());
      await performing;
    }
  });
});

test('verified success today skips backup and acknowledged success stays suppressed across restarts', async () => {
  await withFixture(async (fixture) => {
    const verified = [];
    let runs = 0;
    const config = optionsFor(fixture, {
      readStatus: async () => success(),
      verifySnapshot: async (destination, snapshotId) => {
        verified.push({ destination, snapshotId });
        return { valid: true, snapshotId };
      },
    });
    const controller = await createController(config);
    await controller.startup(async () => { runs += 1; });
    assert.equal(runs, 0);
    assert.deepEqual(verified, [{ destination: fixture.destinationRoot, snapshotId: 'fixture-snapshot' }]);
    const notice = assertNotice(controller, 'success');
    await controller.acknowledge({ id: 'obsolete-notice' });
    assert.equal(controller.getState().notice.id, notice.id);
    await controller.acknowledge({ id: notice.id });
    assert.ok(!controller.getState().notice);
    const saved = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
    assert.ok(JSON.stringify(saved).includes('2026-09-30'), 'acknowledgement stores the local calendar date');

    const restarted = await createController(config);
    await restarted.startup(async () => { runs += 1; });
    assert.equal(runs, 0);
    assert.ok(!restarted.getState().notice);
    await restarted.perform({ trigger: 'interval' });
    assert.ok(!restarted.getState().notice, 'another successful background backup must not repeat today’s success');
    const unchanged = await createController({ ...config, backup: async () => success(TODAY, 'unchanged') });
    await unchanged.perform({ trigger: 'turn/end' });
    assert.ok(!unchanged.getState().notice, 'unchanged results obey the persisted daily acknowledgement');
  });
});

test('unchanged backup status today is eligible for one verified success notice', async () => {
  await withFixture(async (fixture) => {
    const controller = await createController(optionsFor(fixture, { readStatus: async () => success(TODAY, 'unchanged') }));
    let runs = 0;
    await controller.startup(async () => { runs += 1; });
    assert.equal(runs, 0);
    assertNotice(controller, 'success');
  });
});

test('yesterday, missing, corrupt, failed or invalid status requests startup backup', async (t) => {
  const yesterday = new Date(2026, 8, 29, 12, 0, 0);
  const cases = [
    ['yesterday', { readStatus: async () => success(yesterday) }],
    ['missing', { readStatus: async () => null }],
    ['unreadable status', { readStatus: async () => { throw new Error('fixture unavailable status'); } }],
    ['failed status', { readStatus: async () => ({ state: 'failed', finishedAt: TODAY.toISOString(), error: 'fixture failed' }) }],
    ['invalid finish time', { readStatus: async () => ({ ...success(), finishedAt: 'not-a-date' }) }],
    ['corrupt snapshot', { readStatus: async () => success(), verifySnapshot: async () => { throw new Error('fixture checksum mismatch'); } }],
    ['invalid verification report', { readStatus: async () => success(), verifySnapshot: async () => ({ valid: false }) }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      await withFixture(async (fixture) => {
        const controller = await createController(optionsFor(fixture, overrides));
        const triggers = [];
        await controller.startup(async (trigger) => { triggers.push(trigger); });
        assert.deepEqual(triggers, ['startup']);
        assert.ok(!controller.getState().notice || controller.getState().notice.kind !== 'success');
      });
    });
  }
});

test('a later local failed attempt overrides an earlier successful destination status', async () => {
  await withFixture(async (fixture) => {
    const earlier = new Date(2026, 8, 30, 10, 0, 0);
    const controller = await createController(optionsFor(fixture));
    await controller.reportFailure(new Error('fixture destination offline'), 'interval');
    assert.equal(controller.getState().lastAttempt.state, 'failed');
    const restarted = await createController(optionsFor(fixture, { readStatus: async () => success(earlier) }));
    const triggers = [];
    await restarted.startup(async (trigger) => { triggers.push(trigger); });
    assert.deepEqual(triggers, ['startup']);
    assert.ok(!restarted.getState().notice || restarted.getState().notice.kind !== 'success');
  });
});

test('an interrupted running attempt overrides earlier success when controller restarts', async () => {
  await withFixture(async (fixture) => {
    const started = deferred();
    const completed = deferred();
    const controller = await createController(optionsFor(fixture, {
      backup: async () => { started.resolve(); return completed.promise; },
    }));
    const performing = controller.perform({ trigger: 'interval' });
    try {
      await within(started.promise, 'persisted running attempt');
      const earlier = new Date(2026, 8, 30, 10, 0, 0);
      const restarted = await createController(optionsFor(fixture, { readStatus: async () => success(earlier) }));
      const triggers = [];
      await restarted.startup(async (trigger) => { triggers.push(trigger); });
      assert.deepEqual(triggers, ['startup']);
    } finally {
      completed.resolve(success());
      await performing;
    }
  });
});

test('crossing local midnight retries yesterday’s status and permits a new daily success notice', async () => {
  await withFixture(async (fixture) => {
    let current = new Date(2026, 8, 30, 23, 59, 59);
    let destinationStatus = success(current);
    const config = optionsFor(fixture, {
      now: () => new Date(current),
      readStatus: async () => destinationStatus,
      backup: async () => { destinationStatus = success(current, 'unchanged'); return destinationStatus; },
    });
    const beforeMidnight = await createController(config);
    await beforeMidnight.startup(async () => { assert.fail('today’s valid backup must skip startup work'); });
    const dayOne = assertNotice(beforeMidnight, 'success');
    await beforeMidnight.acknowledge({ id: dayOne.id });
    current = new Date(2026, 9, 1, 0, 0, 1);
    const afterMidnight = await createController(config);
    const triggers = [];
    await afterMidnight.startup(async (trigger) => {
      triggers.push(trigger);
      return afterMidnight.perform({ trigger });
    });
    assert.deepEqual(triggers, ['startup']);
    const dayTwo = assertNotice(afterMidnight, 'success');
    assert.notEqual(dayTwo.id, dayOne.id);
    await afterMidnight.acknowledge({ id: dayOne.id });
    assert.equal(afterMidnight.getState().notice.id, dayTwo.id, 'yesterday’s acknowledgement cannot dismiss today’s notice');
    await afterMidnight.acknowledge({ id: dayTwo.id });
    const restarted = await createController(config);
    await restarted.startup(async () => { assert.fail('today’s acknowledged backup should stay quiet'); });
    assert.ok(!restarted.getState().notice);
  });
});

test('failure persists locally while destination is inaccessible, rethrows, and always creates a new notice', async () => {
  await withFixture(async (fixture) => {
    const failure = new Error('fixture backup disk inaccessible');
    const config = optionsFor(fixture, {
      backup: async () => { throw failure; },
      readStatus: async () => { throw new Error('fixture status disk inaccessible'); },
    });
    const controller = await createController(config);
    await assert.rejects(() => controller.perform({ trigger: 'startup' }), (error) => error === failure);
    const first = assertNotice(controller, 'failure');
    assert.equal(controller.getState().lastAttempt.state, 'failed');
    const saved = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
    assert.equal(saved.lastAttempt.state, 'failed');
    assert.ok(JSON.stringify(saved).includes(failure.message));
    const restarted = await createController(config);
    assert.equal(restarted.getState().lastAttempt.state, 'failed');
    await assert.rejects(() => restarted.startup((trigger) => restarted.perform({ trigger })), (error) => error === failure);
    assertNotice(restarted, 'failure');
    await restarted.reportFailure(new Error('fixture flush failure'), 'turn/end');
    const second = assertNotice(restarted, 'failure');
    assert.notEqual(second.id, first.id);
    await restarted.acknowledge({ id: first.id });
    assert.equal(restarted.getState().notice.id, second.id);
    await restarted.acknowledge({ id: second.id });
    assert.ok(!restarted.getState().notice);
  });
});

test('an invalid verification report cannot create a success notice after perform', async () => {
  await withFixture(async (fixture) => {
    const controller = await createController(optionsFor(fixture, { verifySnapshot: async () => ({ valid: false }) }));
    await assert.rejects(() => controller.perform({ trigger: 'startup' }));
    assert.equal(controller.getState().lastAttempt.state, 'failed');
    assertNotice(controller, 'failure');
  });
});

test('malformed local metadata is preserved before startup retries', async () => {
  await withFixture(async (fixture) => {
    await fs.mkdir(path.dirname(fixture.statePath), { recursive: true });
    const original = '{malformed-local-state';
    await fs.writeFile(fixture.statePath, original);
    const controller = await createController(optionsFor(fixture, { readStatus: async () => success() }));
    const preserved = (await fs.readdir(path.dirname(fixture.statePath))).filter((name) => name.startsWith('dsh-chat-backup.json.invalid-'));
    assert.equal(preserved.length, 1);
    assert.equal(await fs.readFile(path.join(path.dirname(fixture.statePath), preserved[0]), 'utf8'), original);
    const triggers = [];
    await controller.startup(async (trigger) => {
      triggers.push(trigger);
      return controller.perform({ trigger });
    });
    assert.deepEqual(triggers, ['startup']);
    assertNotice(controller, 'success');
  });
});

test('acknowledging success never suppresses a later failure notice that day', async () => {
  await withFixture(async (fixture) => {
    const controller = await createController(optionsFor(fixture));
    await controller.perform({ trigger: 'startup' });
    await controller.acknowledge({ id: assertNotice(controller, 'success').id });
    await controller.reportFailure(new Error('fixture later failure'), 'interval');
    const firstFailure = assertNotice(controller, 'failure');
    await controller.acknowledge({ id: firstFailure.id });
    await controller.reportFailure(new Error('fixture repeated failure'), 'interval');
    assert.notEqual(assertNotice(controller, 'failure').id, firstFailure.id);
  });
});

test('busy backup result is never a success notice and requests retry on restart', async () => {
  await withFixture(async (fixture) => {
    const controller = await createController(optionsFor(fixture, { backup: async () => ({ state: 'busy', stale: false }) }));
    const result = await controller.perform({ trigger: 'startup' });
    assert.equal(result.state, 'busy');
    assert.ok(!controller.getState().notice || controller.getState().notice.kind !== 'success');
    assert.notEqual(controller.getState().lastAttempt.state, 'success');
    const restarted = await createController(optionsFor(fixture));
    const triggers = [];
    await restarted.startup(async (trigger) => { triggers.push(trigger); });
    assert.deepEqual(triggers, ['startup']);
  });
});
