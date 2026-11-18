// Process manager: tracks which applications are running, suspended or closed.
// Each process owns a Scope. Terminating a process disposes that scope, which
// removes the process's listeners and timers.
import { Scope } from './runtime.js';

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

  // Read-only snapshot for displays such as a task list.
  list() {
    return [...this.#procs.values()].map(({ pid, appId, name, state, startedAt }) => ({
      pid,
      appId,
      name,
      state,
      startedAt,
    }));
  }

  // Starts a process for appId, or returns the existing one.
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
      state: 'running',
      startedAt: Date.now(),
      scope: new Scope(),
    };
    this.#procs.set(appId, proc);
    this.#bus.emit('process:start', { pid: proc.pid, appId, name: proc.name });
    return proc;
  }

  suspend(appId) {
    const proc = this.#procs.get(appId);
    if (!proc || proc.state === 'suspended') return;
    proc.state = 'suspended';
    this.#bus.emit('process:suspend', { pid: proc.pid, appId });
  }

  resume(appId) {
    const proc = this.#procs.get(appId);
    if (!proc || proc.state === 'running') return;
    proc.state = 'running';
    this.#bus.emit('process:resume', { pid: proc.pid, appId });
  }

  terminate(appId) {
    const proc = this.#procs.get(appId);
    if (!proc) return;
    this.#procs.delete(appId);
    proc.scope.dispose();
    this.#bus.emit('process:exit', { pid: proc.pid, appId });
  }

  terminateAll() {
    for (const appId of [...this.#procs.keys()]) this.terminate(appId);
  }
}
