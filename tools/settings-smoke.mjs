import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Use the installed DSH Electron with ELECTRON_RUN_AS_NODE=1. This runs the
// native Loader, Config schema, SettingsForms, Remote gateway and real backups.
// Only the profile editor's disk target is isolated below one temporary folder.
assert.ok(process.versions.electron, 'Run with installed DSH Electron and ELECTRON_RUN_AS_NODE=1');
const packageRoot = path.resolve(process.env.DSH_DESKTOP_PACKAGE_ROOT || path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'));
const nativeImport = name => import(pathToFileURL(path.join(packageRoot, name, 'lib', 'index.js')).href);
const { Context, Service } = await nativeImport('cordis');
const { EntryTree, Loader } = await nativeImport('cordis-plugin-loader');
const { createRuntimeResolution, PluginPackages } = await nativeImport('dsh-app-boot');
const { SettingsForms, SettingsConflictError } = await nativeImport('dsh-settings');
const { createLaunchEnvironmentSnapshot } = await nativeImport('dsh-launch-environment');
const { TypertRegistry } = await nativeImport('dsh-typert-registry');
const { TypertGatewayService } = await nativeImport('dsh-api-gateway');
const { RemoteAccessService } = await nativeImport('dsh-api-remote-access');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chat-backup-settings-'));
const sourceRoot = path.join(temporaryRoot, 'source');
const firstRoot = path.join(temporaryRoot, 'first-backup');
const secondRoot = path.join(temporaryRoot, 'second-backup');
const documentPath = path.join(temporaryRoot, 'profile-patch.json');
const ctx = new Context();
let entry;
let writes = 0;
const errors = [];

class TemporaryConfigEditor extends Service {
  constructor(editorCtx) { super(editorCtx, 'configEditor'); }
  get documentPath() { return documentPath; }
  entries() { return entry ? [entry] : []; }
  configuration() { return entry ? [{ entry, inherited: {}, override: entry.options.config }] : []; }
  async edit(target, change) {
    assert.equal(target, entry);
    const next = change(structuredClone(entry.options.config), {});
    const checked = entry.fiber.runtime.Config['~standard'].validate(next);
    assert.equal(checked.issues, undefined, 'Native schema must validate a settings write');
    await entry.update({ config: structuredClone(next) });
    await entry.fiber.await();
    await fs.writeFile(documentPath, JSON.stringify({ [entry.options.id]: next }, null, 2));
    writes++;
  }
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  await fs.mkdir(path.join(sourceRoot, 'sessions', 'settings-smoke'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'sessions', 'settings-smoke', 'session.v4.jsonl'), JSON.stringify({ type: 'session/header', data: { id: 'settings-smoke', version: 4 } }) + '\n');
  const resolution = await createRuntimeResolution({ installAnchor: path.join(packageRoot, 'dsh', 'package.json'), home: sourceRoot });
  await ctx.plugin(PluginPackages, { resolution: {
    ...resolution, linkedRoots: [{ name: 'dsh-chat-backup', realPath: pluginRoot }],
  } }).await();
  ctx.provide('profileContext', { home: sourceRoot, name: 'backup-settings-smoke' });
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: sourceRoot } }]));
  ctx.provide('sessions', { async flush() {} });
  ctx.provide('appReady', { onReady(listener) { listener(); return () => {}; } });
  await ctx.plugin(Loader).await();
  await ctx.plugin(TemporaryConfigEditor).await();
  await ctx.plugin(SettingsForms).await();
  await ctx.plugin(TypertRegistry).await();
  await ctx.plugin(RemoteAccessService).await();
  await ctx.plugin(TypertGatewayService).await();
  ctx.logger.exporter({ export(record) { if (record.type === 'warn' || record.type === 'error') errors.push(record.args); } });

  const plugin = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'index.js')).href);
  const { listSnapshots, verifySnapshot } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'backup.js')).href);
  const parsed = plugin.Config['~standard'].validate({});
  assert.equal(parsed.issues, undefined);
  assert.equal(parsed.value.destinationRoot.get(), '');
  assert.equal(parsed.value.successNoticeFrequency.get(), 'daily');
  assert.equal(parsed.value.noticeDurationSeconds.get(), 3);
  for (const value of [0, 61, 1.5]) assert.ok(plugin.Config['~standard'].validate({ noticeDurationSeconds: value }).issues);
  assert.ok(plugin.Config['~standard'].validate({ successNoticeFrequency: 'invalid' }).issues);

  class TemporaryEntryTree extends EntryTree { write() {} }
  const tree = new TemporaryEntryTree(ctx);
  tree.ctx.baseUrl = pathToFileURL(path.join(pluginRoot, 'package.json')).href;
  await tree.root.update([{ id: plugin.name, name: plugin.name, config: { intervalMinutes: 1440, debounceSeconds: 1 } }]);
  entry = tree.resolve(plugin.name);
  assert.ok(entry?.fiber);
  await entry.fiber.await();
  const fiber = entry.fiber;
  assert.equal(fiber.state, 2);
  const reference = fiber.config.destinationRoot;
  const settings = ctx.get('settings');
  let descriptor = settings.describe().find(row => row.ns === plugin.name);
  assert.ok(descriptor, 'Native SettingsForms must expose the backup namespace; missing volatile fields made it unavailable before this fix');
  assert.deepEqual(descriptor.value, { destinationRoot: '', successNoticeFrequency: 'daily', noticeDurationSeconds: 3 });
  assert.equal(descriptor.autoGenerate, false);
  assert.deepEqual(settings.presentations.get(fiber), { auto: false });
  const gateway = ctx.get('typertGateway');
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const invoke = (method, args = {}) => gateway.invoke({ namespace: 'dshChatBackup', method, args, peer });
  const getState = () => invoke('getState');
  assert.equal((await getState()).needsSetup, true);

  await settings.mutate(plugin.name, [
    { op: 'set', path: ['destinationRoot'], value: firstRoot },
    { op: 'set', path: ['successNoticeFrequency'], value: 'always' },
    { op: 'set', path: ['noticeDurationSeconds'], value: 5 },
  ], descriptor.revision);
  await waitFor(async () => (await getState()).destinationRoot === firstRoot && (await getState()).notice?.kind === 'success', 'accepted destination starts a verified real backup');
  assert.equal(entry.fiber, fiber, 'Settings writes must keep the owning fiber active');
  assert.equal(fiber.config.destinationRoot, reference, 'Native volatile update must retain its reference');
  assert.equal(reference.get(), firstRoot);
  assert.equal((await getState()).successNoticeFrequency, 'always');
  assert.equal((await getState()).noticeDurationSeconds, 5);
  assert.equal((await verifySnapshot(firstRoot)).valid, true);
  const firstSnapshots = await listSnapshots(firstRoot);
  assert.equal(firstSnapshots.length, 1);
  const firstNotice = (await getState()).notice;
  assert.equal(await invoke('acknowledge', { id: firstNotice.id }), true);
  assert.equal((await invoke('backupNow')).state, 'unchanged');
  assert.equal((await getState()).notice?.kind, 'success', 'Always frequency must apply to a real subsequent backup');
  descriptor = settings.describe().find(row => row.ns === plugin.name);
  const document = JSON.parse(await fs.readFile(documentPath, 'utf8'))[plugin.name];
  assert.equal(document.destinationRoot, firstRoot);
  assert.equal(document.successNoticeFrequency, 'always');
  assert.equal(document.noticeDurationSeconds, 5);

  await assert.rejects(settings.mutate(plugin.name, [{ op: 'set', path: ['noticeDurationSeconds'], value: 8 }], descriptor.revision - 1), error => error instanceof SettingsConflictError);
  await settings.mutate(plugin.name, [
    { op: 'set', path: ['destinationRoot'], value: secondRoot },
    { op: 'set', path: ['successNoticeFrequency'], value: 'never' },
    { op: 'set', path: ['noticeDurationSeconds'], value: 2 },
  ], descriptor.revision);
  await waitFor(async () => (await getState()).destinationRoot === secondRoot && (await getState()).lastAttempt?.state === 'success', 'changing destination creates a complete backup at its new location');
  assert.equal((await verifySnapshot(secondRoot)).valid, true);
  assert.equal((await verifySnapshot(firstRoot)).valid, true, 'Changing destination must preserve the old backup');
  assert.equal((await listSnapshots(firstRoot)).length, firstSnapshots.length);
  assert.equal((await getState()).successNoticeFrequency, 'never');
  assert.equal((await getState()).noticeDurationSeconds, 2);
  assert.equal((await getState()).notice, null, 'Never frequency must suppress the actual success notice');
  assert.equal(entry.fiber, fiber);
  descriptor = settings.describe().find(row => row.ns === plugin.name);
  await settings.mutate(plugin.name, [{ op: 'unset', path: ['destinationRoot'] }], descriptor.revision);
  await waitFor(async () => (await getState()).needsSetup === true, 'unsetting destination disables backup until configured');
  assert.equal((await invoke('backupNow')).state, 'unconfigured');
  assert.equal(writes, 3);
  await fiber.dispose();
  assert.equal(settings.presentations.size, 0, 'Custom page policy must be removed on disposal');
  assert.equal(settings.describe().find(row => row.ns === plugin.name), undefined);
  assert.deepEqual(errors, [], 'No native warning or error');
  console.log(JSON.stringify({ passed: true, electron: process.versions.electron, writes, checks: [
    'real SettingsForms namespace projection and writable fields', 'native volatile defaults and invalid values',
    'reference-preserving EntryTree configuration writes', 'isolated profile disk persistence and stale revision refusal',
    'live notification settings used by real backup outcomes', 'live destination change with old backups preserved',
    'real Remote gateway survives destination replacements', 'unset destination and complete fiber cleanup',
  ] }));
} finally {
  await ctx.fiber.dispose();
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('dsh-chat-backup-settings-'));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
