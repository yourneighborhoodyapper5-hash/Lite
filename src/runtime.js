// LightDesk runtime: event bus, resource scopes, and the error boundary.
// Shared by every other module. It does not touch window layout.

// Minimal publish/subscribe bus. A handler that throws is logged and does not
// stop the remaining handlers.
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

// A Scope owns the listeners, timers and cleanups created for one process or
// window. dispose() runs all of them. Adding to a disposed scope runs the
// cleanup immediately, so late registrations cannot leak.
export class Scope {
  #disposers = [];
  #disposed = false;

  get disposed() {
    return this.#disposed;
  }

  add(disposer) {
    if (this.#disposed) {
      disposer();
      return this;
    }
    this.#disposers.push(disposer);
    return this;
  }

  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    return this.add(() => target.removeEventListener(type, fn, opts));
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

// Central runtime. Every caught error is reported on the bus, so the shell can
// tell the user without crashing.
export const runtime = {
  bus: new EventBus(),

  reportError(err, source = 'app') {
    console.error(`[${source}]`, err);
    this.bus.emit('error', { err, source });
  },

  // Returns fn()'s value, or fallback if it throws.
  safely(source, fn, fallback = null) {
    try {
      return fn();
    } catch (err) {
      this.reportError(err, source);
      return fallback;
    }
  },

  // Reports a rejected promise and returns it, so callers can still await it.
  attach(promise, source) {
    return promise.catch(err => {
      this.reportError(err, source);
    });
  },
};
