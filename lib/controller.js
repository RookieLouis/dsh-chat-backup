import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup as defaultBackup, verifySnapshot as defaultVerify } from './backup.js';

export function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const succeeded = status => status && ['success', 'unchanged'].includes(status.state);
const time = value => { const n = Date.parse(value ?? ''); return Number.isFinite(n) ? n : -Infinity; };
// A settings change may recreate the controller. Only a new host process starts
// a new launch, so the startup policy stays quiet across those remounts.
const HOST_LAUNCH_ID = randomUUID();
const NOTICE_FREQUENCIES = new Set(['daily', 'startup', 'always', 'never']);

export async function createController({ sourceRoot, destinationRoot = '', successNoticeFrequency = 'daily', noticeDurationSeconds = 3,
  launchId = HOST_LAUNCH_ID, now = () => new Date(), backup = defaultBackup,
  verifySnapshot = defaultVerify, readStatus = root => fs.readFile(path.join(root, 'last-status.json'), 'utf8').then(JSON.parse) }) {
  const stateFile = path.join(sourceRoot, 'storages', 'dsh-chat-backup.json');
  const expectedSource = await fs.realpath(sourceRoot).catch(() => path.resolve(sourceRoot));
  const equalPath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const checkVerification = checked => {
    if (checked.valid === false || (checked.sourceRoot && !equalPath(checked.sourceRoot, expectedSource))) {
      throw new Error('备份校验失败，或备份不属于当前 DSH 数据目录。');
    }
  };
  let saved = { schema: 1, successShownDate: null, successShownLaunchId: null, lastAttempt: null };
  try {
    const loaded = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (loaded.schema !== 1 || (loaded.successShownDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(loaded.successShownDate)) ||
        (loaded.successShownLaunchId != null && typeof loaded.successShownLaunchId !== 'string')) throw new Error('Unsupported local backup status');
    saved = { ...saved, ...loaded };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Preserve malformed metadata before replacing it; never modify conversation files.
      await fs.copyFile(stateFile, `${stateFile}.invalid-${randomUUID()}`);
      saved.lastAttempt = { state: 'failed', error: '本地备份状态无法读取，将重新检查备份。', finishedAt: now().toISOString(), trigger: 'status-recovery' };
    }
  }
  let notice = null;
  let successNoticeStatus = null;
  saved.destinationRoot = destinationRoot;
  let writes = Promise.resolve();
  let stopped = false;
  let notificationSettings;
  const validateNotificationSettings = settings => {
    if (!NOTICE_FREQUENCIES.has(settings.successNoticeFrequency)) throw new TypeError('Unsupported backup success notice frequency');
    if (!Number.isFinite(settings.noticeDurationSeconds) || settings.noticeDurationSeconds < 1 || settings.noticeDurationSeconds > 60) {
      throw new TypeError('Backup notice duration must be between 1 and 60 seconds');
    }
    return settings;
  };
  notificationSettings = validateNotificationSettings({ successNoticeFrequency, noticeDurationSeconds });
  const persist = () => {
    const text = JSON.stringify(saved, null, 2) + '\n';
    const next = writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      const temp = `${stateFile}.partial-${randomUUID()}`;
      try {
        const file = await fs.open(temp, 'wx', 0o600);
        try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
        await fs.rename(temp, stateFile);
      } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    });
    writes = next;
    return next;
  };
  const successSuppressed = day => notificationSettings.successNoticeFrequency === 'never' ||
    (notificationSettings.successNoticeFrequency === 'daily' && saved.successShownDate === day) ||
    (notificationSettings.successNoticeFrequency === 'startup' && saved.successShownLaunchId === launchId);
  const successMessage = status => {
    const policy = notificationSettings.successNoticeFrequency;
    const reminder = policy === 'daily' ? '\n今天不再重复显示成功提示。' : policy === 'startup' ? '\n本次启动不再重复显示成功提示。' : '';
    return `已确认 ${status.files ?? 0} 个文件备份完整。\n保存位置：${destinationRoot}${reminder}`;
  };
  const notify = (kind, status) => {
    if (stopped) return;
    const day = localDay(now());
    if (kind === 'success') {
      if (successSuppressed(day)) { notice = null; return; }
      // Polling and background checks must not replace an unshown daily/startup
      // notice with a fresh ID and cause duplicate toasts while delivery retries.
      if (notice?.kind === 'success' && notificationSettings.successNoticeFrequency !== 'always' &&
          (notificationSettings.successNoticeFrequency === 'startup' || notice.day === day)) return;
    }
    if (kind === 'success') successNoticeStatus = status;
    notice = {
      id: randomUUID(), kind, day,
      title: kind === 'success' ? 'DSH 对话备份成功' : 'DSH 对话备份失败',
      message: kind === 'success'
        ? successMessage(status)
        : `${status.error || '备份未完成，请稍后重试。'}\n保存位置：${destinationRoot || '尚未设置'}\n请在插件页面检查保存路径并重试。`,
    };
  };
  const updateNotificationSettings = (options = {}) => {
    notificationSettings = validateNotificationSettings({
      successNoticeFrequency: options.successNoticeFrequency === undefined ? notificationSettings.successNoticeFrequency : options.successNoticeFrequency,
      noticeDurationSeconds: options.noticeDurationSeconds === undefined ? notificationSettings.noticeDurationSeconds : options.noticeDurationSeconds,
    });
    if (notice?.kind === 'success') {
      if (successSuppressed(localDay(now()))) notice = null;
      else notice.message = successMessage(successNoticeStatus);
    }
    return { ...notificationSettings };
  };
  const reportFailure = async (error, trigger = 'startup') => {
    saved.lastAttempt = { state: 'failed', trigger, error: String(error?.message ?? error), finishedAt: now().toISOString(), destinationRoot };
    notify('failure', saved.lastAttempt);
    await persist();
  };
  const getState = () => structuredClone({ destinationRoot, needsSetup: !destinationRoot, ...notificationSettings,
    running: saved.lastAttempt?.state === 'running' && (!saved.lastAttempt.destinationRoot || equalPath(saved.lastAttempt.destinationRoot, destinationRoot)),
    lastAttempt: saved.lastAttempt?.destinationRoot && destinationRoot && !equalPath(saved.lastAttempt.destinationRoot, destinationRoot) ? null : saved.lastAttempt, notice });
  const perform = async options => {
    if (!destinationRoot) return { state: 'unconfigured' };
    const trigger = options?.trigger || 'manual';
    saved.lastAttempt = { state: 'running', trigger, destinationRoot, startedAt: now().toISOString() };
    try {
      await persist();
      const result = await backup({ ...options, sourceRoot, destinationRoot, trigger });
      saved.lastAttempt = { ...result, trigger, destinationRoot, finishedAt: now().toISOString() };
      if (succeeded(result)) {
        // Success is shown only after the committed snapshot passes an independent verification.
        const checked = await verifySnapshot(destinationRoot, result.snapshotId);
        checkVerification(checked);
        notify('success', saved.lastAttempt);
      } else if (result.state === 'busy' && result.stale) {
        saved.lastAttempt.error = '备份锁恢复未完成，请确认备份进程状态后重试。';
        notify('failure', saved.lastAttempt);
      }
      await persist();
      return result;
    } catch (error) {
      await reportFailure(error, trigger).catch(() => {});
      throw error;
    }
  };
  const startup = async run => {
    if (!destinationRoot || stopped) return;
    let status;
    try { status = await readStatus(destinationRoot); } catch { /* missing/inaccessible/invalid status triggers a new attempt */ }
    const previous = saved.lastAttempt;
    const localFailureIsNewer = previous && !succeeded(previous) &&
      time(previous.finishedAt || previous.startedAt) >= time(status?.finishedAt) &&
      (!previous.destinationRoot || equalPath(previous.destinationRoot, destinationRoot));
    if (!localFailureIsNewer && succeeded(status) && time(status.finishedAt) > -Infinity &&
        localDay(new Date(status.finishedAt)) === localDay(now()) && status.snapshotId) {
      try {
        const checked = await verifySnapshot(destinationRoot, status.snapshotId);
        checkVerification(checked);
        saved.lastAttempt = { ...status, destinationRoot, verifiedAt: now().toISOString() };
        notify('success', saved.lastAttempt);
        await persist();
        return { state: 'verified', snapshotId: status.snapshotId };
      } catch { /* a failed verification must trigger a fresh backup and report its result */ }
    }
    return run('startup');
  };
  const acknowledge = async ({ id }) => {
    if (!notice || notice.id !== id) return false;
    const previousNotice = notice;
    const previousDay = saved.successShownDate;
    const previousLaunchId = saved.successShownLaunchId;
    if (notice.kind === 'success') {
      saved.successShownDate = localDay(now());
      saved.successShownLaunchId = launchId;
    }
    notice = null;
    try { await persist(); } catch (error) {
      notice = previousNotice;
      saved.successShownDate = previousDay;
      saved.successShownLaunchId = previousLaunchId;
      throw error;
    }
    return true;
  };
  await persist();
  return { getState, startup, perform, acknowledge, reportFailure, updateNotificationSettings,
    async dispose() { stopped = true; await writes; } };
}
