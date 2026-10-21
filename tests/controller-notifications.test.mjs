import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createController } from '../lib/controller.js';

const TODAY = new Date(2026, 9, 20, 12);
const successful = state => ({ state, snapshotId: 'verified-fixture', files: 7, finishedAt: TODAY.toISOString() });

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-notice-controller-'));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'backup');
  const statePath = path.join(sourceRoot, 'storages', 'dsh-chat-backup.json');
  const controllers = [];
  const create = async (options = {}) => {
    const controller = await createController({
      sourceRoot, destinationRoot, now: () => new Date(TODAY),
      backup: async () => successful('success'), verifySnapshot: async () => ({ valid: true, sourceRoot: await fs.realpath(sourceRoot) }),
      readStatus: async () => successful('success'), ...options,
    });
    controllers.push(controller);
    return controller;
  };
  try {
    await fs.mkdir(sourceRoot);
    await run({ create, statePath });
  } finally {
    for (const controller of controllers) await controller.dispose();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-notice-controller-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('default daily notice is not consumed until visible and keeps its ID across pending checks', async () => {
  await withFixture(async ({ create, statePath }) => {
    const controller = await create();
    assert.equal(controller.getState().successNoticeFrequency, 'daily');
    assert.equal(controller.getState().noticeDurationSeconds, 3);
    await controller.perform({ trigger: 'startup' });
    const notice = controller.getState().notice;
    await controller.perform({ trigger: 'interval' });
    assert.equal(controller.getState().notice.id, notice.id, 'a still pending daily notice must not restart the toast');
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).successShownDate, null);
    await controller.dispose();
    const restartedBeforeVisible = await create();
    await restartedBeforeVisible.startup(() => assert.fail('valid existing backup should verify'));
    const restartedNotice = restartedBeforeVisible.getState().notice;
    assert.equal(restartedNotice.kind, 'success', 'an unshown notice remains eligible after restart');
    await restartedBeforeVisible.acknowledge({ id: restartedNotice.id });
    const restartedAfterVisible = await create();
    await restartedAfterVisible.startup(() => assert.fail('valid existing backup should verify'));
    assert.equal(restartedAfterVisible.getState().notice, null, 'daily frequency is durably enforced after visibility');
  });
});

test('startup frequency persists visibility across controller remounts in one host launch', async () => {
  await withFixture(async ({ create, statePath }) => {
    const controller = await create({ successNoticeFrequency: 'startup', launchId: 'launch-one' });
    await controller.perform({ trigger: 'startup' });
    const notice = controller.getState().notice;
    assert.match(notice.message, /本次启动/);
    await controller.acknowledge({ id: notice.id });
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).successShownLaunchId, 'launch-one');
    const remounted = await create({ successNoticeFrequency: 'startup', launchId: 'launch-one' });
    await remounted.perform({ trigger: 'interval' });
    assert.equal(remounted.getState().notice, null);
    const nextLaunch = await create({ successNoticeFrequency: 'startup', launchId: 'launch-two' });
    await nextLaunch.startup(() => assert.fail('valid existing backup should verify'));
    assert.equal(nextLaunch.getState().notice.kind, 'success', 'a real new host launch is eligible again on the same day');
  });
});

test('always frequency announces every successful check, including unchanged results', async () => {
  await withFixture(async ({ create }) => {
    const controller = await create({ successNoticeFrequency: 'always', backup: async () => successful('unchanged') });
    await controller.perform({ trigger: 'startup' });
    const first = controller.getState().notice;
    assert.doesNotMatch(first.message, /不再重复/);
    await controller.acknowledge({ id: first.id });
    await controller.perform({ trigger: 'manual' });
    const second = controller.getState().notice;
    assert.equal(second.kind, 'success');
    assert.notEqual(second.id, first.id);
  });
});

test('never frequency keeps success quiet while failures remain visible and recovery clears them', async () => {
  await withFixture(async ({ create }) => {
    const controller = await create({ successNoticeFrequency: 'never' });
    await controller.perform({ trigger: 'startup' });
    assert.equal(controller.getState().notice, null);
    await controller.reportFailure(new Error('fixture destination unavailable'), 'interval');
    assert.equal(controller.getState().notice.kind, 'failure');
    await controller.perform({ trigger: 'manual' });
    assert.equal(controller.getState().notice, null);
    await controller.reportFailure(new Error('fixture destination still unavailable'), 'interval');
    assert.equal(controller.getState().notice.kind, 'failure');
  });
});

test('notification settings change in place and can hide a queued success without consuming it', async () => {
  await withFixture(async ({ create, statePath }) => {
    const controller = await create();
    await controller.perform({ trigger: 'startup' });
    const pendingId = controller.getState().notice.id;
    assert.deepEqual(controller.updateNotificationSettings({ noticeDurationSeconds: 12 }), {
      successNoticeFrequency: 'daily', noticeDurationSeconds: 12,
    });
    assert.equal(controller.getState().notice.id, pendingId);
    controller.updateNotificationSettings({ successNoticeFrequency: 'never' });
    assert.equal(controller.getState().notice, null);
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).successShownDate, null);
    controller.updateNotificationSettings({ successNoticeFrequency: 'startup' });
    await controller.perform({ trigger: 'manual' });
    assert.equal(controller.getState().notice.kind, 'success');
    assert.match(controller.getState().notice.message, /本次启动/);
    assert.equal(controller.getState().noticeDurationSeconds, 12);
    assert.equal(controller.getState().lastAttempt.trigger, 'manual');
  });
});

test('invalid live settings are rejected atomically and unrelated fields cannot override state', async () => {
  await withFixture(async ({ create }) => {
    const controller = await create();
    for (const noticeDurationSeconds of [0, 61, NaN, '3', null]) {
      assert.throws(() => controller.updateNotificationSettings({ successNoticeFrequency: 'always', noticeDurationSeconds }), /duration/i);
      assert.equal(controller.getState().successNoticeFrequency, 'daily');
      assert.equal(controller.getState().noticeDurationSeconds, 3);
    }
    assert.throws(() => controller.updateNotificationSettings({ successNoticeFrequency: 'hourly' }), /frequency/i);
    const destinationRoot = controller.getState().destinationRoot;
    controller.updateNotificationSettings({ destinationRoot: 'unexpected' });
    assert.equal(controller.getState().destinationRoot, destinationRoot);
  });
});
