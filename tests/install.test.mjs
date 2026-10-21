import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Windows PowerShell installer preserves UTF-8 Chinese paths, backs up originals and is idempotent', { skip: process.platform !== 'win32' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-install-test-'));
  const profile = path.join(temp, '中文目录', 'profile');
  const destination = path.join(temp, '备份');
  const backups = path.join(temp, 'config-backups');
  const bin = path.join(temp, 'bin');
  const installer = fileURLToPath(new URL('../tools/install.ps1', import.meta.url));
  try {
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(bin);
    // Isolate package-manager side effects; test the real PS5.1 configuration edits.
    await fs.writeFile(path.join(bin, 'pnpm.cmd'), '@exit /b 0\r\n');
    const original = JSON.stringify({
      name: 'fixture', private: true,
      dependencies: { 'other-plugin': 'link:D:/示例目录/测试插件', 'dsh-aura': 'link:D:/Example/Plugins/dsh-aura' },
      dsh: { profile: { bundles: ['other-plugin'] } },
      unrelated: { label: '保留中文配置', nested: ['a', 'b'] },
    }, null, 2);
    const originalPatch = '# 中文注释\n- id: other-plugin\n  name: other-plugin\n';
    await fs.writeFile(path.join(profile, 'package.json'), original);
    await fs.writeFile(path.join(profile, 'cordis.patch.yml'), originalPatch);
    await fs.writeFile(path.join(profile, 'pnpm-lock.yaml'), 'test-lock\n');
    const run = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
      '-Profile', profile, '-Destination', destination, '-ConfigBackupRoot', backups], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, encoding: 'utf8', windowsHide: true,
    });
    run();
    const packageAfter = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
    assert.deepEqual(packageAfter.dependencies, JSON.parse(original).dependencies);
    assert.deepEqual(packageAfter.unrelated, JSON.parse(original).unrelated);
    assert.deepEqual(packageAfter.dsh.profile.bundles, ['other-plugin', 'dsh-chat-backup']);
    const patchAfter = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
    assert.ok(patchAfter.startsWith(originalPatch.trimEnd()));
    assert.equal(JSON.parse(patchAfter.match(/destinationRoot: (.+)/)[1]), destination);
    const first = (await fs.readdir(backups))[0];
    assert.equal(await fs.readFile(path.join(backups, first, 'package.json'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(backups, first, 'cordis.patch.yml'), 'utf8'), originalPatch);
    run();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8')), packageAfter);
    assert.equal(await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), patchAfter);
    assert.equal((await fs.readdir(backups)).length, 2);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('first installation leaves directory unset for the DSH chooser and needs no F drive', { skip: process.platform !== 'win32' }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-first-install-'));
  const profile = path.join(temp, 'profile');
  const bin = path.join(temp, 'bin');
  try {
    await fs.mkdir(profile); await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'pnpm.cmd'), '@exit /b 0\r\n');
    await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: {}, dsh: { profile: { bundles: ['base'] } } }));
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../tools/install.ps1', import.meta.url)), '-Profile', profile, '-ConfigBackupRoot', path.join(temp, 'originals')], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, encoding: 'utf8', windowsHide: true,
    });
    const patch = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
    assert.equal(JSON.parse(patch.match(/destinationRoot: (.+)/)[1]), '');
    assert.doesNotMatch(patch, /F:[\\/]/);
    assert.match(output, /Choose.*inside DSH/i);
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temp, { recursive: true, force: true });
  }
});
