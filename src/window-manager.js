// Window manager: creates, focuses, minimizes, maximizes, drags and closes
// application windows. It owns window DOM and z-order. Process lifecycle is
// delegated to ProcessManager.
import { Scope } from './runtime.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class WindowManager {
  #layer;
  #processes;
  #isMobile;
  #icon;
  #onChange;
  #onMobileHome;
  #onMoved;
  #windows = new Map(); // id -> { el, app, proc }
  #z = 10;
  #active = null;
  #mobile = null;

  constructor({ layer, processes, isMobile, icon, onChange, onMobileHome, onMoved }) {
    this.#layer = layer;
    this.#processes = processes;
    this.#isMobile = isMobile;
    this.#icon = icon;
    this.#onChange = onChange || (() => {});
    this.#onMobileHome = onMobileHome || (() => {});
    this.#onMoved = onMoved || (() => {});
  }

  get activeId() { return this.#active; }
  get mobileId() { return this.#mobile; }
  get size() { return this.#windows.size; }
  has(id) { return this.#windows.has(id); }
  get(id) { return this.#windows.get(id); }
  entries() { return this.#windows.entries(); }
  values() { return this.#windows.values(); }

  // Opens a window for app. If it is already open, focuses it instead.
  open(id, app, { html = '', position = null } = {}) {
    if (this.#windows.has(id)) {
      this.focus(id);
      return this.#windows.get(id);
    }
    const mobile = this.#isMobile();
    if (mobile) {
      for (const w of this.#windows.values()) w.el.classList.add('hidden');
      this.#mobile = id;
      this.#onMobileHome(false);
    }

    const el = document.createElement('section');
    el.className = 'window';
    el.dataset.id = id;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', app.name);
    if (position && !mobile) {
      el.style.left = position.x + 'px';
      el.style.top = position.y + 'px';
      if (position.w) el.style.width = position.w + 'px';
      if (position.h) el.style.height = position.h + 'px';
    }
    el.innerHTML =
      `<header class="window-header"><div class="window-title">${this.#icon(app.icon)}<span>${esc(app.name)}</span></div>` +
      `<div class="window-controls"><button data-action="min" title="Minimize" aria-label="Minimize">${this.#icon('min')}</button>` +
      `<button data-action="max" title="Maximize" aria-label="Maximize">${this.#icon('max')}</button>` +
      `<button class="close" data-action="close" title="Close" aria-label="Close">${this.#icon('close')}</button></div></header>` +
      `<div class="window-content">${html}</div>`;
    this.#layer.append(el);

    const proc = this.#processes.launch(id, app);
    const entry = { el, app, proc };
    this.#windows.set(id, entry);
    this.#bind(id, entry);
    this.focus(id);
    return entry;
  }

  // Per-window listeners live in the process scope, so close() removes them.
  #bind(id, { el, proc }) {
    const scope = proc.scope;
    scope.on(el, 'pointerdown', () => this.focus(id));
    const bar = el.querySelector('.window-header');
    scope.on(bar, 'pointerdown', e => this.#startDrag(e, id, el, bar));
  }

  #startDrag(e, id, el, bar) {
    if (e.target.closest('button') || this.#isMobile() || el.classList.contains('maximized')) return;
    const rect = el.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    bar.setPointerCapture(e.pointerId);
    const move = ev => {
      el.style.left = Math.max(0, Math.min(innerWidth - el.offsetWidth, rect.left + ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(innerHeight - el.offsetHeight - 50, rect.top + ev.clientY - sy)) + 'px';
    };
    const end = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', end);
      bar.removeEventListener('pointercancel', end);
      const r = el.getBoundingClientRect();
      this.#onMoved(id, { x: r.left, y: r.top, w: r.width, h: r.height });
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', end, { once: true });
    bar.addEventListener('pointercancel', end, { once: true });
  }

  focus(id) {
    const w = this.#windows.get(id);
    if (!w) return;
    const mobile = this.#isMobile();
    const changed = this.#active !== id || w.el.classList.contains('hidden');
    for (const [key, x] of this.#windows) {
      x.el.classList.remove('focused');
      if (mobile && key !== id) x.el.classList.add('hidden');
    }
    w.el.classList.remove('hidden');
    w.el.classList.add('focused');
    w.el.style.zIndex = ++this.#z;
    this.#active = id;
    if (mobile) this.#mobile = id;
    this.#processes.resume(id);
    if (changed) this.#onChange();
  }

  restore(id) {
    this.focus(id);
  }

  minimize(id) {
    const w = this.#windows.get(id);
    if (!w) return;
    w.el.classList.add('hidden');
    if (this.#active === id) this.#active = null;
    this.#processes.suspend(id);
    if (this.#isMobile()) {
      if (this.#mobile === id) this.#mobile = null;
      this.#onMobileHome(true);
    }
    this.#onChange();
  }

  close(id) {
    const w = this.#windows.get(id);
    if (!w) return;
    this.#windows.delete(id);
    w.el.remove();
    this.#processes.terminate(id);
    if (this.#active === id) this.#active = [...this.#windows.keys()].at(-1) || null;
    if (this.#mobile === id) this.#mobile = null;
    this.#onChange();
    if (this.#isMobile() && !this.#mobile) this.#onMobileHome(true);
  }

  // Returns true when the window is now maximized.
  toggleMaximize(id) {
    const w = this.#windows.get(id);
    if (!w) return false;
    const yes = w.el.classList.toggle('maximized');
    const b = w.el.querySelector('[data-action=max]');
    b.innerHTML = this.#icon(yes ? 'restore' : 'max');
    b.title = yes ? 'Restore' : 'Maximize';
    b.setAttribute('aria-label', yes ? 'Restore window' : 'Maximize window');
    return yes;
  }

  // Hides every window and shows the mobile home screen.
  showMobileHome() {
    for (const w of this.#windows.values()) w.el.classList.add('hidden');
    this.#active = null;
    this.#mobile = null;
    this.#onMobileHome(true);
    this.#onChange();
  }

  // Re-applies single-window focus after a viewport change on phones.
  refocusMobile() {
    if (this.#mobile) this.focus(this.#mobile);
  }

  // Closes every window and terminates its process.
  closeAll() {
    for (const id of [...this.#windows.keys()]) this.close(id);
  }
}
