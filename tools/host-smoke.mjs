import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Run with the installed desktop Electron in Node mode, not the global DSH CLI:
// $env:ELECTRON_RUN_AS_NODE='1'
// & 'D:/DeepSeekHarness/DeepSeek Harness.exe' --expose-internals '<this file>'
// Everything written by this smoke test stays below one new OS temporary directory.
assert.ok(process.versions.electron, 'Use the installed DSH desktop Electron with ELECTRON_RUN_AS_NODE=1');
const packageRoot = path.resolve(process.env.DSH_DESKTOP_PACKAGE_ROOT || path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'));
const nativeImport = name => import(pathToFileURL(path.join(packageRoot, name, 'lib', 'index.js')).href);
const { Context, Service } = await nativeImport('cordis');
const { createRuntimeResolution, PluginPackages, evaluatePluginCompatibility } = await nativeImport('dsh-app-boot');
const { createLaunchEnvironmentSnapshot } = await nativeImport('dsh-launch-environment');
const { TypertRegistry } = await nativeImport('dsh-typert-registry');
const { TypertGatewayService } = await nativeImport('dsh-api-gateway');
const { RemoteAccessService } = await nativeImport('dsh-api-remote-access');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chat-backup-host-'));
const sourceRoot = path.join(temporaryRoot, 'source');
const destinationRoot = path.join(temporaryRoot, 'backup');
const sessionLog = path.join(sourceRoot, 'sessions', 'smoke-project', 'smoke-session', 'session.v4.jsonl');
const ctx = new Context();
let pluginFiber;

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${message}`);
}

try {
  const pluginManifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  const runtimeVersion = JSON.parse(await fs.readFile(path.join(packageRoot, 'dsh', 'package.json'), 'utf8')).version;
  assert.equal(evaluatePluginCompatibility(pluginManifest, {}, runtimeVersion), undefined, 'the installed runtime must accept the declared plugin requirements without an exemption');
  await fs.mkdir(path.dirname(sessionLog), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, 'storages'), { recursive: true });
  await fs.writeFile(sessionLog, JSON.stringify({ type: 'session/header', data: { id: 'smoke-session', version: 4 } }) + '\n');
  await fs.writeFile(path.join(sourceRoot, 'storages', 'workspace.json'), JSON.stringify({ smoke: true }));
  const resolution = await createRuntimeResolution({
    installAnchor: path.join(packageRoot, 'dsh', 'package.json'),
    home: sourceRoot,
  });
  // The source checkout is treated like a linked profile package. Its declared
  // DSH peers then resolve from this exact Desktop installation.
  await ctx.plugin(PluginPackages, { resolution: {
    ...resolution,
    linkedRoots: [{ name: 'dsh-chat-backup', realPath: pluginRoot }],
  } }).await();
  await ctx.plugin(TypertRegistry).await();
  await ctx.plugin(RemoteAccessService).await();
  await ctx.plugin(TypertGatewayService).await();
  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'index.js')).href);
  const { listSnapshots, verifySnapshot } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'backup.js')).href);
  const { localDay } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'controller.js')).href);
  const gateway = ctx.get('typertGateway');
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const invoke = (method, args = {}) => gateway.invoke({ namespace: 'dshChatBackup', method, args, peer });
  const getState = () => invoke('getState');
  // A native Service reproduces SettingsForms.configure's exact owner default.
  // This specifically proves ctx.get('settings') preserves the consuming fiber.
  const policies = new Map();
  class SettingsPolicy extends Service {
    constructor(settingsCtx) { super(settingsCtx, 'settings'); }
    configure(presentation, owner = this.ctx.fiber) {
      const uid = owner.uid;
      policies.set(uid, presentation);
      return () => policies.delete(uid);
    }
  }
  await ctx.plugin(SettingsPolicy).await();
  const nativeEnvironment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: sourceRoot } }]);
  ctx.provide('launchEnvironment', nativeEnvironment);
  const readyListeners = new Set();
  let readyCommitted = false;
  ctx.provide('appReady', {
    onReady(listener) {
      if (readyCommitted) { listener(); return () => {}; }
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
  });
  const commitReady = () => {
    readyCommitted = true;
    for (const listener of [...readyListeners]) listener();
    readyListeners.clear();
  };
  let releaseFlush;
  let flushCount = 0;
  let flushAction = async () => {};
  ctx.provide('sessions', {
    async flush(session) {
      assert.equal(session.id, 'smoke-session');
      flushCount++;
      await flushAction();
    },
  });
  const errors = [];
  ctx.logger.exporter({ export(record) { if (record.type === 'warn' || record.type === 'error') errors.push(record.args); } });

  const defaults = plugin.Config['~standard'].validate({});
  assert.equal(defaults.issues, undefined);
  assert.equal(defaults.value.enabled, true);
  assert.equal(defaults.value.intervalMinutes, 5);
  assert.ok(plugin.Config['~standard'].validate({ intervalMinutes: 0 }).issues, 'native schema must reject an invalid interval');
  const invalidFiber = ctx.plugin(plugin, { destinationRoot, intervalMinutes: 0 });
  await assert.rejects(invalidFiber.await(), /invalid config/i);
  await invalidFiber.dispose();
  errors.length = 0; // The rejected configuration above is intentional.

  const setupFiber = ctx.plugin(plugin, { destinationRoot: '', intervalMinutes: 1440, debounceSeconds: 1 });
  await setupFiber.await();
  assert.equal((await getState()).needsSetup, true);
  assert.equal((await getState()).destinationRoot, '');
  assert.deepEqual(policies.get(setupFiber.uid), { auto: false });
  commitReady();
  await delay(50);
  assert.equal((await getState()).notice, null);
  await assert.rejects(fs.access(destinationRoot), error => error.code === 'ENOENT');
  await assert.rejects(fs.access(path.join(path.dirname(sourceRoot), '.dsh-chat-backups')), error => error.code === 'ENOENT');
  await setupFiber.dispose();
  assert.equal(policies.size, 0);
  readyCommitted = false; // A fresh successful-launch signal for the configured mount.

  pluginFiber = ctx.plugin(plugin, { destinationRoot, intervalMinutes: 1440, debounceSeconds: 1 });
  await pluginFiber.await();
  assert.equal(pluginFiber.state, 2, 'native Cordis plugin must be active');
  assert.deepEqual(policies.get(pluginFiber.uid), { auto: false });
  assert.equal(readyListeners.size, 1);
  await delay(30);
  assert.deepEqual(await listSnapshots(destinationRoot), [], 'startup backup must wait for application readiness');
  commitReady();
  await waitFor(async () => (await getState()).notice?.kind === 'success', 'verified startup success notice');
  let snapshots = await listSnapshots(destinationRoot);
  assert.equal(snapshots[0].trigger, 'startup');
  assert.equal((await verifySnapshot(destinationRoot)).valid, true);
  const manifest = JSON.parse(await fs.readFile(path.join(destinationRoot, 'snapshots', snapshots[0].id + '.json'), 'utf8'));
  assert.equal(manifest.sourceRoot.toLowerCase(), sourceRoot.toLowerCase(), 'launch-environment DSH_HOME must select the isolated source');
  const startupNotice = (await getState()).notice;
  assert.equal(await invoke('acknowledge', { id: startupNotice.id }), true);
  assert.equal((await getState()).notice, null);
  const stateFile = path.join(sourceRoot, 'storages', 'dsh-chat-backup.json');
  const persistedAfterShown = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(persistedAfterShown.successShownDate, localDay(new Date()), 'shown-day suppression must be durably saved');

  flushAction = async () => {
    await new Promise(resolve => { releaseFlush = resolve; });
    await fs.appendFile(sessionLog, JSON.stringify({ type: 'turn/end', seq: 0, data: { turn: 1, reason: { kind: 'completed' } } }) + '\n');
  };
  ctx.emit('session/event', { id: 'smoke-session' }, { type: 'turn/end' });
  await waitFor(() => flushCount === 1 && releaseFlush, 'turn-end flush entry');
  await delay(30);
  assert.equal((await listSnapshots(destinationRoot)).length, 1, 'backup must wait for flush completion');
  releaseFlush();
  await waitFor(async () => (await getState()).lastAttempt?.trigger === 'turn/end' && (await getState()).lastAttempt?.state === 'success', 'turn-end snapshot');
  snapshots = await listSnapshots(destinationRoot);
  assert.equal(snapshots[0].trigger, 'turn/end');
  assert.equal((await verifySnapshot(destinationRoot)).valid, true);
  assert.equal((await getState()).notice, null, 'later verified success must be quiet after today was acknowledged');

  releaseFlush = undefined;
  flushAction = () => new Promise(resolve => { releaseFlush = resolve; });
  ctx.emit('session/event', { id: 'smoke-session' }, { type: 'turn/end' });
  await waitFor(() => flushCount === 2 && releaseFlush, 'shutdown drain entry');
  let disposed = false;
  const disposing = pluginFiber.dispose().then(() => { disposed = true; });
  await delay(30);
  assert.equal(disposed, false, 'disposal must wait for an in-flight flush job');
  releaseFlush();
  await disposing;
  assert.equal(disposed, true);
  await delay(1100);
  assert.equal((await listSnapshots(destinationRoot)).length, 2, 'disposal must cancel deferred backup work');
  assert.equal(policies.size, 0, 'custom settings policy is removed with its plugin fiber');
  assert.deepEqual(errors, [], 'unexpected native logger warning or error');

  const reloadedFiber = ctx.plugin(plugin, { destinationRoot, intervalMinutes: 1440, debounceSeconds: 1 });
  await reloadedFiber.await();
  await waitFor(async () => Boolean((await getState()).lastAttempt?.verifiedAt), 'startup verifies an existing successful backup');
  assert.equal((await getState()).notice, null, 'same-day suppression survives a new plugin/controller mount');
  assert.equal((await listSnapshots(destinationRoot)).length, 2, 'successful existing startup verification creates no redundant snapshot');
  assert.equal(await invoke('validateDestination', { destinationRoot }), await fs.realpath(destinationRoot), 'native path validation accepts the existing store for this source');
  await assert.rejects(invoke('validateDestination', { destinationRoot: sourceRoot }), /Source, backup and restore directories/, 'native path validation rejects source overlap');
  const manual = await invoke('backupNow');
  assert.equal(manual.state, 'unchanged', 'manual RPC runs the real controller and detects unchanged content');
  assert.equal(manual.trigger, 'manual');
  assert.equal((await verifySnapshot(destinationRoot)).valid, true);
  assert.equal((await listSnapshots(destinationRoot)).length, 2, 'manual unchanged backup does not publish a redundant snapshot');
  await reloadedFiber.dispose();

  // An overlapping destination must fail without changing any conversation.
  // Every new mount retries and exposes a fresh failure notice, even today.
  const failedFiber = ctx.plugin(plugin, { destinationRoot: sourceRoot, intervalMinutes: 1440, debounceSeconds: 1 });
  await failedFiber.await();
  await waitFor(async () => (await getState()).notice?.kind === 'failure', 'startup failure notice');
  const firstFailureId = (await getState()).notice.id;
  assert.equal(await invoke('acknowledge', { id: firstFailureId }), true);
  await failedFiber.dispose();
  const retryFiber = ctx.plugin(plugin, { destinationRoot: sourceRoot, intervalMinutes: 1440, debounceSeconds: 1 });
  await retryFiber.await();
  await waitFor(async () => (await getState()).notice?.kind === 'failure', 'next startup retries and reminds about failure');
  assert.notEqual((await getState()).notice.id, firstFailureId);
  assert.equal((await getState()).lastAttempt.trigger, 'startup');
  await retryFiber.dispose();
  assert.equal(policies.size, 0);
  for (const args of errors) assert.match(JSON.stringify(args), /Source, backup and restore directories/, 'only the intentionally failed startup backups may warn');
  const runtimePackage = JSON.parse(await fs.readFile(path.join(packageRoot, 'dsh-session', 'package.json'), 'utf8'));
  const cordisPackage = JSON.parse(await fs.readFile(path.join(packageRoot, 'cordis', 'package.json'), 'utf8'));
  console.log(JSON.stringify({ passed: true, runtime: runtimePackage.version, cordis: cordisPackage.version, snapshots: 2, checks: ['native plugin compatibility without exemption', 'native package resolution', 'native Config defaults and rejection', 'launch-environment DSH_HOME', 'first-use path required with no guessed backup directory', 'native Remote getState and acknowledge', 'readiness startup and verified success notice', 'persisted daily success suppression', 'turn-end durability barrier', 'async disposal drain and timer cleanup', 'same-day startup verification', 'native manual backup and destination validation', 'failure retried and reminded each startup', 'ctx.get settings policy fiber ownership and cleanup'] }));
} finally {
  await ctx.fiber.dispose();
  const resolvedRoot = path.resolve(temporaryRoot);
  assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolvedRoot).startsWith('dsh-chat-backup-host-'));
  await fs.rm(resolvedRoot, { recursive: true, force: true });
}
