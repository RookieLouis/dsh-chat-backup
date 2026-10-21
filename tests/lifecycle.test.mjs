import test from 'node:test';
import assert from 'node:assert/strict';
import { installLifecycle } from '../lib/lifecycle.js';

const SUCCESS = { state: 'success', files: 2, newObjects: 1, bytesCopied: 32 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within(promise, description, timeoutMs = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    sourceRoot: 'fixture-source',
    destinationRoot: 'fixture-backup',
    intervalMinutes: 60,
    debounceSeconds: 0.01,
    backupAfterTurn: true,
    ...overrides,
  };
}

function makeContext({ flush = async () => {} } = {}) {
  const listeners = new Map();
  const effects = [];
  const readyListeners = new Set();
  const warnings = [];
  const infos = [];
  const ctx = {
    sessions: { flush },
    logger(name) {
      assert.equal(name, 'dsh-chat-backup');
      return { warn: (message) => warnings.push(message), info: (message) => infos.push(message) };
    },
    get(name) {
      assert.equal(name, 'appReady');
      return {
        onReady(callback) {
          readyListeners.add(callback);
          return () => readyListeners.delete(callback);
        },
      };
    },
    effect(setup, name) {
      // Match native effect semantics: setup executes while mounting; its
      // returned function executes while disposing the scope.
      const cleanup = setup();
      assert.equal(typeof cleanup, 'function', `${name} must register a disposer`);
      effects.push({ name, cleanup });
    },
    on(name, callback) {
      assert.equal(name, 'session/event');
      listeners.set(name, callback);
      return () => listeners.delete(name);
    },
  };
  return {
    ctx, warnings, infos, effects, listeners, readyListeners,
    ready() { for (const callback of [...readyListeners]) callback(); },
    emit(session, event) { return listeners.get('session/event')?.(session, event); },
    async dispose() {
      for (const { cleanup } of [...effects].reverse()) await cleanup();
    },
  };
}

test('native effects register readiness and startup waits until appReady fires', async () => {
  const host = makeContext();
  const started = deferred();
  const calls = [];
  installLifecycle(host.ctx, makeConfig(), {
    backup: async (options) => { calls.push(options); started.resolve(); return SUCCESS; },
  });
  try {
    assert.equal(calls.length, 0);
    assert.equal(host.readyListeners.size, 1);
    assert.equal(host.effects.length, 3);
    host.ready();
    await within(started.promise, 'startup backup');
    assert.deepEqual(calls, [{ sourceRoot: 'fixture-source', destinationRoot: 'fixture-backup', trigger: 'startup' }]);
  } finally {
    await host.dispose();
  }
  assert.equal(host.readyListeners.size, 0);
  assert.equal(host.listeners.size, 0);
});

test('turn/end returns immediately, awaits asynchronous flush, then debounces backups', async () => {
  const flushGate = deferred();
  const bothFlushing = deferred();
  const backedUp = deferred();
  const sessions = [{ id: 'first-session' }, { id: 'second-session' }];
  const flushCalls = [];
  const calls = [];
  const host = makeContext({ flush: async (session) => {
    flushCalls.push(session);
    if (flushCalls.length === 2) bothFlushing.resolve();
    await flushGate.promise;
  } });
  installLifecycle(host.ctx, makeConfig(), {
    backup: async (options) => { calls.push(options); backedUp.resolve(); return SUCCESS; },
  });
  try {
    assert.equal(host.emit(sessions[0], { type: 'turn/start' }), undefined);
    assert.equal(host.emit(sessions[0], { type: 'turn/end' }), undefined);
    assert.equal(host.emit(sessions[1], { type: 'turn/end' }), undefined);
    await within(bothFlushing.promise, 'both session flushes');
    assert.deepEqual(flushCalls, sessions);
    assert.equal(calls.length, 0, 'backup must wait for the flush promise');
    flushGate.resolve();
    await within(backedUp.promise, 'debounced backup');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].trigger, 'turn/end');
  } finally {
    flushGate.resolve();
    await host.dispose();
  }
});

test('flush can wait for event dispatch completion without a dispatcher deadlock', async () => {
  const dispatched = deferred();
  const backedUp = deferred();
  let flushing = false;
  const host = makeContext({ flush: async () => {
    flushing = true;
    // A host flush may serialize behind the event currently being dispatched.
    // Returning a flush promise from that event would create a cycle here.
    await dispatched.promise;
  } });
  installLifecycle(host.ctx, makeConfig(), { backup: async () => { backedUp.resolve(); return SUCCESS; } });
  try {
    const eventReturn = host.emit({ id: 'serialized' }, { type: 'turn/end' });
    assert.equal(eventReturn, undefined, 'dispatcher must not await the flush operation');
    await Promise.resolve(eventReturn);
    dispatched.resolve();
    await within(backedUp.promise, 'backup after serialized flush');
    assert.equal(flushing, true);
  } finally {
    dispatched.resolve();
    await host.dispose();
  }
});

test('cleanup waits for pending flush and prevents later writes', async () => {
  const flushGate = deferred();
  const flushing = deferred();
  const calls = [];
  const host = makeContext({ flush: async () => { flushing.resolve(); await flushGate.promise; } });
  const lifecycle = installLifecycle(host.ctx, makeConfig(), { backup: async (options) => { calls.push(options); return SUCCESS; } });
  const oldListener = host.listeners.get('session/event');
  const oldReady = [...host.readyListeners][0];
  host.emit({ id: 'pending-flush' }, { type: 'turn/end' });
  await within(flushing.promise, 'pending flush');
  let disposed = false;
  const disposing = host.dispose().then(() => { disposed = true; });
  try {
    await Promise.resolve();
    assert.equal(disposed, false, 'cleanup must wait for the flush job to settle');
    flushGate.resolve();
    await within(disposing, 'cleanup after flush');
    oldListener({ id: 'late-event' }, { type: 'turn/end' });
    oldReady();
    await lifecycle.start('late-manual');
    await delay(30);
    assert.equal(calls.length, 0);
  } finally {
    flushGate.resolve();
    await disposing;
  }
});

test('cleanup cancels an already scheduled turn backup', async () => {
  const calls = [];
  let flushes = 0;
  const host = makeContext({ flush: () => { flushes += 1; } });
  const lifecycle = installLifecycle(host.ctx, makeConfig({ debounceSeconds: 0.05 }), {
    backup: async (options) => { calls.push(options); return SUCCESS; },
  });
  try {
    host.emit({ id: 'debounced-turn' }, { type: 'turn/end' });
    // Await a complete manual run as a microtask barrier. The synchronous
    // flush and its scheduling continuation finish before this run resolves.
    await lifecycle.start('barrier');
    assert.equal(flushes, 1);
    await host.dispose();
    await delay(70);
    assert.deepEqual(calls.map((call) => call.trigger), ['barrier']);
  } finally {
    await host.dispose();
  }
});

test('cleanup waits for an active backup and clears the periodic timer', async () => {
  const activeGate = deferred();
  const started = deferred();
  const calls = [];
  const host = makeContext();
  const lifecycle = installLifecycle(host.ctx, makeConfig({ intervalMinutes: 0.0002 }), {
    backup: async (options) => { calls.push(options); started.resolve(); await activeGate.promise; return SUCCESS; },
  });
  host.ready();
  await within(started.promise, 'active startup backup');
  let disposed = false;
  const disposing = host.dispose().then(() => { disposed = true; });
  try {
    await Promise.resolve();
    assert.equal(disposed, false);
    activeGate.resolve();
    await within(disposing, 'active backup cleanup');
    await lifecycle.start('after-dispose');
    await delay(40);
    assert.equal(calls.length, 1);
  } finally {
    activeGate.resolve();
    await disposing;
  }
});

test('backup and flush failures warn without rejecting event or start callers', async () => {
  const host = makeContext({ flush: async () => { throw new Error('fixture flush failure'); } });
  const lifecycle = installLifecycle(host.ctx, makeConfig(), { backup: async () => { throw new Error('fixture backup failure'); } });
  try {
    await assert.doesNotReject(() => lifecycle.start('test-failure'));
    assert.equal(host.emit({ id: 'failing-flush' }, { type: 'turn/end' }), undefined);
  } finally {
    await host.dispose();
  }
  assert.equal(host.warnings.length, 2);
  assert.ok(host.warnings.some((message) => message.includes('fixture backup failure')));
  assert.ok(host.warnings.some((message) => message.includes('fixture flush failure')));
});

test('in-flight starts coalesce into one serialized follow-up backup', async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const secondStarted = deferred();
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const host = makeContext();
  const lifecycle = installLifecycle(host.ctx, makeConfig(), { backup: async (options) => {
    calls.push(options);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    try {
      if (calls.length === 1) await firstGate.promise;
      else { secondStarted.resolve(); await secondGate.promise; }
      return SUCCESS;
    } finally {
      running -= 1;
    }
  } });
  try {
    const first = lifecycle.start('first');
    const second = lifecycle.start('second');
    const third = lifecycle.start('third');
    assert.equal(second, first);
    assert.equal(third, first);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    firstGate.resolve();
    await within(Promise.all([first, second, third]), 'first coalesced run');
    await within(secondStarted.promise, 'follow-up backup');
    assert.deepEqual(calls.map((call) => call.trigger), ['first', 'pending']);
    assert.equal(maxRunning, 1);
    secondGate.resolve();
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await host.dispose();
  }
});

test('periodic timer starts only after readiness and produces interval backups', async () => {
  const intervalSeen = deferred();
  const calls = [];
  const host = makeContext();
  installLifecycle(host.ctx, makeConfig({ intervalMinutes: 0.0002 }), { backup: async (options) => {
    calls.push(options);
    if (options.trigger === 'interval') intervalSeen.resolve();
    return SUCCESS;
  } });
  try {
    assert.equal(calls.length, 0);
    host.ready();
    await within(intervalSeen.promise, 'interval backup');
    assert.equal(calls[0].trigger, 'startup');
    assert.ok(calls.some((call) => call.trigger === 'interval'));
  } finally {
    await host.dispose();
  }
  const count = calls.length;
  await delay(30);
  assert.equal(calls.length, count);
});

test('disabling lifecycle or turn backups omits the corresponding native registrations', async () => {
  const disabled = makeContext();
  assert.equal(installLifecycle(disabled.ctx, makeConfig({ enabled: false })), undefined);
  assert.equal(disabled.effects.length, 0);
  assert.equal(disabled.readyListeners.size, 0);
  assert.equal(disabled.listeners.size, 0);
  const turnsDisabled = makeContext();
  installLifecycle(turnsDisabled.ctx, makeConfig({ backupAfterTurn: false }));
  try {
    assert.equal(turnsDisabled.listeners.size, 0);
    assert.equal(turnsDisabled.effects.length, 2);
  } finally {
    await turnsDisabled.dispose();
  }
});
