import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_REMOTE_CONTRIBUTION, createBackupController, createBackupClient, installNoticeAutoDismiss } from '../src/client.js';

const ok = value => ({ ok: true, value });
function fixture(initial = {}) {
  let host = { enabled: true, destinationRoot: '', needsSetup: true, notice: null, ...initial };
  let formState = { status: 'ready', writable: true, mode: 'file', value: { destinationRoot: host.destinationRoot } };
  const calls = { saves: [], backups: 0, acknowledgments: [], intervals: new Set(), listeners: new Set() };
  const remote = {
    getState: async () => ok(host),
    validateDestination: async value => ok(value.replaceAll('/', '\\')),
    acknowledge: async id => { calls.acknowledgments.push(id); host = { ...host, notice: null }; return ok(true); },
    backupNow: async () => { calls.backups++; return ok({ state: 'success' }); },
  };
  const form = {
    getSnapshot: () => formState,
    subscribe: fn => { calls.listeners.add(fn); return () => calls.listeners.delete(fn); },
    set: async (field, value) => { calls.saves.push([field, value]); formState = { ...formState, value: { ...formState.value, [field]: value } }; return true; },
  };
  const timers = { setInterval: fn => { calls.intervals.add(fn); return fn; }, clearInterval: fn => calls.intervals.delete(fn) };
  const controller = createBackupController({ remote, form, timers, pickDirectory: async () => null });
  return { controller, calls, remote, form, timers, setHost: value => { host = { ...host, ...value }; },
    setForm: value => { formState = { ...formState, ...value }; for (const listener of calls.listeners) listener(); } };
}

test('first use opens setup without selecting or backing up; dismissal stays quiet during this app session', async () => {
  const f = fixture();
  try {
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().setupOpen, true);
    assert.equal(await f.controller.pickDirectory(), null);
    assert.deepEqual(f.calls.saves, []);
    assert.equal(f.calls.backups, 0);
    f.controller.dismissSetup();
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().setupOpen, false);
    f.controller.openSetup();
    assert.equal(f.controller.getSnapshot().setupOpen, true);
  } finally { f.controller.dispose(); }
});
test('disabled backup suppresses automatic setup/notices and manual attempts', async () => {
  const f = fixture({ enabled: false, notice: { id: 'disabled', kind: 'failure' } });
  try {
    await f.controller.refresh(); await f.controller.backupNow();
    assert.equal(f.controller.getSnapshot().setupOpen, false);
    assert.equal(f.controller.getSnapshot().visibleNotice, null);
    assert.equal(f.calls.backups, 0);
  } finally { f.controller.dispose(); }
});
test('directory save validates and persists the canonical root, then waits for the new host scope', async () => {
  const f = fixture();
  try {
    await f.controller.refresh();
    assert.equal(await f.controller.saveDestination(' E:/备份 '), true);
    assert.deepEqual(f.calls.saves, [['destinationRoot', 'E:\\备份']]);
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().reloadPending, true);
    f.setHost({ destinationRoot: 'E:\\备份', needsSetup: false });
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().reloadPending, false);
    assert.equal(f.controller.getSnapshot().setupOpen, false);
  } finally { f.controller.dispose(); }
});
test('empty, invalid or read-only destinations never save configuration', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.controller.saveDestination(' '));
    f.remote.validateDestination = async () => ({ ok: false, error: { message: 'Invalid path' } });
    await assert.rejects(f.controller.saveDestination('E:/source'), /Invalid path/);
    f.setForm({ writable: false });
    await assert.rejects(f.controller.saveDestination('E:/backup'));
    assert.deepEqual(f.calls.saves, []);
  } finally { f.controller.dispose(); }
});
test('fetching notices does not acknowledge them; visible notice is acknowledged once and can be replaced by failure', async () => {
  const f = fixture({ destinationRoot: 'E:/backup', needsSetup: false, notice: { id: 'success1', kind: 'success' } });
  try {
    await f.controller.refresh();
    assert.deepEqual(f.calls.acknowledgments, []);
    await f.controller.noticeVisible('success1'); await f.controller.noticeVisible('success1');
    assert.deepEqual(f.calls.acknowledgments, ['success1']);
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().visibleNotice.id, 'success1');
    f.setHost({ notice: { id: 'failure1', kind: 'failure' }, lastAttempt: { state: 'failed' } });
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().visibleNotice.id, 'failure1');
    f.setHost({ notice: null, lastAttempt: { state: 'unchanged' } });
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().visibleNotice, null);
  } finally { f.controller.dispose(); }
});
test('manual failed RPC outcome remains actionable even when the following refresh succeeds', async () => {
  const f = fixture({ destinationRoot: 'E:/backup', needsSetup: false });
  try {
    await f.controller.refresh();
    f.remote.backupNow = async () => ok({ state: 'failed', error: 'Disk is full' });
    await f.controller.backupNow();
    assert.equal(f.controller.getSnapshot().operationError, 'Disk is full');
    assert.equal(f.controller.getSnapshot().running, false);
  } finally { f.controller.dispose(); }
});
test('disposal removes polling and the configuration subscription', async () => {
  const f = fixture();
  f.controller.start();
  assert.equal(f.calls.intervals.size, 1);
  assert.equal(f.calls.listeners.size, 1);
  f.controller.dispose();
  assert.equal(f.calls.intervals.size, 0);
  assert.equal(f.calls.listeners.size, 0);
});

test('notification edits validate and preserve the backup path', async () => {
  const f = fixture({ destinationRoot: 'E:/backup', needsSetup: false });
  try {
    await f.controller.refresh();
    assert.equal(await f.controller.saveNotificationSettings({ successNoticeFrequency: 'always', noticeDurationSeconds: 8 }), true);
    assert.equal(f.controller.getSnapshot().form.value.destinationRoot, 'E:/backup');
    assert.deepEqual(f.calls.saves, [['noticeDurationSeconds', 8], ['successNoticeFrequency', 'always']]);
    await assert.rejects(f.controller.saveNotificationSettings({ successNoticeFrequency: 'weekly', noticeDurationSeconds: 8 }));
    await assert.rejects(f.controller.saveNotificationSettings({ successNoticeFrequency: 'daily', noticeDurationSeconds: 0 }));
    await assert.rejects(f.controller.saveNotificationSettings({ successNoticeFrequency: 'daily', noticeDurationSeconds: 3.5 }));
    f.setForm({ writable: false });
    await assert.rejects(f.controller.saveNotificationSettings({ successNoticeFrequency: 'daily', noticeDurationSeconds: 3 }));
    assert.equal(f.calls.saves.length, 2);
  } finally { f.controller.dispose(); }
});

test('auto-dismiss waits until visible, uses configured duration, and cleans timers', () => {
  const timers = new Map();
  const listeners = new Set();
  const calls = [];
  const globals = {
    document: { visibilityState: 'hidden', addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) },
    setTimeout: (fn, delay) => { timers.set(fn, delay); return fn; }, clearTimeout: fn => timers.delete(fn),
  };
  const controller = { noticeVisible: id => calls.push(['visible', id]), dismissNotice: id => calls.push(['dismiss', id]) };
  const cleanup = installNoticeAutoDismiss({ controller, notice: { id: 'one' }, durationSeconds: 3, globals });
  assert.equal(timers.size, 0);
  globals.document.visibilityState = 'visible';
  for (const listener of listeners) listener();
  assert.deepEqual(calls, [['visible', 'one']]);
  assert.equal([...timers.values()][0], 3000);
  globals.document.visibilityState = 'hidden';
  for (const listener of listeners) listener();
  assert.equal(timers.size, 0);
  globals.document.visibilityState = 'visible';
  for (const listener of listeners) listener();
  for (const timer of timers.keys()) timer();
  assert.deepEqual(calls.at(-1), ['dismiss', 'one']);
  cleanup();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test('a previous toast timer cannot hide a newer failure', async () => {
  const f = fixture({ destinationRoot: 'E:/backup', needsSetup: false, notice: { id: 'old', kind: 'success' } });
  try {
    await f.controller.refresh();
    f.setHost({ notice: { id: 'new', kind: 'failure' } });
    await f.controller.refresh();
    f.controller.dismissNotice('old');
    assert.equal(f.controller.getSnapshot().visibleNotice.id, 'new');
    f.controller.dismissNotice('new');
    assert.equal(f.controller.getSnapshot().visibleNotice, null);
  } finally { f.controller.dispose(); }
});

test('muting success does not shorten an acknowledged failure during polling', async () => {
  const f = fixture({ destinationRoot: 'E:/backup', needsSetup: false, successNoticeFrequency: 'never',
    lastAttempt: { state: 'failed' }, notice: { id: 'failure', kind: 'failure' } });
  try {
    await f.controller.refresh();
    await f.controller.noticeVisible('failure');
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().visibleNotice.id, 'failure');
  } finally { f.controller.dispose(); }
});
test('native contribution has strict input codecs and client registers both app overlay and plugin page', async () => {
  const stringCodec = BACKUP_REMOTE_CONTRIBUTION.descriptors.find(d => d.method === 'acknowledge').parameters[0].codec;
  assert.equal(stringCodec.mode, 'strict');
  assert.equal(stringCodec.create().parse('notice-id'), 'notice-id');
  assert.throws(() => stringCodec.create().parse(42));
  const f = fixture();
  const registrations = [];
  const effects = [];
  let unmounted = false;
  const React = { createElement: () => null };
  const plugin = createBackupClient(React, { Modal() {}, Button() {} }, f.timers);
  const ctx = {
    remote: { $mount: async contribution => { assert.equal(contribution, BACKUP_REMOTE_CONTRIBUTION); return () => { unmounted = true; }; } },
    get: name => { assert.equal(name, 'remote.dshChatBackup'); return f.remote; },
    configForms: { get: name => { assert.equal(name, 'dsh-chat-backup'); return f.form; } },
    uiWorkspace: { pickDirectory: async () => null },
    effect: setup => effects.push(setup()),
    slots: { inject: (name, setup) => effects.push(setup()), register: (slot, component) => { registrations.push({ slot, component }); return () => {}; } },
  };
  const remove = await plugin.apply(ctx);
  assert.deepEqual(registrations.map(r => r.slot.name), ['plugins.bundle.config', 'shell.overlay']);
  assert.equal(registrations[0].slot.key, 'dsh-chat-backup');
  for (const cleanup of effects.reverse()) await cleanup?.();
  await remove();
  assert.equal(unmounted, true);
  assert.equal(f.calls.intervals.size, 0);
  f.controller.dispose();
});
