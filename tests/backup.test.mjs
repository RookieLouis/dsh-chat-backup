import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backup,
  listSnapshots,
  verifySnapshot,
  restoreSnapshot,
} from '../lib/backup.js';

const LOG_PATH = 'sessions/2026/09/30/session.v1.jsonl';
const COMPRESSED_LOG_PATH = 'sessions/2026/09/30/session.v2.jsonl.zstd';
const ATTACHMENT_PATH = 'attachments/conversation/nested/reference.bin';
const WORKSPACE_PATH = 'storages/workspace.json';
const INITIAL_LOG = Buffer.from('{"role":"user","content":"DSH backup fixture"}\n');
const INITIAL_ATTACHMENT = Buffer.from([0, 1, 2, 127, 128, 255]);

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

function localPath(root, relative) {
  return path.join(root, ...relative.split('/'));
}

async function put(root, relative, data) {
  const file = localPath(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function withFixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chat-backup-test-'));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'backup');
  try {
    await put(sourceRoot, LOG_PATH, INITIAL_LOG);
    // These bytes deliberately need not be a valid zstd stream: backup and
    // restore must preserve the source's raw bytes without decoding them.
    await put(sourceRoot, COMPRESSED_LOG_PATH, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 99]));
    await put(sourceRoot, ATTACHMENT_PATH, INITIAL_ATTACHMENT);
    await put(sourceRoot, WORKSPACE_PATH, '{"workspace":"fixture","version":1}\n');
    await put(sourceRoot, 'auth.json', '{"token":"never-back-up-this-root-file"}');
    await put(sourceRoot, 'sessions/credentials.json', '{"token":"excluded"}');
    await put(sourceRoot, 'sessions/session.v1.jsonl.bak', 'excluded backup suffix');
    await put(sourceRoot, 'storages/credentials.json', '{"token":"excluded"}');
    await run({ root, sourceRoot, destinationRoot });
  } finally {
    const resolvedRoot = path.resolve(root);
    const tempParent = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolvedRoot.startsWith(tempParent), 'cleanup must remain inside the temporary directory');
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
}

async function readManifest(destinationRoot, id) {
  return JSON.parse(await fs.readFile(path.join(destinationRoot, 'snapshots', `${id}.json`), 'utf8'));
}

async function writeManifest(destinationRoot, id, manifest) {
  await fs.writeFile(path.join(destinationRoot, 'snapshots', `${id}.json`), `${JSON.stringify(manifest)}\n`);
}

async function snapshotNames(destinationRoot) {
  const names = await fs.readdir(path.join(destinationRoot, 'snapshots'));
  return names.filter((name) => name.endsWith('.json')).sort();
}

async function objectNames(destinationRoot) {
  const base = path.join(destinationRoot, 'objects');
  const names = [];
  for (const prefix of await fs.readdir(base)) {
    for (const name of await fs.readdir(path.join(base, prefix))) names.push(`${prefix}/${name}`);
  }
  return names.sort();
}

function objectPath(destinationRoot, hash) {
  return path.join(destinationRoot, 'objects', hash.slice(0, 2), hash);
}

test('initial backup includes raw session logs, nested attachments and workspace metadata only', async () => {
  await withFixture(async ({ sourceRoot, destinationRoot }) => {
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-initial' });
    assert.equal(result.state, 'success');
    assert.match(result.snapshotId, /^[A-Za-z0-9-]+$/);
    assert.equal(result.files, 4);
    const manifest = await readManifest(destinationRoot, result.snapshotId);
    assert.equal(manifest.schema, 1);
    assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), [
      LOG_PATH, COMPRESSED_LOG_PATH, ATTACHMENT_PATH, WORKSPACE_PATH,
    ].sort());
    let copiedBytes = 0;
    const hashes = new Set();
    for (const entry of manifest.files) {
      const sourceData = await fs.readFile(localPath(sourceRoot, entry.path));
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.equal(entry.sha256, digest(sourceData));
      assert.equal(entry.size, sourceData.length);
      assert.ok(Number.isFinite(entry.mtimeMs));
      assert.deepEqual(await fs.readFile(objectPath(destinationRoot, entry.sha256)), sourceData);
      if (!hashes.has(entry.sha256)) copiedBytes += sourceData.length;
      hashes.add(entry.sha256);
    }
    assert.equal(result.newObjects, hashes.size);
    assert.equal(result.bytesCopied, copiedBytes);
    const verification = await verifySnapshot(destinationRoot);
    assert.equal(verification.valid, true);
    assert.equal(verification.snapshotId, result.snapshotId);
    assert.equal(verification.files, 4);
    assert.equal(verification.bytes, manifest.files.reduce((sum, entry) => sum + entry.size, 0));
    const snapshots = await listSnapshots(destinationRoot);
    assert.ok(Array.isArray(snapshots));
    assert.equal(snapshots.length, 1);
  });
});

test('unchanged backup adds no snapshot or object and identical files share one object', async () => {
  await withFixture(async ({ sourceRoot, destinationRoot }) => {
    await put(sourceRoot, 'attachments/duplicate-log.txt', INITIAL_LOG);
    const initial = await backup({ sourceRoot, destinationRoot, trigger: 'test-dedup' });
    assert.equal(initial.files, 5);
    assert.equal(initial.newObjects, 4);
    const beforeSnapshots = await snapshotNames(destinationRoot);
    const beforeObjects = await objectNames(destinationRoot);
    const beforeManifest = await fs.readFile(path.join(destinationRoot, 'snapshots', `${initial.snapshotId}.json`));
    const unchanged = await backup({ sourceRoot, destinationRoot, trigger: 'test-repeat' });
    assert.equal(unchanged.state, 'unchanged');
    assert.equal(unchanged.newObjects, 0);
    assert.equal(unchanged.bytesCopied, 0);
    assert.deepEqual(await snapshotNames(destinationRoot), beforeSnapshots);
    assert.deepEqual(await objectNames(destinationRoot), beforeObjects);
    assert.deepEqual(await fs.readFile(path.join(destinationRoot, 'snapshots', `${initial.snapshotId}.json`)), beforeManifest);
  });
});

test('changes preserve earlier snapshots and deleted files remain recoverable from an earlier snapshot', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    const initial = await backup({ sourceRoot, destinationRoot, trigger: 'test-old-version' });
    const initialManifestBytes = await fs.readFile(path.join(destinationRoot, 'snapshots', `${initial.snapshotId}.json`));
    const changedLog = Buffer.from('{"role":"assistant","content":"later version"}\n');
    await put(sourceRoot, LOG_PATH, changedLog);
    const changed = await backup({ sourceRoot, destinationRoot, trigger: 'test-changed' });
    assert.equal(changed.state, 'success');
    assert.notEqual(changed.snapshotId, initial.snapshotId);
    assert.equal(changed.newObjects, 1);
    assert.equal(changed.bytesCopied, changedLog.length);
    assert.deepEqual(await fs.readFile(path.join(destinationRoot, 'snapshots', `${initial.snapshotId}.json`)), initialManifestBytes);
    assert.deepEqual(await fs.readFile(objectPath(destinationRoot, digest(INITIAL_LOG))), INITIAL_LOG);
    await fs.unlink(localPath(sourceRoot, ATTACHMENT_PATH));
    const deleted = await backup({ sourceRoot, destinationRoot, trigger: 'test-delete' });
    assert.equal(deleted.state, 'success');
    assert.equal(deleted.files, 3);
    assert.equal(deleted.newObjects, 0);
    assert.equal(deleted.bytesCopied, 0);
    assert.equal((await snapshotNames(destinationRoot)).length, 3);
    assert.equal((await listSnapshots(destinationRoot)).length, 3);
    const latest = await verifySnapshot(destinationRoot, 'latest');
    assert.equal(latest.snapshotId, deleted.snapshotId);

    const oldTarget = path.join(root, 'restored-old');
    await restoreSnapshot({ destinationRoot, snapshotId: initial.snapshotId, targetRoot: oldTarget });
    assert.deepEqual(await fs.readFile(localPath(oldTarget, LOG_PATH)), INITIAL_LOG);
    assert.deepEqual(await fs.readFile(localPath(oldTarget, ATTACHMENT_PATH)), INITIAL_ATTACHMENT);
    assert.deepEqual(await fs.readFile(localPath(oldTarget, COMPRESSED_LOG_PATH)), await fs.readFile(localPath(sourceRoot, COMPRESSED_LOG_PATH)));
    assert.deepEqual(await fs.readFile(localPath(oldTarget, WORKSPACE_PATH)), await fs.readFile(localPath(sourceRoot, WORKSPACE_PATH)));
    assert.equal(await exists(path.join(oldTarget, 'auth.json')), false);
    const latestTarget = path.join(root, 'source-restored-latest');
    await restoreSnapshot({ destinationRoot, targetRoot: latestTarget });
    assert.deepEqual(await fs.readFile(localPath(latestTarget, LOG_PATH)), changedLog);
    assert.equal(await exists(localPath(latestTarget, ATTACHMENT_PATH)), false);
    assert.deepEqual(await fs.readFile(objectPath(destinationRoot, digest(INITIAL_ATTACHMENT))), INITIAL_ATTACHMENT);
  });
});

test('symbolic-link directories and files are excluded from the backup', async (t) => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    const external = path.join(root, 'external');
    await put(external, 'session.v1.jsonl', 'external credential-like data');
    await put(external, 'secret.bin', 'external secret');
    try {
      await fs.symlink(external, path.join(sourceRoot, 'sessions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      await fs.symlink(external, path.join(sourceRoot, 'attachments', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`Directory symlinks unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    try {
      await fs.symlink(path.join(external, 'secret.bin'), path.join(sourceRoot, 'attachments', 'linked-file.bin'), 'file');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.diagnostic(`File symlink unavailable; directory exclusion still tested: ${error.code}`);
    }
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-symlinks' });
    const manifest = await readManifest(destinationRoot, result.snapshotId);
    assert.equal(manifest.files.length, 4);
    assert.ok(manifest.files.every((entry) => !entry.path.includes('linked')));
  });
});

test('a corrupted object fails verification and restore leaves no final output directory', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-corruption' });
    const manifest = await readManifest(destinationRoot, result.snapshotId);
    await fs.writeFile(objectPath(destinationRoot, manifest.files[0].sha256), 'corrupted object bytes');
    await assert.rejects(() => verifySnapshot(destinationRoot, result.snapshotId));
    const targetRoot = path.join(root, 'must-not-appear');
    await assert.rejects(() => restoreSnapshot({ destinationRoot, snapshotId: result.snapshotId, targetRoot }));
    assert.equal(await exists(targetRoot), false);
    assert.deepEqual(await fs.readFile(localPath(sourceRoot, LOG_PATH)), INITIAL_LOG);
  });
});

test('restore rejects an existing target and leaves its contents untouched', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    await backup({ sourceRoot, destinationRoot, trigger: 'test-existing-target' });
    const targetRoot = path.join(root, 'already-here');
    await put(targetRoot, 'keep.txt', 'original data');
    await assert.rejects(() => restoreSnapshot({ destinationRoot, targetRoot }));
    assert.deepEqual(await fs.readdir(targetRoot), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(targetRoot, 'keep.txt'), 'utf8'), 'original data');
  });
});

test('restore rejects source and backup overlaps in either direction', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    await backup({ sourceRoot, destinationRoot, trigger: 'test-overlap' });
    for (const targetRoot of [
      path.join(sourceRoot, 'nested-restore'),
      path.join(destinationRoot, 'nested-restore'),
      sourceRoot,
      destinationRoot,
      root,
    ]) {
      await assert.rejects(() => restoreSnapshot({ destinationRoot, targetRoot }));
    }
    assert.equal(await exists(path.join(sourceRoot, 'nested-restore')), false);
    assert.equal(await exists(path.join(destinationRoot, 'nested-restore')), false);
    assert.deepEqual(await fs.readFile(localPath(sourceRoot, LOG_PATH)), INITIAL_LOG);
    // A sibling sharing the source's text prefix is disjoint and must work.
    const targetRoot = `${sourceRoot}-restored`;
    await restoreSnapshot({ destinationRoot, targetRoot });
    assert.deepEqual(await fs.readFile(localPath(targetRoot, LOG_PATH)), INITIAL_LOG);
  });
});

test('malicious traversal and backslash manifest paths are rejected without writing output', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-path-validation' });
    const original = await readManifest(destinationRoot, result.snapshotId);
    const unsafePaths = ['../escape.txt', '..\\escape.txt', 'attachments\\..\\..\\escape.txt', '/escape.txt', 'C:\\escape.txt'];
    for (let index = 0; index < unsafePaths.length; index += 1) {
      const manifest = structuredClone(original);
      manifest.files[0].path = unsafePaths[index];
      await writeManifest(destinationRoot, result.snapshotId, manifest);
      await assert.rejects(() => verifySnapshot(destinationRoot, result.snapshotId));
      const targetRoot = path.join(root, `malicious-restore-${index}`);
      await assert.rejects(() => restoreSnapshot({ destinationRoot, snapshotId: result.snapshotId, targetRoot }));
      assert.equal(await exists(targetRoot), false);
    }
    assert.equal(await exists(path.join(root, 'escape.txt')), false);
  });
});

test('duplicate manifest paths are rejected by verification and restore', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-duplicate-paths' });
    const manifest = await readManifest(destinationRoot, result.snapshotId);
    manifest.files.push({ ...manifest.files[0] });
    await writeManifest(destinationRoot, result.snapshotId, manifest);
    await assert.rejects(() => verifySnapshot(destinationRoot, result.snapshotId));
    const targetRoot = path.join(root, 'duplicate-restore');
    await assert.rejects(() => restoreSnapshot({ destinationRoot, snapshotId: result.snapshotId, targetRoot }));
    assert.equal(await exists(targetRoot), false);
  });
});

test('a live process lock returns busy and is left untouched', async () => {
  await withFixture(async ({ sourceRoot, destinationRoot }) => {
    await fs.mkdir(destinationRoot, { recursive: true });
    const lockPath = path.join(destinationRoot, '.backup.lock');
    const lock = JSON.stringify({ pid: process.pid, token: 'fixture-active-lock', createdAt: new Date().toISOString() });
    await fs.writeFile(lockPath, lock);
    const result = await backup({ sourceRoot, destinationRoot, trigger: 'test-busy' });
    assert.equal(result.state, 'busy');
    assert.equal(await fs.readFile(lockPath, 'utf8'), lock);
    assert.equal(await exists(path.join(destinationRoot, 'snapshots')), false);
  });
});

test('missing, non-directory and session-less sources are rejected', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    await assert.rejects(() => backup({ sourceRoot: path.join(root, 'missing'), destinationRoot }));
    await assert.rejects(() => backup({ sourceRoot: path.join(sourceRoot, 'auth.json'), destinationRoot }));
    const emptySource = path.join(root, 'no-sessions');
    await fs.mkdir(emptySource);
    await assert.rejects(() => backup({ sourceRoot: emptySource, destinationRoot }));
    assert.deepEqual(await fs.readFile(localPath(sourceRoot, LOG_PATH)), INITIAL_LOG);
  });
});

test('snapshot IDs cannot escape the snapshot directory', async () => {
  await withFixture(async ({ root, sourceRoot, destinationRoot }) => {
    await backup({ sourceRoot, destinationRoot, trigger: 'test-id-validation' });
    for (const snapshotId of ['../outside', '..\\outside', 'foo/bar', 'foo\\bar', '']) {
      await assert.rejects(() => verifySnapshot(destinationRoot, snapshotId));
      const targetRoot = path.join(root, 'invalid-id-restore');
      await assert.rejects(() => restoreSnapshot({ destinationRoot, snapshotId, targetRoot }));
      assert.equal(await exists(targetRoot), false);
    }
  });
});
