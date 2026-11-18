// LightDesk runtime: event bus, resource scopes, and an error boundary.
// Shared by every other module. It does not touch the DOM layout itself.

// Minimal publish/subscribe bus. Handlers that throw are logged and do not
// stop other handlers from running.
export class EventBus {
  #handlers = new Map();

  on(type, fn) {
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(type, payload) {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus:${type}]`, err);
      }
    }
  }
}

// A Scope owns every listener, timer and cleanup callback created on behalf
// of one process or window. dispose() removes all of them, so a closed app
// cannot keep running or leak listeners.
export class Scope {
  #disposers = [];
  #disposed = false;

  get disposed() {
    return this.#disposed;
  }

  add(disposer) {
    if (this.#disposed) {
      disposer();
      return;
    }
    this.#disposers.push(disposer);
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.add(() => target.removeEventListener(type, fn, opts));
    return this;
  }

  timeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  interval(fn, ms) {
    const id = setInterval(fn, ms);
    this.add(() => clearInterval(id));
    return id;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const list = this.#disposers.splice(0).reverse();
    for (const d of list) {
      try {
        d();
      } catch (err) {
        console.error('[scope] cleanup failed', err);
      }
    }
  }
}

// Central runtime object. Errors are reported on the bus so the shell can
// show a notice instead of crashing.
export const runtime = {
  bus: new EventBus(),

  reportError(err, source = 'app') {
    console.error(`[${source}]`, err);
    this.bus.emit('error', { err, source });
  },

  // Runs fn and returns its value, or the fallback if it throws.
  safely(source, fn, fallback = null) {
    try {
      return fn();
    } catch (err) {
      this.reportError(err, source);
      return fallback;
    }
  },
};
