import path from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs/promises';
import { backup, listSnapshots, verifySnapshot, restoreSnapshot } from '../lib/backup.js';

const [command, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!['--source', '--destination', '--snapshot', '--target'].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--')) {
    throw new Error(`Unknown or incomplete argument: ${rest[i]}`);
  }
  args[rest[i].slice(2)] = rest[i + 1];
}
const sourceRoot = args.source || process.env.DSH_HOME || path.join(homedir(), '.dsh');
let destinationRoot = args.destination || process.env.DSH_BACKUP_DIR;
if (!destinationRoot) {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(sourceRoot, 'storages', 'dsh-chat-backup.json'), 'utf8'));
    destinationRoot = Object.hasOwn(saved, 'destinationRoot') ? saved.destinationRoot : saved.lastAttempt?.destinationRoot;
  } catch { /* explicit destination is required until first app backup */ }
}
try {
  if (!destinationRoot) throw new Error('请先在 DSH 插件页面选择保存路径，或使用 --destination 指定目录。');
  let result;
  if (command === 'backup') result = await backup({ sourceRoot, destinationRoot, trigger: 'manual' });
  else if (command === 'list') result = await listSnapshots(destinationRoot);
  else if (command === 'verify') result = await verifySnapshot(destinationRoot, args.snapshot || 'latest');
  else if (command === 'restore' && args.target) result = await restoreSnapshot({ destinationRoot, snapshotId: args.snapshot || 'latest', targetRoot: args.target });
  else throw new Error('Usage: node tools/cli.mjs backup|list|verify|restore [--source DSH_HOME] [--destination DIR] [--snapshot ID] [--target NEW_DIR]');
  console.log(JSON.stringify(result, null, 2));
  if (result?.state === 'busy') process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: 'failed', error: error.message }));
  process.exitCode = 1;
}
