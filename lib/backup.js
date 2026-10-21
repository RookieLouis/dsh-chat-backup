import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const FORMAT = 'dsh-chat-backup';
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const LOG = /^session\.v\d+\.jsonl(?:\.zstd)?$/;
const normalize = p => process.platform === 'win32' ? p.toLowerCase() : p;
const inside = (a, b) => normalize(a) === normalize(b) || normalize(b).startsWith(normalize(a + path.sep));

async function exists(p) {
  try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// Resolve existing ancestors too, so a junction cannot bypass overlap checks.
async function canonical(p) {
  p = path.resolve(p);
  try { return await fs.realpath(p); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const parent = path.dirname(p);
    if (parent === p) throw e;
    return path.join(await canonical(parent), path.basename(p));
  }
}
function disjoint(a, b) {
  if (inside(a, b) || inside(b, a)) throw new Error('Source, backup and restore directories must not contain each other');
}
export async function validateDestination(sourceRoot, destinationRoot) {
  if (typeof destinationRoot !== 'string' || !destinationRoot.trim() || !path.isAbsolute(destinationRoot)) {
    throw new Error('请选择或输入绝对路径。');
  }
  const source = await canonical(sourceRoot);
  const root = await canonical(destinationRoot.trim());
  disjoint(source, root);
  await fs.access(path.parse(root).root);
  const existing = await exists(root);
  if (existing) {
    await plainDirectory(root);
    const marker = path.join(root, 'format.json');
    if (await exists(marker)) {
      const saved = await json(marker);
      if (saved.format !== FORMAT || saved.schema !== 1 || normalize(saved.sourceRoot) !== normalize(source)) {
        throw new Error('这个目录已有其他 DSH 数据源的备份，请选择一个新目录。');
      }
    }
  }
  return root;
}
async function plainDirectory(p) {
  const s = await fs.lstat(p);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`Not a regular directory: ${p}`);
}
async function json(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }
async function atomicJson(p, data) {
  const temp = `${p}.partial-${randomUUID()}`;
  try {
    const f = await fs.open(temp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(data, null, 2) + '\n'); await f.sync(); } finally { await f.close(); }
    await fs.rename(temp, p);
  } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function digest(p) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(p)) { size += chunk.length; hash.update(chunk); }
  return { sha256: hash.digest('hex'), size };
}
function selected(p) {
  const parts = p.split('/');
  return (parts[0] === 'sessions' && parts.length >= 4 && LOG.test(parts.at(-1))) ||
    (parts[0] === 'attachments' && parts.length >= 2) || p === 'storages/workspace.json';
}
function safeRelative(p) {
  if (typeof p !== 'string' || !p || p.includes('\\') || p.includes(':') || p.includes('\0') ||
      p.split('/').some(v => !v || v === '.' || v === '..' || /[. ]$/.test(v) || /[<>"|?*\x00-\x1f]/.test(v) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)) || !selected(p)) {
    throw new Error(`Unsafe or unsupported manifest path: ${p}`);
  }
  return p;
}
async function scan(sourceRoot) {
  await plainDirectory(path.join(sourceRoot, 'sessions'));
  const found = [];
  const visit = async (relative) => {
    const p = path.join(sourceRoot, relative);
    const s = await fs.lstat(p);
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const item of (await fs.readdir(p)).sort()) await visit(`${relative}/${item}`);
    } else if (s.isFile() && selected(relative)) { safeRelative(relative); found.push(relative); }
    else if (!s.isFile()) throw new Error(`Unsupported source entry: ${relative}`);
  };
  await visit('sessions');
  if (await exists(path.join(sourceRoot, 'attachments'))) await visit('attachments');
  const storage = await exists(path.join(sourceRoot, 'storages'));
  if (storage && !storage.isSymbolicLink()) {
    await plainDirectory(path.join(sourceRoot, 'storages'));
    if (await exists(path.join(sourceRoot, 'storages/workspace.json'))) await visit('storages/workspace.json');
  }
  return found.sort();
}
function objectPath(root, hash) {
  if (!HASH.test(hash)) throw new Error('Invalid object hash');
  return path.join(root, 'objects', hash.slice(0, 2), hash);
}
async function checkObject(root, entry) {
  const p = objectPath(root, entry.sha256);
  await plainDirectory(path.dirname(p));
  const s = await fs.lstat(p);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Invalid backup object: ${entry.sha256}`);
  const actual = await digest(p);
  if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) throw new Error(`Backup object checksum mismatch: ${entry.sha256}`);
}
async function capture(sourceRoot, relative, root) {
  const p = path.join(sourceRoot, relative);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fs.lstat(p);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Source changed type: ${relative}`);
    const temp = path.join(root, 'tmp', `${randomUUID()}.partial`);
    try {
      const hash = createHash('sha256');
      let size = 0;
      const hashing = new Transform({ transform(chunk, encoding, cb) { size += chunk.length; hash.update(chunk); cb(null, chunk); } });
      await pipeline(createReadStream(p), hashing, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const sha256 = hash.digest('hex');
      const after = await fs.lstat(p);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          before.ino !== after.ino || size !== after.size) continue;
      // Re-read the source: catch concurrent edits that preserved size or timestamps.
      const sourceDigest = await digest(p);
      const final = await fs.lstat(p);
      if (sourceDigest.sha256 !== sha256 || final.size !== after.size || final.mtimeMs !== after.mtimeMs || final.ctimeMs !== after.ctimeMs) continue;
      const entry = { path: relative, sha256, size, mtimeMs: after.mtimeMs };
      const target = objectPath(root, sha256);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await plainDirectory(path.dirname(target));
      let added = false;
      if (await exists(target)) { await checkObject(root, entry); }
      else {
        const f = await fs.open(temp, 'r+');
        try { await f.sync(); } finally { await f.close(); }
        const stored = await digest(temp);
        if (stored.sha256 !== sha256 || stored.size !== size) throw new Error('Temporary backup checksum mismatch');
        // link() publishes without ever replacing an existing immutable object.
        await fs.link(temp, target);
        added = true;
      }
      return { entry, added };
    } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  throw new Error(`File is still being written; retry on next backup: ${relative}`);
}
async function initialize(root, sourceRoot) {
  // An unavailable Windows drive must fail, never fall back to another disk.
  await fs.access(path.parse(root).root);
  await fs.mkdir(root, { recursive: true });
  await plainDirectory(root);
  for (const name of ['objects', 'snapshots', 'tmp']) {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await plainDirectory(path.join(root, name));
  }
  const p = path.join(root, 'format.json');
  if (await exists(p)) {
    const saved = await json(p);
    if (saved.format !== FORMAT || saved.schema !== 1 || normalize(saved.sourceRoot) !== normalize(sourceRoot)) {
      throw new Error('Backup store format or DSH home does not match');
    }
  } else await atomicJson(p, { format: FORMAT, schema: 1, sourceRoot });
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
async function acquire(root, retries = 0) {
  const p = path.join(root, '.backup.lock');
  const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  let f;
  try { f = await fs.open(p, 'wx', 0o600); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held; try { held = await json(p); } catch { /* may be initializing */ }
    const stale = held ? !processAlive(held.pid) : false;
    if (!stale || !Number.isSafeInteger(held.pid) || held.pid <= 0 || typeof held.token !== 'string' || !ID.test(held.token) || retries >= 3) return { busy: true, stale };
    // Only one contender may reclaim this particular dead owner's lock.
    // Recheck its token under that barrier before unlinking; never unlink a new owner's lock.
    const recoveryPath = path.join(root, `.recover-${held.token}.lock`);
    let recovery;
    try { recovery = await fs.open(recoveryPath, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') return { busy: true, stale: true };
      throw error;
    }
    try {
      await recovery.writeFile(JSON.stringify(owner));
      await recovery.sync();
      let current; try { current = await json(p); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current?.token === held.token && current.pid === held.pid && !processAlive(current.pid)) await fs.unlink(p);
    } finally { await recovery.close(); await fs.unlink(recoveryPath); }
    return acquire(root, retries + 1);
  }
  try { await f.writeFile(JSON.stringify(owner)); await f.sync(); } finally { await f.close(); }
  return { release: async () => {
    if ((await json(p)).token !== owner.token) throw new Error('Backup lock ownership changed');
    await fs.unlink(p);
  } };
}
function validateManifest(manifest, id) {
  if (manifest.schema !== 1 || manifest.format !== FORMAT || manifest.id !== id || !Array.isArray(manifest.files) ||
      typeof manifest.sourceRoot !== 'string' || !path.isAbsolute(manifest.sourceRoot)) throw new Error('Invalid snapshot manifest');
  const seen = new Set();
  const hashes = new Map();
  for (const e of manifest.files) {
    safeRelative(e.path);
    if (!HASH.test(e.sha256) || !Number.isSafeInteger(e.size) || e.size < 0 || !Number.isFinite(e.mtimeMs) || e.mtimeMs < 0) throw new Error('Invalid snapshot entry');
    const key = normalize(e.path);
    if (seen.has(key)) throw new Error('Duplicate snapshot path');
    seen.add(key);
    if (hashes.has(e.sha256) && hashes.get(e.sha256) !== e.size) throw new Error('Inconsistent object size');
    hashes.set(e.sha256, e.size);
  }
  for (const p of seen) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('Snapshot file/directory path collision');
    }
  }
  return manifest;
}
export async function listSnapshots(destinationRoot) {
  const root = await canonical(destinationRoot);
  const dir = path.join(root, 'snapshots');
  if (!await exists(dir)) return [];
  await plainDirectory(dir);
  const list = [];
  for (const name of (await fs.readdir(dir)).sort().reverse()) {
    if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
    const id = name.slice(0, -5);
    const manifest = await readManifest(root, id);
    list.push({ id, createdAt: manifest.createdAt, files: manifest.files.length, bytes: manifest.files.reduce((n, e) => n + e.size, 0), trigger: manifest.trigger });
  }
  return list;
}
async function readManifest(root, id) {
  if (id === 'latest') {
    const names = (await fs.readdir(path.join(root, 'snapshots'))).filter(n => n.endsWith('.json') && ID.test(n.slice(0, -5))).sort();
    if (!names.length) throw new Error('No snapshots found');
    id = names.at(-1).slice(0, -5);
  }
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid snapshot ID');
  await plainDirectory(path.join(root, 'snapshots'));
  const p = path.join(root, 'snapshots', `${id}.json`);
  const s = await fs.lstat(p);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Invalid manifest file');
  return validateManifest(await json(p), id);
}
export async function verifySnapshot(destinationRoot, snapshotId = 'latest') {
  const root = await canonical(destinationRoot);
  await plainDirectory(path.join(root, 'objects'));
  const manifest = await readManifest(root, snapshotId);
  const seen = new Set();
  for (const e of manifest.files) {
    if (!seen.has(e.sha256)) { await checkObject(root, e); seen.add(e.sha256); }
  }
  return { snapshotId: manifest.id, sourceRoot: manifest.sourceRoot, valid: true, files: manifest.files.length, bytes: manifest.files.reduce((n, e) => n + e.size, 0) };
}
export async function backup({ sourceRoot, destinationRoot, trigger = 'manual' }) {
  sourceRoot = await canonical(sourceRoot);
  const root = await canonical(destinationRoot);
  disjoint(sourceRoot, root);
  await plainDirectory(sourceRoot);
  await plainDirectory(path.join(sourceRoot, 'sessions'));
  await fs.access(path.parse(root).root);
  await fs.mkdir(root, { recursive: true });
  await plainDirectory(root);
  const lock = await acquire(root);
  if (lock.busy) return { state: 'busy', stale: lock.stale };
  const startedAt = new Date().toISOString();
  try {
    await initialize(root, sourceRoot);
    const paths = await scan(sourceRoot);
    const files = [];
    let newObjects = 0, bytesCopied = 0;
    for (const relative of paths) {
      const { entry, added } = await capture(sourceRoot, relative, root);
      files.push(entry);
      if (added) { newObjects++; bytesCopied += entry.size; }
    }
    // Do not publish an inventory silently omitting an entry removed during the scan.
    if (JSON.stringify(paths) !== JSON.stringify(await scan(sourceRoot))) throw new Error('Source inventory changed; retry on next backup');
    const snapshots = await listSnapshots(root);
    const previous = snapshots.length ? await readManifest(root, snapshots[0].id) : null;
    const same = previous && JSON.stringify(files.map(({ path, sha256, size }) => ({ path, sha256, size }))) ===
      JSON.stringify(previous.files.map(({ path, sha256, size }) => ({ path, sha256, size })));
    let snapshotId = previous?.id;
    if (!same) {
      snapshotId = new Date().toISOString().replace(/[^0-9TZ]/g, '') + '-' + randomUUID();
      const manifest = { schema: 1, format: FORMAT, id: snapshotId, createdAt: new Date().toISOString(), sourceRoot, trigger, files };
      await atomicJson(path.join(root, 'snapshots', `${snapshotId}.json`), manifest);
    }
    const result = { state: same ? 'unchanged' : 'success', snapshotId, files: files.length, newObjects, bytesCopied, startedAt, finishedAt: new Date().toISOString(), trigger };
    await atomicJson(path.join(root, 'last-status.json'), result);
    await fs.appendFile(path.join(root, 'backup-runs.jsonl'), JSON.stringify(result) + '\n', { mode: 0o600 });
    return result;
  } catch (e) {
    const failed = { state: 'failed', startedAt, finishedAt: new Date().toISOString(), trigger, error: e.message };
    // Never overwrite prior status without first preserving it in the run log.
    await fs.appendFile(path.join(root, 'backup-runs.jsonl'), JSON.stringify(failed) + '\n', { mode: 0o600 }).catch(() => {});
    await atomicJson(path.join(root, 'last-status.json'), failed).catch(() => {});
    throw e;
  } finally { await lock.release(); }
}
export async function restoreSnapshot({ destinationRoot, snapshotId = 'latest', targetRoot }) {
  const root = await canonical(destinationRoot);
  const target = await canonical(targetRoot);
  const manifest = await readManifest(root, snapshotId);
  disjoint(root, target);
  disjoint(await canonical(manifest.sourceRoot), target);
  if (await exists(target)) throw new Error('Restore target already exists; choose a new directory');
  await verifySnapshot(root, manifest.id);
  // mkdir(target) atomically claims an absent directory. Existing data is never overwritten.
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(target);
  try {
    for (const e of manifest.files) {
      const p = path.join(target, ...e.path.split('/'));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.copyFile(objectPath(root, e.sha256), p, 1 /* COPYFILE_EXCL */);
      const actual = await digest(p);
      if (actual.sha256 !== e.sha256 || actual.size !== e.size) throw new Error(`Restored file checksum mismatch: ${e.path}`);
      await fs.utimes(p, new Date(), new Date(e.mtimeMs));
    }
    await atomicJson(path.join(target, 'RESTORE-COMPLETE.json'), { snapshotId: manifest.id, files: manifest.files.length, restoredAt: new Date().toISOString() });
    return { targetRoot: target, snapshotId: manifest.id, files: manifest.files.length };
  } catch (e) {
    // Leave partial output identifiable for inspection; it cannot be mistaken for complete.
    await atomicJson(path.join(target, 'RESTORE-FAILED.json'), { error: e.message, snapshotId: manifest.id }).catch(() => {});
    throw e;
  }
}
