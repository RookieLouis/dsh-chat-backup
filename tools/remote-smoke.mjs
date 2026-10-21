import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Native Host dispatch and the exact Desktop browser Gateway are exercised
// through an in-process carrier. This starts no server and writes no user data.
assert.ok(process.versions.electron, 'Run with the DSH Desktop Electron in Node mode');
const packageRoot = path.resolve(process.env.DSH_DESKTOP_PACKAGE_ROOT || path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'));
const nativeImport = name => import(pathToFileURL(path.join(packageRoot, name, 'lib', 'index.js')).href);
const cordis = await nativeImport('cordis');
const { Context } = cordis;
const { createRuntimeResolution, PluginPackages } = await nativeImport('dsh-app-boot');
const { TypertRegistry } = await nativeImport('dsh-typert-registry');
const { TypertGatewayService } = await nativeImport('dsh-api-gateway');
const { RemoteAccessService } = await nativeImport('dsh-api-remote-access');
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = new Context();
const client = new Context();
const sourceRoot = path.join(os.tmpdir(), 'dsh-chat-backup-remote-source');
const destinationRoot = path.join(os.tmpdir(), 'dsh-chat-backup-remote-backup');
let removeContribution;

try {
  const resolution = await createRuntimeResolution({ installAnchor: path.join(packageRoot, 'dsh', 'package.json'), home: sourceRoot });
  await host.plugin(PluginPackages, { resolution: { ...resolution, linkedRoots: [{ name: 'dsh-chat-backup', realPath: pluginRoot }] } }).await();
  const { installRemote } = await import(pathToFileURL(path.join(pluginRoot, 'lib', 'remote.js')).href);
  await host.plugin(TypertRegistry).await();
  await host.plugin(RemoteAccessService).await();
  await host.plugin(TypertGatewayService).await();
  const acknowledgments = [];
  const triggers = [];
  let state = { enabled: true, destinationRoot, notice: { id: 'notice-smoke', kind: 'success' } };
  const remoteFiber = installRemote(host, {
    sourceRoot,
    controller: {
      getState: () => state,
      acknowledge: async request => { acknowledgments.push(request); state = { ...state, notice: null }; return state; },
    },
    lifecycle: { start: async trigger => { triggers.push(trigger); return { state: 'success', trigger }; } },
    validateDestination: async (source, destination) => { assert.equal(source, sourceRoot); assert.equal(destination, destinationRoot); return destinationRoot; },
  });
  await remoteFiber.await();
  const gateway = host.get('typertGateway');
  const peer = { principal: { kind: 'owner' }, signal: new AbortController().signal };
  const direct = (method, args = {}) => gateway.invoke({ namespace: 'dshChatBackup', method, args, peer });
  assert.equal((await direct('getState')).notice.id, 'notice-smoke');
  assert.equal(await direct('validateDestination', { destinationRoot }), destinationRoot);
  await assert.rejects(direct('validateDestination', { destinationRoot: 123 }), /backup destination/i);
  await assert.rejects(direct('acknowledge', { wrongField: 'notice-smoke' }), /id|argument|field/i);
  assert.deepEqual(await direct('backupNow'), { state: 'success', trigger: 'manual' });

  // Evaluate the installed browser Gateway's own ModuleLoader factory. Its only
  // external runtime dependency is native Cordis; the Connection is a local seam.
  let browserGateway;
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { browserGateway = definition.factory(name => {
      assert.equal(name, '@deepseek-ai/cordis');
      return cordis;
    }); } } },
    console,
    AbortController,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    performance,
  };
  const gatewayManifest = JSON.parse(readFileSync(path.join(packageRoot, 'dsh-api-gateway', 'package.json'), 'utf8'));
  const clientExport = gatewayManifest.exports['./client'];
  const browserEntry = typeof clientExport === 'string' ? clientExport : clientExport.browser || clientExport.default;
  vm.runInNewContext(readFileSync(path.join(packageRoot, 'dsh-api-gateway', browserEntry), 'utf8'), sandbox, { filename: 'native-dsh-api-gateway-client.js' });
  assert.ok(browserGateway);
  await client.plugin(TypertRegistry).await();
  client.provide('connection', {
    isLoopback: true,
    generation: { getSnapshot: () => ({ host: { home: 'isolated' } }), subscribe: () => () => {} },
    registerGenerationSource: () => () => {},
    start: () => ({ stop() {} }),
    rpc: {
      open: () => (async function* () {})(),
      async call(base, endpoint, payload, signal) {
        assert.equal(base, '/api');
        const [namespace, method] = endpoint.split('/');
        try { return { ok: true, value: await gateway.invoke({ namespace, method, args: payload.args, signal, peer }) }; }
        catch (error) { return { ok: false, error: { code: error.code || 'gateway/internal', message: error.message, details: {} } }; }
      },
    },
  });
  await client.plugin(browserGateway).await();
  const { BACKUP_REMOTE_CONTRIBUTION } = await import(pathToFileURL(path.join(pluginRoot, 'src', 'client.js')).href);
  removeContribution = await client.remote.$mount(BACKUP_REMOTE_CONTRIBUTION);
  const remote = client.get('remote.dshChatBackup');
  assert.ok(remote, 'namespace is available when native $mount resolves');
  const before = await remote.getState();
  assert.equal(before.ok, true);
  assert.equal(before.value.notice.id, 'notice-smoke');
  const validated = await remote.validateDestination(destinationRoot);
  assert.equal(validated.ok, true);
  assert.equal(validated.value, destinationRoot);
  const acknowledged = await remote.acknowledge('notice-smoke');
  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.value.notice, null);
  assert.deepEqual(acknowledgments, [{ id: 'notice-smoke' }]);
  const backedUp = await remote.backupNow();
  assert.equal(backedUp.ok, true);
  assert.equal(backedUp.value.trigger, 'manual');
  assert.deepEqual(triggers, ['manual', 'manual']);
  await removeContribution();
  removeContribution = undefined;
  assert.equal(client.get('remote.dshChatBackup'), undefined, 'native namespace is withdrawn with its contribution');
  await remoteFiber.dispose();
  await assert.rejects(direct('getState'), /unavailable|active|exports/i);
  const runtime = JSON.parse(readFileSync(path.join(packageRoot, 'dsh-api-gateway', 'package.json'), 'utf8')).version;
  console.log(JSON.stringify({ passed: true, runtime, methods: ['getState', 'acknowledge', 'backupNow', 'validateDestination'], checks: ['native source decorators', 'native Host Gateway named arguments', 'native browser $mount strict input descriptors', 'in-process client calls and result envelopes', 'service and namespace cleanup'] }));
} finally {
  await removeContribution?.();
  await client.fiber.dispose();
  await host.fiber.dispose();
}
