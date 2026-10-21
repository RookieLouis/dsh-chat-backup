import path from 'node:path';
import { homedir } from 'node:os';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import { installLifecycle } from './lifecycle.js';
import { createController } from './controller.js';
import { installRemote } from './remote.js';
import { validateDestination } from './backup.js';

export const name = 'dsh-chat-backup';
export const inject = ['sessions'];
export const Config = z.object({
  enabled: z.boolean().default(true).description('启用对话自动备份'),
  destinationRoot: z.string().default('').volatile().description('备份保存路径（首次安装请在插件页面选择文件夹）'),
  successNoticeFrequency: z.union(['daily', 'startup', 'always', 'never']).default('daily').volatile().description('成功提示频率'),
  noticeDurationSeconds: z.number().min(1).max(60).step(1).default(3).volatile().description('提示显示时间（秒）'),
  intervalMinutes: z.number().min(1).max(1440).default(5).description('定时检查间隔（分钟）'),
  backupAfterTurn: z.boolean().default(true).description('每回合完成、日志落盘后触发备份'),
  debounceSeconds: z.number().min(1).max(300).default(10).description('合并短时间内触发的备份（秒）'),
});

export async function apply(ctx, input = {}) {
  const env = launchEnvironmentOf(ctx);
  const sourceRoot = path.resolve(env.get('DSH_HOME')?.value || process.env.DSH_HOME || path.join(homedir(), '.dsh'));
  const config = { enabled: true, intervalMinutes: 5, backupAfterTurn: true, debounceSeconds: 10, ...input };
  const value = field => field && typeof field.get === 'function' ? field.get() : field;
  const destination = () => {
    const selected = value(config.destinationRoot)?.trim() || '';
    return selected && path.isAbsolute(selected) ? path.resolve(selected) : selected;
  };
  const notificationSettings = () => ({
    successNoticeFrequency: value(config.successNoticeFrequency) ?? 'daily',
    noticeDurationSeconds: value(config.noticeDurationSeconds) ?? 3,
  });
  let active;
  let stopped = false;
  let updating = Promise.resolve();
  const replaceDestination = async () => {
    if (stopped) return;
    const destinationRoot = destination();
    if (active?.destinationRoot === destinationRoot) {
      active.controller.updateNotificationSettings(notificationSettings());
      return;
    }
    // Drain a backup before moving to another destination. Each lifecycle owns
    // its timers and in-flight jobs; its child fiber also owns status cleanup.
    if (active) await active.fiber.dispose();
    if (stopped) return;
    const controller = await createController({ sourceRoot, destinationRoot, ...notificationSettings() });
    if (stopped) { await controller.dispose(); return; }
    const runtime = { controller, destinationRoot, lifecycle: null, fiber: null };
    runtime.fiber = ctx.plugin(scope => {
      runtime.lifecycle = installLifecycle(scope, { ...config, sourceRoot, destinationRoot }, {
        backup: options => controller.perform(options), startup: start => controller.startup(start),
        reportFailure: (error, trigger) => controller.reportFailure(error, trigger),
      });
      scope.effect(() => () => controller.dispose(), 'dsh-chat-backup status cleanup');
    });
    active = runtime;
    await runtime.fiber.await();
  };
  ctx.effect(() => async () => {
    stopped = true;
    await updating.catch(() => {});
  }, 'dsh-chat-backup configuration cleanup');
  await replaceDestination();
  ctx.on('loader/volatile-update', () => {
    active?.controller.updateNotificationSettings(notificationSettings());
    updating = updating.catch(() => {}).then(replaceDestination);
    void updating.catch(error => ctx.logger('dsh-chat-backup').warn(error));
  });
  // Keep the Remote service mounted while a destination is being replaced.
  // Writes and manual backups wait for the accepted configuration to apply.
  const controller = {
    getState: () => ({ ...active.controller.getState(), enabled: config.enabled }),
    async acknowledge(payload) { await updating; return active.controller.acknowledge(payload); },
  };
  const lifecycle = config.enabled ? {
    async start(trigger) { await updating; return active.lifecycle?.start(trigger) ?? { state: 'disabled' }; },
  } : undefined;
  await installRemote(ctx, { controller, lifecycle, sourceRoot, validateDestination }).await();
  const settings = ctx.get('settings');
  if (settings) ctx.effect(() => settings.configure({ auto: false }), 'dsh-chat-backup custom settings');
}
