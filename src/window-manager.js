// Window manager: creates, focuses, minimizes, maximizes, drags, clamps and
// closes app windows. Owns window DOM and z-order. Process lifecycle goes
// through ProcessManager.
//
// A window is suspended whenever it is not visible: minimized on desktop, or
// behind the single visible window on a phone. Its process is suspended then
// and resumed when it is shown again.
//
// Window coordinates are relative to #windowLayer, which covers the desktop
// minus the taskbar. Its clientWidth/clientHeight is the usable work area.
import { Scope } from './runtime.js';

// Must match the CSS minimums for .window (min-width / min-height).
const MIN_W = 290;
const MIN_H = 220;

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class WindowManager {
  #layer;
  #processes;
  #isMobile;
  #icon;
  #onChange;
  #onMobileHome;
  #onMoved;
  #windows = new Map(); // id -> { el, app, proc, z, drag }
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

  // Opens a window for app, or focuses the existing one.
  open(id, app, { html = '', position = null } = {}) {
    if (this.#windows.has(id)) {
      this.focus(id);
      return this.#windows.get(id);
    }
    const mobile = this.#isMobile();
    if (mobile) {
      for (const [key, w] of this.#windows) this.#hide(key, w);
      this.#mobile = id;
      this.#onMobileHome(false);
    }

    const el = document.createElement('section');
    el.className = 'window';
    el.dataset.id = id;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', app.name);
    el.innerHTML =
      `<header class="window-header"><div class="window-title">${this.#icon(app.icon)}<span>${esc(app.name)}</span></div>` +
      `<div class="window-controls"><button data-action="min" title="Minimize" aria-label="Minimize">${this.#icon('min')}</button>` +
      `<button data-action="max" title="Maximize" aria-label="Maximize">${this.#icon('max')}</button>` +
      `<button class="close" data-action="close" title="Close" aria-label="Close">${this.#icon('close')}</button></div></header>` +
      `<div class="window-content">${html}</div>`;
    this.#layer.append(el);
    if (position && !mobile) this.#applyRect(el, position);

    const proc = this.#processes.launch(id, app);
    const entry = { el, app, proc, z: 0, drag: null };
    this.#windows.set(id, entry);
    this.#bind(id, entry);
    this.focus(id);
    return entry;
  }

  // Focus is cheap: the taskbar is rebuilt only when the active window changes.
  focus(id) {
    const w = this.#windows.get(id);
    if (!w) return;
    const mobile = this.#isMobile();
    const changed = this.#active !== id || w.el.classList.contains('hidden');
    for (const [key, x] of this.#windows) {
      if (key === id) continue;
      x.el.classList.remove('focused');
      if (mobile) this.#hide(key, x);
    }
    this.#show(id, w);
    w.el.classList.add('focused');
    w.z = ++this.#z;
    w.el.style.zIndex = w.z;
    this.#active = id;
    if (mobile) this.#mobile = id;
    if (changed) this.#onChange();
  }

  restore(id) {
    this.focus(id);
  }

  minimize(id) {
    const w = this.#windows.get(id);
    if (!w) return;
    this.#hide(id, w);
    if (this.#active === id) this.#active = null;
    if (this.#mobile === id) this.#mobile = null;
    if (this.#isMobile()) this.#onMobileHome(true);
    else this.#focusTop();
    this.#onChange();
  }

  // Removes the window and its process. On desktop the topmost visible window
  // becomes active; on a phone the home screen is shown.
  close(id) {
    const w = this.#windows.get(id);
    if (!w) return;
    this.#windows.delete(id);
    w.el.remove();
    this.#processes.terminate(id);
    if (this.#mobile === id) this.#mobile = null;
    if (this.#active === id) {
      this.#active = null;
      if (!this.#isMobile()) this.#focusTop();
    }
    this.#onChange();
    if (this.#isMobile() && this.#mobile === null) this.#onMobileHome(true);
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

  showMobileHome() {
    for (const [key, w] of this.#windows) this.#hide(key, w);
    this.#active = null;
    this.#mobile = null;
    this.#onMobileHome(true);
    this.#onChange();
  }

  refocusMobile() {
    if (this.#mobile) this.focus(this.#mobile);
  }

  // Brings every desktop window back inside the work area, e.g. after the
  // browser window shrinks. Does not save positions.
  reflow() {
    if (this.#isMobile()) return;
    for (const w of this.#windows.values()) {
      if (!w.el.classList.contains('maximized')) this.#fit(w.el);
    }
  }

  closeAll() {
    for (const id of [...this.#windows.keys()]) this.close(id);
  }

  // Drag listeners live in a per-drag Scope. The window's own Scope disposes
  // any drag still in progress when the window closes.
  #bind(id, entry) {
    const { el, proc } = entry;
    const scope = proc.scope;
    scope.on(el, 'pointerdown', () => this.focus(id));
    const bar = el.querySelector('.window-header');
    scope.on(bar, 'pointerdown', e => this.#startDrag(id, entry, e, bar));
    scope.add(() => {
      entry.drag?.dispose();
      entry.drag = null;
    });
  }

  #startDrag(id, entry, e, bar) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest('button') || this.#isMobile() || entry.el.classList.contains('maximized')) return;
    entry.drag?.dispose();
    const drag = new Scope();
    entry.drag = drag;

    const el = entry.el;
    const rect = el.getBoundingClientRect();
    const layerRect = this.#layer.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    try {
      bar.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best effort; the listeners below still work inside the bar.
    }
    const move = ev => {
      const maxX = Math.max(0, this.#layer.clientWidth - el.offsetWidth);
      const maxY = Math.max(0, this.#layer.clientHeight - el.offsetHeight);
      el.style.left = clamp(rect.left - layerRect.left + ev.clientX - sx, 0, maxX) + 'px';
      el.style.top = clamp(rect.top - layerRect.top + ev.clientY - sy, 0, maxY) + 'px';
    };
    const end = () => {
      if (entry.drag !== drag) return;
      drag.dispose();
      entry.drag = null;
      const r = el.getBoundingClientRect();
      this.#onMoved(id, { x: r.left - layerRect.left, y: r.top - layerRect.top, w: r.width, h: r.height });
    };
    drag.on(bar, 'pointermove', move).on(bar, 'pointerup', end).on(bar, 'pointercancel', end);
  }

  #hide(id, w) {
    w.el.classList.add('hidden');
    w.el.classList.remove('focused');
    this.#processes.suspend(id);
  }

  #show(id, w) {
    w.el.classList.remove('hidden');
    this.#processes.resume(id);
  }

  // Makes the topmost visible window active, if there is one.
  #focusTop() {
    let best = null;
    for (const [key, w] of this.#windows) {
      if (w.el.classList.contains('hidden')) continue;
      if (!best || w.z > best.z) best = { id: key, z: w.z };
    }
    if (best) this.focus(best.id);
  }

  // Applies a saved rectangle, limited to the current work area.
  #applyRect(el, pos) {
    const area = { width: this.#layer.clientWidth, height: this.#layer.clientHeight };
    const w = finite(pos.w);
    const h = finite(pos.h);
    const width = w === null ? el.offsetWidth : clamp(w, Math.min(MIN_W, area.width), area.width);
    const height = h === null ? el.offsetHeight : clamp(h, Math.min(MIN_H, area.height), area.height);
    if (w !== null) el.style.width = width + 'px';
    if (h !== null) el.style.height = height + 'px';
    el.style.left = clamp(finite(pos.x) ?? 0, 0, Math.max(0, area.width - width)) + 'px';
    el.style.top = clamp(finite(pos.y) ?? 0, 0, Math.max(0, area.height - height)) + 'px';
  }

  // Shrinks a window that is larger than the work area and moves it back on screen.
  #fit(el) {
    const area = { width: this.#layer.clientWidth, height: this.#layer.clientHeight };
    const width = Math.min(el.offsetWidth, area.width);
    const height = Math.min(el.offsetHeight, area.height);
    const left = clamp(el.offsetLeft, 0, Math.max(0, area.width - width));
    const top = clamp(el.offsetTop, 0, Math.max(0, area.height - height));
    if (width !== el.offsetWidth) el.style.width = width + 'px';
    if (height !== el.offsetHeight) el.style.height = height + 'px';
    if (left !== el.offsetLeft) el.style.left = left + 'px';
    if (top !== el.offsetTop) el.style.top = top + 'px';
  }
}
