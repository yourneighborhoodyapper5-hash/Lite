// App Store window: catalog, details, reviews, install/update/uninstall, publishing,
// updates, and "My apps" (this browser's submissions). DOM code only; all Firestore
// logic is in app-store.js and firestore-files.js. The desktop passes its state through init().
// No account is used anywhere in this window.
import { installPackage, uninstallPackage } from './install.js';
import { getFirebase, firebaseErrorMessage } from './firebase-client.js';
import * as AS from './app-store.js';
import { CATEGORIES, installIdOf } from './app-store.js';
import { LIMITS } from './firestore-files.js';
import { deviceId, forgetSubmission, hasReviewed, markReviewed, mySubmissions, recordSubmission, submitAllowance } from './submissions.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtBytes = n => (!Number.isFinite(n) ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

// Only data: images built by firestore-files.js (type taken from the bytes) are displayed.
const safeImg = u => (typeof u === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) ? esc(u) : '');
const hasFile = f => !!f && typeof f.id === 'string' && Number.isInteger(f.chunks) && f.chunks > 0;
const createdSeconds = r => Number(r.createdAt?.seconds) || 0;

// Image data URLs, loaded from Firestore on demand and cached for the session.
const imageCache = new Map();    // `${appId}/${fileId}` -> data URL or '' (failed)
const imagePending = new Map();  // same key -> Promise
const imageKey = (appId, file) => `${appId}/${file.id}`;
function loadImageCached(appId, file) {
  const key = imageKey(appId, file);
  if (imageCache.has(key)) return Promise.resolve(imageCache.get(key));
  if (!imagePending.has(key)) {
    imagePending.set(key, (async () => {
      try {
        const api = await getFirebase();
        const url = await AS.loadImage({ api, appId, file });
        imageCache.set(key, url);
        return url;
      } catch (err) {
        console.error(err);
        imageCache.set(key, '');
        return '';
      } finally {
        imagePending.delete(key);
      }
    })());
  }
  return imagePending.get(key);
}

let deps = null;
let records = [];      // published catalog entries, one per listing (latest version)
let mine = [];         // this browser's submissions with their current status
let category = '';
let query = '';
let detailId = null;
let updateTarget = null;
let installing = null; // AbortController for an install in progress
let publishing = null; // AbortController for a publish or update in progress

export function init(d) {
  deps = d;
}

export function markup() {
  const cats = CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  return `<div class="row between"><div><h2 class="section-title">App Store</h2><p class="subtle">Anyone can browse, install, and submit apps. Submissions are reviewed before they appear in the catalog. An app is installed only after its package is loaded and its checksum matches the listing.</p></div><button class="button" data-store="refresh">Refresh</button></div>`+
    `<div class="store-tools"><input class="field" data-store-search placeholder="Search apps" aria-label="Search apps"><select class="field" data-store-category aria-label="Category"><option value="">All categories</option>${cats}</select></div>`+
    `<div id="storeStatus" class="subtle">Loading catalog…</div><div id="storeDetail"></div><div class="store-grid" id="storeGrid"></div>`+
    `<div class="divider"></div><details id="myAppsBox"><summary>My submissions (this browser)</summary><p class="subtle">Submissions made from this browser. Anyone with another browser cannot see them. Clearing this browser's data removes them from this list, not from the App Store.</p><div id="myApps" class="subtle">None yet.</div><form class="store-form hidden" id="updateForm"><div class="subtle" id="updateTitle">Submit a new version</div>${formFields({ update: true })}<div class="row" style="margin-top:9px"><button class="button primary">Submit update for review</button><button type="button" class="button" data-store="update-cancel">Cancel</button></div><div id="updateStatus" class="subtle"></div></form></details>`+
    `<div class="divider"></div><details><summary>Publish an app</summary><p class="subtle">No account needed. Package: up to ${LIMITS.package / 1024} KB of HTML. Icon: up to ${LIMITS.icon / 1024} KB. Screenshots: up to ${LIMITS.maxScreenshots}, ${LIMITS.screenshot / 1048576} MB each (PNG, JPEG, or WebP). This browser can submit up to 5 apps a day.</p><form class="store-form" id="publishForm"><label class="field-label">App name</label><input class="field" name="name" required maxlength="48"><label class="field-label">Version</label><input class="field" name="version" required maxlength="32" placeholder="1.0.0"><label class="field-label">Category</label><select class="field" name="category" required>${cats}</select><label class="field-label">Description</label><input class="field" name="description" maxlength="500"><label class="field-label">Publisher name (optional)</label><input class="field" name="publisherName" maxlength="40" placeholder="Anonymous">${formFields()}<div class="row" style="margin-top:9px"><button class="button primary">Submit for review</button><button type="button" class="button" data-store="publish-cancel">Cancel upload</button></div><div id="publishStatus" class="subtle"></div></form></details>`;
}

function formFields({ update = false } = {}) {
  const v = update ? `<label class="field-label">New version</label><input class="field" name="version" required maxlength="32" placeholder="1.1.0"><label class="field-label">Description</label><input class="field" name="description" maxlength="500">` : '';
  return v+`<label class="field-label">Package (.html)</label><input class="field" name="package" type="file" accept=".html,text/html" required>`+
    `<label class="field-label">Icon (optional)</label><input class="field" name="icon" type="file" accept="image/png,image/jpeg,image/webp">`+
    `<label class="field-label">Screenshots (optional, up to ${LIMITS.maxScreenshots})</label><input class="field" name="screenshots" type="file" multiple accept="image/png,image/jpeg,image/webp">`;
}

// Loads the catalog. Returns one entry per listing: if a listing has several
// published versions (an update not yet retired by a moderator), the newest is shown.
export async function load() {
  const grid = $('#storeGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty">Loading catalog…</div>';
  try {
    const api = await getFirebase();
    const all = await AS.loadCatalog({ api, category });
    const byKey = new Map();
    for (const r of all) {
      const key = installIdOf(r);
      const cur = byKey.get(key);
      if (!cur || createdSeconds(r) > createdSeconds(cur)) byKey.set(key, r);
    }
    records = [...byKey.values()];
    $('#storeStatus').textContent = `${records.length} published app${records.length === 1 ? '' : 's'}${category ? ' in ' + category : ''}.`;
    renderCards(query);
    loadMine();
  } catch (err) {
    console.error(err);
    records = [];
    grid.innerHTML = `<div class="status-error">${esc(firebaseErrorMessage(err))}</div>`;
    $('#storeStatus').textContent = 'Catalog unavailable.';
  }
}

export function renderCards(q) {
  if (q !== undefined) query = String(q || '');
  const grid = $('#storeGrid');
  if (!grid || !grid.isConnected) return;
  const needle = query.trim().toLowerCase();
  const list = records.filter(r => !needle || `${r.name} ${r.description || ''}`.toLowerCase().includes(needle));
  grid.innerHTML = list.map(r => {
    const id = installIdOf(r);
    const verified = hasFile(r.packageFile) && /^[a-f0-9]{64}$/.test(r.sha256 || '');
    const have = deps.state().installed.find(x => x.id === id);
    let action;
    if (!verified) action = '<span class="badge">Unverified listing</span>';
    else if (have && have.sha256 === r.sha256) action = `<span class="badge">Installed</span><button class="button" data-store="uninstall" data-id="${esc(id)}">Uninstall</button>`;
    else action = `<button class="button primary" data-store="install" data-id="${esc(r.id)}">${have ? 'Update to ' + esc(r.version) : 'Install'}</button>`;
    const iconUrl = hasFile(r.iconFile) ? imageCache.get(imageKey(r.id, r.iconFile)) : '';
    const icon = safeImg(iconUrl) ? `<img class="store-icon" alt="" src="${safeImg(iconUrl)}">` : `<span class="glyph" data-icon-app="${esc(r.id)}">${deps.icon('store')}</span>`;
    return `<article class="store-card">${icon}<h3>${esc(r.name)}</h3><p>${esc(r.description || '')}</p><div class="subtle" style="font-size:11px">Version ${esc(r.version)} · ${esc(r.category || 'Other')} · by ${esc(r.publisherName || r.ownerName || 'Anonymous')}${verified ? ' · ' + fmtBytes(r.size) : ''}</div><div class="row between" style="margin-top:8px">${action}<button class="button" data-store="details" data-id="${esc(r.id)}">Details</button></div></article>`;
  }).join('') || '<div class="empty">No apps match.</div>';
  hydrateIcons(list);
}

// Loads icons for the listed apps one at a time and swaps them in when ready.
async function hydrateIcons(list) {
  for (const r of list) {
    if (!hasFile(r.iconFile) || imageCache.has(imageKey(r.id, r.iconFile))) continue;
    const url = await loadImageCached(r.id, r.iconFile);
    const grid = $('#storeGrid');
    if (!grid || !grid.isConnected) return;
    if (!safeImg(url)) continue;
    const slot = [...grid.querySelectorAll('[data-icon-app]')].find(el => el.dataset.iconApp === r.id);
    if (slot) slot.outerHTML = `<img class="store-icon" alt="" src="${safeImg(url)}">`;
  }
}

export function setCategory(v) {
  category = String(v || '');
  load();
}

// ---- My submissions (this browser only) ----
async function loadMine() {
  const el = $('#myApps');
  if (!el) return;
  const list = mySubmissions();
  if (!list.length) {
    mine = [];
    el.textContent = 'None yet.';
    return;
  }
  try {
    const api = await getFirebase();
    mine = await Promise.all(list.map(async entry => {
      try {
        return { entry, doc: await AS.loadSubmission({ api, appId: entry.appId }) };
      } catch (err) {
        return { entry, doc: null, error: firebaseErrorMessage(err) };
      }
    }));
    el.innerHTML = mine.map(({ entry, doc, error }) => {
      const status = error ? `<span class="status-error">${esc(error)}</span>` : !doc ? '<span class="badge">Not found</span>' : `<span class="badge">${esc(doc.status)}</span>`;
      const actions = doc?.status === 'pending' ? `<button class="button danger" data-store="withdraw-app" data-id="${esc(entry.appId)}">Withdraw</button>`
        : doc?.status === 'published' ? `<button class="button" data-store="update-start" data-id="${esc(entry.appId)}">Submit update</button>` : '';
      return `<div class="row between" style="margin:6px 0"><span><strong>${esc(entry.name)}</strong> v${esc(entry.version)} · ${status}</span><span class="row">${actions}<button class="button" data-store="forget-app" data-id="${esc(entry.appId)}">Remove from list</button></span></div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div class="status-error">${esc(firebaseErrorMessage(err))}</div>`;
  }
}

async function withdrawMine(appId) {
  try {
    const api = await getFirebase();
    const existing = await AS.loadSubmission({ api, appId });
    if (!existing) {
      forgetSubmission(appId);
      deps.toast('That submission no longer exists.');
    } else {
      await AS.withdrawPending({ api, appId, existing });
      forgetSubmission(appId);
      deps.toast('Submission withdrawn.');
    }
  } catch (err) {
    deps.toast(err.message || firebaseErrorMessage(err));
  }
  loadMine();
}

// ---- Details and reviews ----
async function showDetails(id) {
  detailId = id;
  const r = records.find(x => x.id === id) || mine.find(x => x.doc?.id === id)?.doc;
  const el = $('#storeDetail');
  if (!el || !r) return;
  const iconUrl = hasFile(r.iconFile) ? imageCache.get(imageKey(r.id, r.iconFile)) : '';
  el.innerHTML = `<div class="store-detail"><button class="button" data-store="close-details">Close</button><div class="row" style="gap:12px;align-items:flex-start"><span id="detailIcon">${safeImg(iconUrl) ? `<img class="store-icon big" alt="" src="${safeImg(iconUrl)}">` : ''}</span><div><h2>${esc(r.name)}</h2><div class="subtle">Version ${esc(r.version)} · ${esc(r.category || 'Other')} · by ${esc(r.publisherName || r.ownerName || 'Anonymous')}</div><p>${esc(r.description || '')}</p></div></div>`+
    `<div class="row" id="detailShots" style="flex-wrap:wrap;gap:6px"></div><div id="reviews" class="subtle">Loading reviews…</div></div>`;
  loadDetailImages(r, id);
  if (r.status !== 'published') {
    $('#reviews').innerHTML = '<div class="subtle">Reviews appear after the app is approved.</div>';
    return;
  }
  try {
    const api = await getFirebase();
    const reviews = await AS.loadReviews({ api, appId: id });
    const avg = reviews.length ? (reviews.reduce((s, x) => s + (x.rating || 0), 0) / reviews.length).toFixed(1) : null;
    const list = reviews.map(x => `<div class="review"><strong>${esc(x.userName || 'Reader')}</strong> · ${'★'.repeat(x.rating)}${'☆'.repeat(5 - x.rating)}<p>${esc(x.text || '')}</p></div>`).join('');
    const form = hasReviewed(id) ? '<div class="subtle">You have reviewed this app from this browser.</div>'
      : `<form class="store-form" id="reviewForm"><label class="field-label">Your rating</label><select class="field" name="rating"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select><input class="field" name="userName" maxlength="40" placeholder="Name (optional)"><textarea class="field" name="text" maxlength="500" placeholder="Optional review"></textarea><button class="button primary" data-store="review">Post review</button></form>`;
    $('#reviews').innerHTML = `<h3>Reviews${avg ? ` · ${avg} average from ${reviews.length}` : ''}</h3>${list || '<div class="subtle">No reviews yet.</div>'}${form}<button class="button danger" style="margin-top:8px" data-store="report" data-id="${esc(id)}">Report this app</button>`;
  } catch (err) {
    $('#reviews').innerHTML = `<div class="status-error">${esc(firebaseErrorMessage(err))}</div>`;
  }
}

// Loads the icon and screenshots for the open details panel from Firestore.
async function loadDetailImages(r, id) {
  if (hasFile(r.iconFile)) {
    const url = await loadImageCached(r.id, r.iconFile);
    const slot = detailId === id && $('#detailIcon');
    if (slot && safeImg(url)) slot.innerHTML = `<img class="store-icon big" alt="" src="${safeImg(url)}">`;
  }
  for (const sh of r.screenshots || []) {
    if (!hasFile(sh)) continue;
    const url = await loadImageCached(r.id, sh);
    const box = detailId === id && $('#detailShots');
    if (!box) return;
    if (safeImg(url)) box.insertAdjacentHTML('beforeend', `<img class="store-shot" alt="Screenshot" src="${safeImg(url)}">`);
  }
}

async function postReview(form) {
  try {
    const api = await getFirebase();
    if (hasReviewed(detailId)) return deps.toast('You have already reviewed this app from this browser.');
    await AS.submitReview({ api, appId: detailId, reviewerId: deviceId(), rating: form.elements.rating.value, text: form.elements.text.value, userName: form.elements.userName.value });
    markReviewed(detailId);
    deps.toast('Review posted.');
    showDetails(detailId);
  } catch (err) {
    deps.toast(err.message || firebaseErrorMessage(err));
  }
}

async function report(id) {
  try {
    const api = await getFirebase();
    await AS.reportApp({ api, appId: id });
    deps.toast('Thank you. The report was sent to moderators.');
  } catch (err) {
    deps.toast(firebaseErrorMessage(err));
  }
}

// ---- Install, update, uninstall (local device; packages verified by install.js) ----
async function installListing(rec) {
  if (installing) return deps.toast('Another install is already in progress.');
  const pkgStore = deps.getPkgStore();
  if (!pkgStore) return deps.toast('App storage is unavailable in this browser, so apps cannot be installed.');
  const root = $('#progressRoot');
  const ctrl = new AbortController();
  installing = ctrl;
  root.innerHTML = `<div class="progress-cover"><section class="progress-dialog" role="status"><h2>Installing ${esc(rec.name)}</h2><div class="subtle">Loading and verifying…</div><div class="progress-track"><div class="progress-fill" id="installProgress" style="width:0%"></div></div><div class="progress-caption"><span id="installBytes"></span><button class="button" data-store="cancel">Cancel</button></div></section></div>`;
  try {
    const api = await getFirebase();
    const meta = await installPackage({ ...rec, id: installIdOf(rec) }, {
      store: pkgStore,
      registry: deps.registry,
      signal: ctrl.signal,
      loadPackage: p => AS.loadPackage({ api, appId: rec.id, file: rec.packageFile, ...p }),
      onProgress: ({ loaded, total }) => {
        const bar = $('#installProgress');
        const label = $('#installBytes');
        if (total && bar) bar.style.width = Math.min(100, Math.round((loaded / total) * 100)) + '%';
        if (label) label.textContent = total ? `${fmtBytes(loaded)} of ${fmtBytes(total)}` : fmtBytes(loaded);
      },
    });
    const stored = await pkgStore.get(meta.id);
    if (stored?.html) deps.packageCache.set(meta.id, stored.html);
    deps.toast(`Installed ${meta.name} ${meta.version}.`);
  } catch (err) {
    deps.toast(err?.name === 'AbortError' ? 'Install cancelled. Nothing was installed.' : err?.message || 'Install failed. Nothing was installed.');
  } finally {
    installing = null;
    root.innerHTML = '';
    deps.renderChrome();
    renderCards();
  }
}

async function uninstallListing(id) {
  const pkgStore = deps.getPkgStore();
  if (!pkgStore) return deps.toast('App storage is unavailable.');
  try {
    await uninstallPackage(id, { store: pkgStore, registry: deps.registry });
    deps.packageCache.delete(id);
    if (deps.hasWindow('custom:' + id)) deps.closeWindow('custom:' + id);
    deps.toast('Uninstalled.');
  } catch (err) {
    deps.toast(err.message);
  } finally {
    deps.renderChrome();
    renderCards();
  }
}

// ---- Publishing and updates ----
async function readFile(f) {
  return f && f.size ? new Uint8Array(await f.arrayBuffer()) : null;
}

async function collectSubmission(form) {
  const pkgFile = form.elements.package.files?.[0];
  const iconFile = form.elements.icon?.files?.[0];
  const shotFiles = [...(form.elements.screenshots?.files || [])];
  const pkgBytes = await readFile(pkgFile);
  return {
    pkg: pkgBytes ? { bytes: pkgBytes, name: pkgFile.name } : null,
    icon: iconFile?.size ? { bytes: await readFile(iconFile), name: iconFile.name } : null,
    screenshots: await Promise.all(shotFiles.map(async f => ({ bytes: await readFile(f), name: f.name }))),
  };
}

async function runWithStatus(statusId, work) {
  const status = t => {
    const el = $(statusId);
    if (el) el.textContent = t;
  };
  publishing = new AbortController();
  try {
    return await work({
      signal: publishing.signal,
      onProgress: p => {
        const pct = p.totalBytes ? Math.round((p.bytesTransferred / p.totalBytes) * 100) : 0;
        status(`Uploading ${p.stage}… ${pct}%`);
      },
      status,
    });
  } finally {
    publishing = null;
    status('');
  }
}

export async function publish(form) {
  const gate = submitAllowance();
  if (!gate.ok) return deps.toast(gate.message);
  const meta = { name: form.elements.name.value, version: form.elements.version.value, description: form.elements.description.value, category: form.elements.category.value };
  try {
    const api = await getFirebase();
    const files = await collectSubmission(form);
    if (!files.pkg) return deps.toast('Choose a package (.html file).');
    const r = await runWithStatus('#publishStatus', ({ signal, onProgress }) =>
      AS.submitApp({ api, metadata: meta, publisherName: form.elements.publisherName.value, ...files, onProgress, signal }));
    recordSubmission({ appId: r.appId, listingKey: r.listingKey, name: meta.name.trim(), version: r.version });
    form.reset();
    deps.toast('Submitted for review. It appears in the catalog once a moderator approves it.');
    loadMine();
    return r;
  } catch (err) {
    deps.toast(err.name === 'AbortError' ? 'Upload cancelled.' : err.message || firebaseErrorMessage(err));
  }
}

// Submits a new version of an app that is in the catalog. The new version is reviewed
// like any submission and retires the old listing when a moderator approves it.
export async function submitUpdate(form) {
  const target = updateTarget;
  if (!target) return deps.toast('Choose an app to update first.');
  const gate = submitAllowance();
  if (!gate.ok) return deps.toast(gate.message);
  const meta = { name: target.name, version: form.elements.version.value, description: form.elements.description.value, category: target.category };
  if (String(meta.version).trim() === target.version) return deps.toast('Choose a new version number for the update.');
  try {
    const api = await getFirebase();
    const files = await collectSubmission(form);
    if (!files.pkg) return deps.toast('Choose the new package (.html file).');
    const r = await runWithStatus('#updateStatus', ({ signal, onProgress }) =>
      AS.submitApp({ api, metadata: meta, publisherName: target.publisherName, ...files, supersedes: { id: target.id, listingKey: target.listingKey || target.id }, onProgress, signal }));
    recordSubmission({ appId: r.appId, listingKey: r.listingKey, name: meta.name, version: r.version });
    form.reset();
    updateTarget = null;
    $('#updateForm').classList.add('hidden');
    deps.toast('Update submitted for review.');
    loadMine();
  } catch (err) {
    deps.toast(err.name === 'AbortError' ? 'Upload cancelled.' : err.message || firebaseErrorMessage(err));
  }
}

async function startUpdate(appId) {
  const entry = mine.find(m => m.entry.appId === appId);
  if (!entry?.doc || entry.doc.status !== 'published') return deps.toast('Only published apps can be updated.');
  updateTarget = { ...entry.doc, id: appId };
  const box = $('#updateForm');
  if (box) {
    box.classList.remove('hidden');
    $('#updateTitle').textContent = `Submit a new version of ${entry.doc.name}`;
    box.elements.version.value = '';
  }
}

// ---- Event dispatch from the desktop ----
export function action(b) {
  const kind = b.dataset.store;
  const id = b.dataset.id;
  switch (kind) {
    case 'install': {
      const r = records.find(x => x.id === id);
      if (r) installListing(r);
      return;
    }
    case 'uninstall': return uninstallListing(id);
    case 'cancel': return installing?.abort();
    case 'publish-cancel':
      return publishing?.abort();
    case 'update-cancel':
      updateTarget = null;
      $('#updateForm')?.classList.add('hidden');
      return publishing?.abort();
    case 'refresh': return load();
    case 'details': return showDetails(id);
    case 'close-details':
      detailId = null;
      $('#storeDetail').innerHTML = '';
      return;
    case 'review': return postReview(b.closest('form'));
    case 'report': return report(id);
    case 'update-start': return startUpdate(id);
    case 'withdraw-app': return withdrawMine(id);
    case 'forget-app':
      forgetSubmission(id);
      return loadMine();
  }
}
