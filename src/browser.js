// Browser model: tabs, per-tab navigation history, bookmarks, browsing history,
// recents, and address handling. Pure data logic: no DOM, no network.
//
// Limitation: a page can only be shown in a frame if its own server allows it
// (X-Frame-Options / frame-ancestors). The model cannot know that in advance,
// so the UI always offers "Open in browser", and a page that never reports
// loaded is marked as possibly blocked.

export const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
};
export const DEFAULT_ENGINE = 'duckduckgo';
export const HISTORY_LIMIT = 200;
export const LOAD_TIMEOUT_MS = 12000;

const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const HOST_PORT_RE = /^[a-z\d-]+(\.[a-z\d-]+)*:\d+(\/|$)/i;
const HOSTLIKE_RE = /^(localhost|[a-z\d-]+(\.[a-z\d-]+)+)(:\d+)?(\/\S*)?$/i;

export function searchUrl(query, engine = DEFAULT_ENGINE) {
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES[DEFAULT_ENGINE];
  return e.template.replace('%s', encodeURIComponent(query));
}

// Turns what the user typed into { ok, url, kind } where kind is 'url' or 'search'.
export function normalizeAddress(raw, engine = DEFAULT_ENGINE) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'Type a website address or a search.' };
  // "localhost:8000" looks like a scheme, but it is a host with a port.
  if (SCHEME_RE.test(value) && !HOST_PORT_RE.test(value)) {
    let u;
    try {
      u = new URL(value);
    } catch {
      return { ok: false, reason: 'That address is not valid.' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { ok: false, reason: 'Only http and https addresses can be opened.' };
    }
    return { ok: true, url: u.href, kind: 'url' };
  }
  if (!/\s/.test(value) && HOSTLIKE_RE.test(value)) {
    const u = new URL('https://' + value);
    return { ok: true, url: u.href, kind: 'url' };
  }
  return { ok: true, url: searchUrl(value, engine), kind: 'search' };
}

export function createTab(url = '', id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) {
  return { id, url, title: url ? hostOf(url) : 'New tab', history: url ? [url] : [], index: url ? 0 : -1, loading: false, error: null, startedAt: 0 };
}

export function createBrowser(url) {
  const first = createTab(url || '');
  return { tabs: [first], activeId: first.id };
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function activeTab(model) {
  return model.tabs.find(t => t.id === model.activeId) || model.tabs[0];
}

export function openTab(model, url = '') {
  const tab = createTab(url);
  return { ...model, tabs: [...model.tabs, tab], activeId: tab.id };
}

// Closing the last tab leaves a blank tab, so the browser is never empty.
export function closeTab(model, id) {
  const idx = model.tabs.findIndex(t => t.id === id);
  if (idx < 0) return model;
  const remaining = model.tabs.filter(t => t.id !== id);
  if (remaining.length === 0) {
    const blank = createTab('');
    return { tabs: [blank], activeId: blank.id };
  }
  const activeId = model.activeId === id ? remaining[Math.max(0, idx - 1)].id : model.activeId;
  return { tabs: remaining, activeId };
}

export function activateTab(model, id) {
  return model.tabs.some(t => t.id === id) ? { ...model, activeId: id } : model;
}

function updateTab(model, id, fn) {
  return { ...model, tabs: model.tabs.map(t => (t.id === id ? fn(t) : t)) };
}

// Navigating from the middle of history drops the forward entries.
export function navigateTab(model, id, url) {
  return updateTab(model, id, t => {
    const history = [...t.history.slice(0, t.index + 1), url];
    return { ...t, url, history, index: history.length - 1, title: hostOf(url), loading: true, error: null, startedAt: Date.now() };
  });
}

export function goBack(model, id) {
  return canGoBack(model, id) ? updateTab(model, id, t => {
    const index = t.index - 1;
    return { ...t, index, url: t.history[index], title: hostOf(t.history[index]), loading: true, error: null, startedAt: Date.now() };
  }) : model;
}

export function goForward(model, id) {
  return canGoForward(model, id) ? updateTab(model, id, t => {
    const index = t.index + 1;
    return { ...t, index, url: t.history[index], title: hostOf(t.history[index]), loading: true, error: null, startedAt: Date.now() };
  }) : model;
}

export function canGoBack(model, id) {
  const t = model.tabs.find(x => x.id === id);
  return !!t && t.index > 0;
}

export function canGoForward(model, id) {
  const t = model.tabs.find(x => x.id === id);
  return !!t && t.index < t.history.length - 1;
}

export function reloadTab(model, id) {
  return updateTab(model, id, t => (t.url ? { ...t, loading: true, error: null, startedAt: Date.now() } : t));
}

export function stopTab(model, id) {
  return updateTab(model, id, t => ({ ...t, loading: false }));
}

export function finishLoad(model, id) {
  const t = model.tabs.find(x => x.id === id);
  if (!t || !t.loading) return model;
  return updateTab(model, id, x => ({ ...x, loading: false, error: null }));
}

// Called when a page did not report loaded within LOAD_TIMEOUT_MS.
export function markPossiblyBlocked(model, id) {
  return updateTab(model, id, t => (t.loading ? { ...t, loading: false, error: 'blocked' } : t));
}

export function setTitle(model, id, title) {
  return updateTab(model, id, t => ({ ...t, title: String(title || hostOf(t.url || '')).slice(0, 80) }));
}

// Browsing history: newest first, consecutive duplicates collapsed, capped.
export function addHistory(list, entry) {
  const at = entry.at ?? Date.now();
  const last = list[0];
  if (last && last.url === entry.url) return [{ ...last, at, title: entry.title || last.title }, ...list.slice(1)];
  return [{ url: entry.url, title: entry.title || hostOf(entry.url), at }, ...list].slice(0, HISTORY_LIMIT);
}

export function clearHistory() {
  return [];
}

// Adds the URL if it is not bookmarked, removes it if it is.
export function toggleBookmark(list, { url, title }) {
  if (list.some(b => b.url === url)) return list.filter(b => b.url !== url);
  return [...list, { url, title: title || hostOf(url), added: Date.now() }];
}

// Most recent distinct sites, by host.
export function recentSites(history, count = 8) {
  const seen = new Set();
  const out = [];
  for (const h of history) {
    const host = hostOf(h.url);
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ host, url: h.url, at: h.at });
    if (out.length >= count) break;
  }
  return out;
}

// Only http and https addresses may be stored or opened externally.
export function isSafeWebUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
