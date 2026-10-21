import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Isolated UI acceptance against the installed Desktop's React and controls.
// Run with Node and an available Playwright/Chrome. No user profile is opened,
// no DSH process is restarted, and RPC/config/picker calls use explicit seams.
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopExecutable = process.env.DSH_DESKTOP_EXECUTABLE || 'D:/DeepSeekHarness/DeepSeek Harness.exe';

if (process.argv[2] === '--extract') {
  assert.ok(process.versions.electron, 'Extraction requires Desktop Electron in Node mode');
  const output = path.resolve(process.argv[3]);
  const packageRoot = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules');
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'package.json'), 'utf8'));
  for (const dependency of manifest.dsh.client.inject) {
    const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, dependency, 'package.json'), 'utf8'));
    assert.ok(metadata.dsh?.client, `Missing native client module: ${dependency}`);
  }
  const assets = path.join(packageRoot, '@deepseek-ai/dsh-web-frontend/dist/assets');
  // Electron's ASAR wrapper can read files but cannot cp an archive directory.
  const extractDirectory = async (source, destination) => {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      const input = path.join(source, entry.name);
      const target = path.join(destination, entry.name);
      if (entry.isDirectory()) await extractDirectory(input, target);
      else if (entry.isFile()) await fs.writeFile(target, await fs.readFile(input));
    }
  };
  await extractDirectory(assets, output);
  await fs.writeFile(path.join(output, 'native-theme.js'), await fs.readFile(path.join(packageRoot, '@deepseek-ai/dsh-client-ui-theme/lib/client.js')));
  const name = (await fs.readdir(output)).find(name => /^index-.*\.js$/.test(name));
  const original = await fs.readFile(path.join(output, name), 'utf8');
  const marker = original.search(/\bconst [\w$]+=globalThis\.dshDesktopBoot\b/);
  assert.ok(marker > 0, 'Native web bootstrap changed; review the extraction seam');
  const staticFactory = original.match(/function ([\w$]+)\(\)\{return\{react:[^{}]*?"@deepseek-ai\/dsh-client-ui-primitives"[^{}]*?\}\}/);
  assert.ok(staticFactory, 'Native static module factory changed; review the extraction seam');
  // Keep the shipped static libraries, remove only the application boot entry.
  await fs.writeFile(path.join(output, 'smoke-native.js'), original.slice(0, marker) + `\nglobalThis.__NATIVE_STATIC_MODULES__ = ${staticFactory[1]}();\n`);
  console.log(JSON.stringify({ extracted: true, nativeClientDependencies: manifest.dsh.client.inject.length }));
} else {
  const { chromium } = await import('playwright');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-chat-backup-ui-'));
  const assetRoot = path.join(temporaryRoot, 'assets');
  let browser;
  try {
    const extraction = spawnSync(desktopExecutable, ['--expose-internals', fileURLToPath(import.meta.url), '--extract', assetRoot], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(extraction.status, 0, (extraction.stderr || extraction.stdout || String(extraction.error)).slice(-1800));
    const files = await fs.readdir(assetRoot);
    const css = files.filter(name => name.endsWith('.css'));
    browser = await chromium.launch({ channel: process.env.DSH_UI_SMOKE_BROWSER || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 780 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'dsh-backup.test') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">${css.map(name => `<link rel="stylesheet" href="/assets/${name}">`).join('')}</head><body><main id="root" style="max-width:720px;margin:32px auto;padding:24px"></main><script type="module" src="/assets/smoke-native.js"></script></body></html>` });
      if (url.pathname === '/client.js') return route.fulfill({ contentType: 'application/javascript', body: await fs.readFile(path.join(pluginRoot, 'lib/client.js'), 'utf8') });
      const target = path.resolve(assetRoot, '.' + decodeURIComponent(url.pathname).replace(/^\/assets/, ''));
      if (!target.startsWith(assetRoot + path.sep)) return route.abort();
      try {
        const contentType = target.endsWith('.js') ? 'application/javascript' : target.endsWith('.css') ? 'text/css' : undefined;
        await route.fulfill({ body: await fs.readFile(target), contentType });
      } catch { await route.abort(); }
    });
    await page.goto('http://dsh-backup.test/');
    await page.waitForFunction(() => !!globalThis.__NATIVE_STATIC_MODULES__);
    await page.evaluate(() => {
      const modules = globalThis.__NATIVE_STATIC_MODULES__;
      globalThis.__ModuleLoader__ = { load(definition) {
        const exported = definition.factory(name => {
          if (!(name in modules)) throw new Error(`Missing native static module: ${name}`);
          return modules[name];
        });
        if (definition.id === 'dsh-chat-backup') globalThis.__BACKUP_PLUGIN__ = exported;
        else if (definition.id === '@deepseek-ai/dsh-client-ui-theme') globalThis.__NATIVE_THEME__ = exported;
        else throw new Error('Unexpected module');
      } };
    });
    await page.addScriptTag({ url: 'http://dsh-backup.test/assets/native-theme.js' });
    await page.addScriptTag({ url: 'http://dsh-backup.test/client.js' });
    await page.evaluate(async () => {
      const modules = globalThis.__NATIVE_STATIC_MODULES__;
      const React = modules.react;
      const formListeners = new Set();
      const effects = [];
      const slots = [];
      globalThis.__NATIVE_THEME__.apply({
        effect: setup => effects.push(setup()),
        provide() {}, on() {}, emit() {}, inject() {},
        locale: { register: () => () => {} },
        configForms: { get: () => ({
          getSnapshot: () => ({ value: {
            preference: 'light', fontSize: 14, codeFontSize: 14, terminalFontSize: 14,
            textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
          } }),
          subscribe: () => () => {}, set: async () => true,
        }) },
        slots: { inject() {}, register() {} },
      });
      const fixture = {
        host: { enabled: true, destinationRoot: '', needsSetup: true, running: false, lastAttempt: null, notice: null,
          successNoticeFrequency: 'daily', noticeDurationSeconds: 3 },
        form: { status: 'ready', writable: true, revision: 'fixture-1',
          value: { destinationRoot: '', successNoticeFrequency: 'daily', noticeDurationSeconds: 3 } },
        picked: null, saves: [], acknowledgments: [], backups: 0, destinationSaves: 0,
      };
      const ok = value => ({ ok: true, value: structuredClone(value) });
      const remote = {
        getState: async () => ok(fixture.host),
        validateDestination: async value => ok(value.replaceAll('/', '\\')),
        acknowledge: async id => { fixture.acknowledgments.push(id); fixture.host.notice = null; return ok(fixture.host); },
        backupNow: async () => {
          fixture.backups++;
          fixture.host.lastAttempt = { state: 'unchanged', files: 3, finishedAt: new Date().toISOString() };
          fixture.host.notice = null;
          return ok({ state: 'unchanged' });
        },
      };
      const form = {
        getSnapshot: () => fixture.form,
        subscribe: fn => { formListeners.add(fn); return () => formListeners.delete(fn); },
        set: async (field, value) => {
          fixture.saves.push([field, value]);
          fixture.form = { ...fixture.form, value: { ...fixture.form.value, [field]: value } };
          for (const fn of formListeners) fn();
          fixture.host = { ...fixture.host, [field]: value };
          if (field === 'destinationRoot') {
            fixture.destinationSaves++;
            fixture.host = { ...fixture.host, needsSetup: false,
              lastAttempt: { state: 'success', files: 3, finishedAt: new Date().toISOString() },
              notice: { id: `success-${fixture.destinationSaves}`, kind: 'success', title: 'DSH 对话备份成功', message: '已校验并保存 3 个文件。' } };
          }
          return true;
        },
      };
      const ctx = {
        remote: { $mount: async () => () => {} },
        get: name => { if (name !== 'remote.dshChatBackup') throw new Error(name); return remote; },
        configForms: { get: name => { if (name !== 'dsh-chat-backup') throw new Error(name); return form; } },
        uiWorkspace: { pickDirectory: async () => fixture.picked },
        effect: setup => effects.push(setup()),
        slots: {
          inject: (name, setup) => effects.push(setup()),
          register: (slot, component) => { slots.push({ slot, component }); return () => {}; },
        },
      };
      await globalThis.__BACKUP_PLUGIN__.apply(ctx);
      const settings = slots.find(row => row.slot.name === 'plugins.bundle.config');
      const overlay = slots.find(row => row.slot.name === 'shell.overlay');
      fixture.controller = settings.slot.inject().controller;
      const root = modules['react-dom/client'].createRoot(document.getElementById('root'));
      fixture.render = showSettings => root.render(React.createElement(React.Fragment, null,
        showSettings ? React.createElement(settings.component, { controller: fixture.controller, view: 'detail' }) : null,
        React.createElement(overlay.component, { controller: fixture.controller })));
      fixture.stop = () => { root.unmount(); for (const cleanup of effects.reverse()) cleanup?.(); };
      fixture.render(false);
      globalThis.__BACKUP_FIXTURE__ = fixture;
    });
    const dialog = page.getByRole('dialog');
    await dialog.getByText('设置 DSH 对话备份', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '选择文件夹', exact: true }).click();
    assert.equal(await page.evaluate(() => __BACKUP_FIXTURE__.saves.length), 0);
    assert.equal(await dialog.getByRole('textbox').inputValue(), '');
    const capture = async name => {
      if (!process.env.DSH_UI_SMOKE_OUTPUT) return;
      const output = path.resolve(process.env.DSH_UI_SMOKE_OUTPUT);
      await fs.mkdir(output, { recursive: true });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await dialog.count()) await page.waitForFunction(() => {
        for (let element = document.querySelector('[role="dialog"]'); element && element !== document.body; element = element.parentElement) {
          if (Number(getComputedStyle(element).opacity) < 0.99) return false;
        }
        return true;
      }, undefined, { timeout: 5000 });
      await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
    };
    await capture('first-install');
    await page.evaluate(() => { __BACKUP_FIXTURE__.picked = 'E:/DSH备份'; });
    await dialog.getByRole('button', { name: '选择文件夹', exact: true }).click();
    assert.equal(await dialog.getByRole('textbox').inputValue(), 'E:/DSH备份');
    await dialog.getByRole('button', { name: '保存并启用备份', exact: true }).click();
    const toast = page.locator('[data-dsh-backup-toast]');
    await toast.getByText('DSH 对话备份成功', { exact: true }).waitFor();
    const firstShownAt = Date.now();
    assert.equal(await dialog.count(), 0, 'Success must not open a modal dialog');
    assert.equal(await toast.getAttribute('role'), 'status');
    const bounds = await toast.boundingBox();
    assert.ok(bounds, 'Success toast must be visible');
    assert.ok(Math.abs(1000 - bounds.x - bounds.width) <= 32, 'Toast must sit at the right edge');
    assert.ok(Math.abs(780 - bounds.y - bounds.height) <= 32, 'Toast must sit at the bottom edge');
    await page.waitForFunction(() => __BACKUP_FIXTURE__.acknowledgments.includes('success-1'));
    assert.deepEqual(await page.evaluate(() => __BACKUP_FIXTURE__.saves), [['destinationRoot', 'E:\\DSH备份']]);
    await capture('backup-success');
    await toast.waitFor({ state: 'hidden', timeout: 5000 });
    assert.ok(Date.now() - firstShownAt >= 2400 && Date.now() - firstShownAt < 4500,
      'Default success must dismiss automatically after about three seconds');
    await page.evaluate(async () => { await __BACKUP_FIXTURE__.controller.refresh(); __BACKUP_FIXTURE__.render(true); });
    await page.locator('[data-dsh-backup-settings]').waitFor();
    assert.equal(await page.getByRole('textbox').inputValue(), 'E:\\DSH备份');
    assert.equal(await dialog.count(), 0);
    assert.equal(await toast.count(), 0, 'Acknowledged success must stay hidden after the next poll');
    assert.equal(await page.getByLabel('成功提醒频率', { exact: true }).inputValue(), 'daily');
    assert.equal(await page.getByLabel('显示时长（秒）', { exact: true }).inputValue(), '3');
    assert.deepEqual(await page.getByLabel('成功提醒频率', { exact: true }).evaluate(element =>
      [...element.options].map(option => option.value)), ['daily', 'startup', 'always', 'never']);
    await page.getByRole('textbox').fill('E:/新备份');
    await page.getByRole('button', { name: '保存目录', exact: true }).click();
    await page.waitForFunction(() => __BACKUP_FIXTURE__.saves.length === 2);
    await toast.getByText('DSH 对话备份成功', { exact: true }).waitFor();
    await toast.waitFor({ state: 'hidden', timeout: 5000 });
    await page.getByLabel('成功提醒频率', { exact: true }).selectOption('always');
    await page.getByLabel('显示时长（秒）', { exact: true }).fill('1');
    await page.getByRole('button', { name: '保存提醒设置', exact: true }).click();
    await page.waitForFunction(() => __BACKUP_FIXTURE__.form.value.successNoticeFrequency === 'always'
      && __BACKUP_FIXTURE__.form.value.noticeDurationSeconds === 1);
    assert.equal(await page.evaluate(() => __BACKUP_FIXTURE__.host.destinationRoot), 'E:\\新备份',
      'Saving notification settings must not replace the backup path');
    await page.evaluate(() => __BACKUP_FIXTURE__.render(false));
    await page.locator('[data-dsh-backup-settings]').waitFor({ state: 'hidden' });
    await page.evaluate(() => __BACKUP_FIXTURE__.render(true));
    await page.locator('[data-dsh-backup-settings]').waitFor();
    assert.equal(await page.getByLabel('成功提醒频率', { exact: true }).inputValue(), 'always');
    assert.equal(await page.getByLabel('显示时长（秒）', { exact: true }).inputValue(), '1');
    await capture('plugin-settings');
    await page.getByRole('textbox').focus();
    await page.evaluate(async () => {
      const fixture = __BACKUP_FIXTURE__;
      fixture.host.notice = { id: 'success-duration', kind: 'success', title: 'DSH 对话备份成功', message: '已应用提醒设置。' };
      await fixture.controller.refresh();
    });
    await toast.waitFor();
    const customShownAt = Date.now();
    assert.equal(await page.getByRole('textbox').evaluate(element => element === document.activeElement), true,
      'A notification must not steal focus from the settings editor');
    await toast.waitFor({ state: 'hidden', timeout: 2200 });
    assert.ok(Date.now() - customShownAt >= 700, 'Custom one-second duration must apply');
    await page.getByLabel('成功提醒频率', { exact: true }).selectOption('never');
    await page.getByRole('button', { name: '保存提醒设置', exact: true }).click();
    await page.waitForFunction(() => __BACKUP_FIXTURE__.form.value.successNoticeFrequency === 'never');
    await page.evaluate(async () => {
      const fixture = __BACKUP_FIXTURE__;
      fixture.host.notice = { id: 'success-muted', kind: 'success', title: 'DSH 对话备份成功', message: '此成功提醒应被停用。' };
      await fixture.controller.refresh();
    });
    assert.equal(await toast.count(), 0, 'Disabled success notifications must stay hidden');
    await page.evaluate(async () => {
      const fixture = __BACKUP_FIXTURE__;
      fixture.host.lastAttempt = { state: 'failed', error: '目标磁盘暂时不可用' };
      fixture.host.notice = { id: 'failure-1', kind: 'failure', title: 'DSH 对话备份失败', message: '目标磁盘暂时不可用，请连接磁盘后重试。' };
      await fixture.controller.refresh();
    });
    await toast.getByText('DSH 对话备份失败', { exact: true }).waitFor();
    assert.equal(await toast.getAttribute('role'), 'alert');
    assert.equal(await dialog.count(), 0, 'Failure notification must not block the app');
    await capture('backup-failure');
    await toast.getByRole('button', { name: '重试备份', exact: true }).click();
    await toast.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => __BACKUP_FIXTURE__.backups), 1);
    await page.evaluate(async () => {
      const fixture = __BACKUP_FIXTURE__;
      fixture.host.lastAttempt = { state: 'failed', error: '目标磁盘暂时不可用' };
      fixture.host.notice = { id: 'failure-auto', kind: 'failure', title: 'DSH 对话备份失败', message: '可在插件页查看和重试。' };
      await fixture.controller.refresh();
    });
    await toast.waitFor();
    await toast.waitFor({ state: 'hidden', timeout: 2200 });
    assert.deepEqual(errors, [], 'Native UI must render without browser errors');
    await page.evaluate(() => __BACKUP_FIXTURE__.stop());
    console.log(JSON.stringify({ ok: true, nativeStaticModules: true, nativeClientDependencies: 5,
      checks: ['first-install dialog', 'cancel picker', 'save canonical directory', 'bottom-right non-modal toast',
        'visible success acknowledgment', 'three-second automatic dismissal', 'acknowledged success remains silent',
        'change directory in plugin page', 'default daily frequency', 'save and reopen notification settings',
        'custom duration', 'notification preserves focus', 'muted success still permits failures',
        'failure after success', 'retry and silent recovery', 'automatic failure dismissal', 'cleanup'], browserErrors: errors.length }));
  } finally {
    await browser?.close();
    // The only recursive delete is our newly created, verified OS-temp subtree.
    assert.ok(temporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep + 'dsh-chat-backup-ui-'));
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
