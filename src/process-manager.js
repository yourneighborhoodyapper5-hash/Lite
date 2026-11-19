// Process manager: tracks running applications and their lifecycle.
//
// Lifecycle contract. launch() returns a process record; proc.ctx is the API
// given to apps:
//   ctx.onSuspend(fn), ctx.onResume(fn), ctx.onExit(fn)
//       Called when the process is suspended, resumed, or terminated.
//       Each returns an unsubscribe function.
//   ctx.every(ms, fn)
//       Interval that stops while the process is suspended and restarts on
//       resume. Returns a cancel function.
//   ctx.scope
//       Scope for listeners and cleanups. Disposed when the process exits.
//   ctx.suspended
//       true while suspended.
//
// Suspension pauses only what the app registers through ctx. It does NOT abort
// in-flight network requests, stop media or CSS animations, or free memory.
// An app that needs those must handle onSuspend itself.
import { Scope, runtime } from './runtime.js';

const RUNNING = 'running';
const SUSPENDED = 'suspended';
const EXITED = 'exited';

export class ProcessManager {
  #procs = new Map(); // appId -> process record
  #nextPid = 1;
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  has(appId) {
    return this.#procs.has(appId);
  }

  get(appId) {
    return this.#procs.get(appId);
  }

  // Read-only snapshot, for task lists and diagnostics.
  list() {
    return [...this.#procs.values()].map(({ pid, appId, name, state, startedAt }) => ({
      pid,
      appId,
      name,
      state,
      startedAt,
    }));
  }

  // Starts a process for appId, or returns the running one and resumes it.
  launch(appId, meta = {}) {
    const existing = this.#procs.get(appId);
    if (existing) {
      this.resume(appId);
      return existing;
    }
    const proc = {
      pid: this.#nextPid++,
      appId,
      name: meta.name || appId,
      state: RUNNING,
      startedAt: Date.now(),
      scope: new Scope(),
      hooks: { suspend: new Set(), resume: new Set(), exit: new Set() },
      timers: new Set(),
    };
    proc.ctx = createContext(proc);
    this.#procs.set(appId, proc);
    this.#bus.emit('process:start', { pid: proc.pid, appId, name: proc.name });
    return proc;
  }

  suspend(appId) {
    const proc = this.#procs.get(appId);
    if (!proc || proc.state !== RUNNING) return;
    proc.state = SUSPENDED;
    for (const t of proc.timers) stopTimer(t);
    fire(proc, 'suspend');
    this.#bus.emit('process:suspend', { pid: proc.pid, appId });
  }

  resume(appId) {
    const proc = this.#procs.get(appId);
    if (!proc || proc.state !== SUSPENDED) return;
    proc.state = RUNNING;
    for (const t of proc.timers) startTimer(proc, t);
    fire(proc, 'resume');
    this.#bus.emit('process:resume', { pid: proc.pid, appId });
  }

  terminate(appId) {
    const proc = this.#procs.get(appId);
    if (!proc) return;
    this.#procs.delete(appId);
    proc.state = EXITED;
    fire(proc, 'exit');
    for (const t of proc.timers) stopTimer(t);
    proc.timers.clear();
    for (const set of Object.values(proc.hooks)) set.clear();
    proc.scope.dispose();
    this.#bus.emit('process:exit', { pid: proc.pid, appId });
  }

  terminateAll() {
    for (const appId of [...this.#procs.keys()]) this.terminate(appId);
  }
}

function createContext(proc) {
  return {
    get appId() {
      return proc.appId;
    },
    get pid() {
      return proc.pid;
    },
    get suspended() {
      return proc.state === SUSPENDED;
    },
    get scope() {
      return proc.scope;
    },
    onSuspend: fn => addHook(proc, 'suspend', fn),
    onResume: fn => addHook(proc, 'resume', fn),
    onExit: fn => addHook(proc, 'exit', fn),
    every(ms, fn) {
      if (typeof fn !== 'function') throw new TypeError('every() needs a function');
      if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('every() needs a positive interval');
      if (proc.state === EXITED) return () => {};
      const t = { ms, fn, id: null };
      proc.timers.add(t);
      if (proc.state === RUNNING) startTimer(proc, t);
      return () => {
        stopTimer(t);
        proc.timers.delete(t);
      };
    },
  };
}

function addHook(proc, kind, fn) {
  if (typeof fn !== 'function') throw new TypeError(`on${kind} needs a function`);
  if (proc.state === EXITED) return () => {};
  proc.hooks[kind].add(fn);
  return () => proc.hooks[kind].delete(fn);
}

function startTimer(proc, t) {
  if (t.id !== null) return;
  t.id = setInterval(() => {
    try {
      t.fn();
    } catch (err) {
      runtime.reportError(err, `process:${proc.appId}`);
    }
  }, t.ms);
}

function stopTimer(t) {
  if (t.id === null) return;
  clearInterval(t.id);
  t.id = null;
}

// Runs lifecycle hooks. A failing hook is reported and does not stop the others.
function fire(proc, kind) {
  for (const fn of [...proc.hooks[kind]]) {
    try {
      fn();
    } catch (err) {
      runtime.reportError(err, `process:${proc.appId}:${kind}`);
    }
  }
}
