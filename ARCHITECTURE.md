# LightDesk: Stage 1 architecture

Entry point: `index.html` loads `src/desktop.js` as a module. Relative paths only, so it works from a GitHub Pages subpath.

| Module | Responsibility |
|---|---|
| `src/runtime.js` | `EventBus` (publish/subscribe), `Scope` (owns listeners, timers and cleanup for one process), `runtime.safely()` (error boundary), `runtime.reportError()` |
| `src/process-manager.js` | Process table: launch (idempotent), suspend, resume, terminate. Each process has a `Scope`; terminating disposes it. Emits `process:*` events on the bus |
| `src/window-manager.js` | Window DOM and z-order: open, focus, minimize, restore, maximize, drag, close, mobile single-window mode. Per-window listeners live in the process scope |
| `src/desktop.js` | Existing apps, UI wiring, storage, Firebase store. Calls the three modules above instead of managing windows itself |

Storage format is unchanged (`lightdesk-v4`, same keys). Stage 2 will change storage.

Lifecycle: `openApp` → `ProcessManager.launch` → `WindowManager.open` → (`minimize` → `suspend`, `focus` → `resume`) → `close` → `ProcessManager.terminate` (disposes scope).

`backup/index.original.html` is the untouched upload, for comparison.
