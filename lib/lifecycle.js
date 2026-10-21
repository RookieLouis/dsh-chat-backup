import { backup } from './backup.js';

// Kept independent of Cordis so timers and failure handling can be tested in isolation.
export function installLifecycle(ctx, config, dependencies = {}) {
  if (!config.enabled) return;
  const logger = ctx.logger('dsh-chat-backup');
  const run = dependencies.backup ?? backup;
  let stopped = false;
  let active = null;
  let timer;
  let debounce;
  let followup = false;
  const jobs = new Set();
  const warn = error => logger.warn(`DSH 对话备份失败：${error.message}`);
  const start = (trigger) => {
    if (stopped) return Promise.resolve({ state: 'stopped' });
    if (active) { followup = true; return active; }
    active = Promise.resolve().then(() => run({ sourceRoot: config.sourceRoot, destinationRoot: config.destinationRoot, trigger }))
      .then(result => {
        if (result.state === 'success') logger.info(`DSH 对话备份完成：${result.files} 个文件，新增 ${result.newObjects} 个版本 → ${config.destinationRoot}`);
        else if (result.state === 'busy' && result.stale) logger.warn('DSH 备份锁恢复中断：确认没有备份进程运行后，删除目标目录的 .backup.lock 和 .recover-*.lock；旧备份仍保留。');
        if (result.state === 'busy') followup = true;
        return result;
      }).catch(error => {
        warn(error);
        return { state: 'failed', error: error.message };
      }).finally(() => {
        active = null;
        if (followup && !stopped) { followup = false; schedule('pending'); }
      });
    return active;
  };
  const schedule = trigger => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = undefined; void start(trigger); }, config.debounceSeconds * 1000);
    debounce.unref?.();
  };
  ctx.effect(() => {
    const ready = ctx.get('appReady');
    const begin = () => {
      if (stopped) return;
      const startup = dependencies.startup ? dependencies.startup(start) : start('startup');
      const checking = Promise.resolve(startup).catch(warn);
      jobs.add(checking);
      void checking.finally(() => jobs.delete(checking));
      timer = setInterval(() => { void start('interval'); }, config.intervalMinutes * 60_000);
      timer.unref?.();
    };
    if (ready) return ready.onReady(begin);
    // Older hosts lack appReady; defer work outside the mounting stack.
    const fallback = setTimeout(begin, 1000);
    fallback.unref?.();
    return () => clearTimeout(fallback);
  }, 'dsh-chat-backup readiness');
  if (config.backupAfterTurn && ctx.sessions) {
    const off = ctx.on('session/event', (session, event) => {
      if (stopped || event.type !== 'turn/end') return;
      // Do not return a flush Promise to the session/event dispatcher: flush re-enters it.
      const task = Promise.resolve().then(() => ctx.sessions.flush(session)).then(() => {
        if (!stopped) schedule('turn/end');
      }).catch(async error => {
        warn(error);
        if (dependencies.reportFailure) await dependencies.reportFailure(error, 'flush').catch(warn);
      });
      jobs.add(task);
      void task.finally(() => jobs.delete(task));
    });
    ctx.effect(() => off, 'dsh-chat-backup event');
  }
  ctx.effect(() => async () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(debounce);
    await Promise.allSettled([...jobs]);
    if (active) await active;
  }, 'dsh-chat-backup cleanup');
  return { start };
}
