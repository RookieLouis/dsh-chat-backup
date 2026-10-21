import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// Read-only semantic validation of a restored DSH home using the installed
// Desktop format catalog. No persistence handle, migration or output file opens.
// Run via Electron --expose-internals with ELECTRON_RUN_AS_NODE=1.
assert.ok(process.versions.electron, 'Use the installed DSH Desktop Electron in Node mode');
assert.ok(process.argv[2], 'Usage: validate-history.mjs <restored-DSH-home>');
const sourceRoot = path.resolve(process.argv[2]);
const sessionsRoot = path.join(sourceRoot, 'sessions');
assert.ok(lstatSync(sessionsRoot).isDirectory(), 'The restored home must contain a sessions directory');
const packageRoot = path.resolve(process.env.DSH_DESKTOP_PACKAGE_ROOT || path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'));
const catalogRoot = path.join(packageRoot, 'dsh-session-format-catalog');
const { sessionFormatCatalog, historicalSessionFormatCatalog, createSessionFormatCatalogWithChildren } = await import(pathToFileURL(path.join(catalogRoot, 'lib', 'index.js')).href);
const { historicalChildCatalogSource } = await import(pathToFileURL(path.join(packageRoot, 'dsh-session-format-v3-to-v4', 'lib', 'index.js')).href);
const { version } = JSON.parse(readFileSync(path.join(catalogRoot, 'package.json'), 'utf8'));
const result = { runtime: version, files: 0, passed: 0, events: 0, catalogPrerequisiteFailures: 0, errorCount: 0, errors: [] };

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.isFile() && /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(entry.name)) yield file;
  }
}

function readRows(file) {
  const raw = readFileSync(file);
  let bytes = raw;
  if (file.endsWith('.zstd')) {
    const chunks = [];
    let offset = 0;
    while (offset < raw.length) {
      const decoded = zstdDecompressSync(raw.subarray(offset), { info: true, maxOutputLength: 512 * 1024 * 1024 });
      const consumed = decoded.engine.bytesWritten;
      if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > raw.length - offset) throw new Error('Zstd decoder returned an invalid consumed-byte count');
      offset += consumed;
      chunks.push(decoded.buffer);
    }
    bytes = Buffer.concat(chunks);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rows = text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
  if (rows.length === 0) throw new Error('Empty session artifact');
  return rows;
}

function decodeRows(rows, catalog) {
  const restore = catalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' });
  for (let index = 1; index < rows.length; index++) restore.decodeRow(rows[index]);
  return restore.finish();
}

function diagnostic(error) {
  // Parse errors can quote bytes from a conversation. Report the category only
  // in that case; other diagnostics are bounded and strip quoted values.
  if (error instanceof SyntaxError) return 'SyntaxError: invalid JSON in a session artifact';
  const message = String(error.message ?? error).split('\n')[0].replace(/"[^"\n]*"|'[^'\n]*'/g, '[quoted value]').slice(0, 240);
  return `${error.name || 'Error'}: ${message}`;
}

const files = [...walk(sessionsRoot)];
const headers = new Map();
const selectedChildren = new Map();
const factsByParent = new Map();
// Match the native persistence migration prerequisite: discover direct children
// in the complete restored corpus, selecting the newest stored generation of
// each child. Retain only headers and compact facts between passes.
for (const file of files) {
  try {
    const rows = readRows(file);
    const inspected = sessionFormatCatalog.readHeader(rows[0]);
    if (inspected.status !== 'current' && inspected.status !== 'migration-required') throw new Error('Unsupported or malformed session header');
    const record = { file, header: inspected.header, version: inspected.storedVersion };
    headers.set(file, record);
    if (record.header.origin === 'subagent' && record.header.parentSession !== undefined) {
      const previous = selectedChildren.get(record.header.id);
      if (!previous || record.version > previous.version) selectedChildren.set(record.header.id, record);
    }
  } catch { /* The final pass reports every physical artifact failure once. */ }
}
for (const child of selectedChildren.values()) {
  const facts = factsByParent.get(child.header.parentSession) ?? [];
  try {
    const artifact = decodeRows(readRows(child.file), child.version <= 3 ? historicalSessionFormatCatalog : sessionFormatCatalog);
    facts.push(historicalChildCatalogSource(artifact));
  } catch {
    result.catalogPrerequisiteFailures++;
    // The native migration retains unavailable descriptors explicitly. The
    // failed child's physical validation still fails this run in the final pass.
    facts.push({ childId: child.header.id, childCreatedAt: child.header.createdAt, descriptorCount: 0, descriptor: null });
  }
  factsByParent.set(child.header.parentSession, facts);
}
for (const file of files) {
  result.files++;
  try {
    const record = headers.get(file);
    if (!record) throw new Error('Unsupported or malformed session artifact');
    const catalog = record.version < sessionFormatCatalog.currentVersion
      ? createSessionFormatCatalogWithChildren(factsByParent.get(record.header.id) ?? [])
      : sessionFormatCatalog;
    result.events += decodeRows(readRows(file), catalog).events.length;
    result.passed++;
  } catch (error) {
    result.errorCount++;
    if (result.errors.length < 6) result.errors.push({ file: path.relative(sourceRoot, file).replaceAll('\\', '/'), message: diagnostic(error) });
  }
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.errorCount || result.catalogPrerequisiteFailures ? 1 : 0;
