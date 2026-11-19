// App Store window: catalog, details, reviews, install/update/uninstall,
// publishing, updates, and "My apps". DOM code only; all Firebase logic is in
// app-store.js and firestore-files.js. The desktop passes its state through init().
import { installPackage, uninstallPackage } from './install.js';
import { getFirebase, firebaseErrorMessage } from './firebase-client.js';
import * as AS from './app-store.js';
import { CATEGORIES } from './app-store.js';
import { LIMITS } from './firestore-files.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtBytes = n => (!Number.isFinite(n) ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
// Only data: images built by firestore-files.js (type taken from the bytes) are displayed.
const safeImg = u => (typeof u === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(u) ? esc(u) : '');
const hasFile = f => !!f && typeof f.id === 'string' && Number.isInteger(f.chunks) && f.chunks > 0;
// Image data URLs, loaded from Firestore on demand and cached for the session.
const imageCache = new Map();    // `${appId}/${fileId}` -> data URL or '' (failed)
const imagePending = new Map();  // same key -> Promise
function imageKey(appId, file) {
  return `${appId}/${file.id}`;
}
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
let records = [];      // published catalog entries
let mine = [];         // apps owned by the signed-in user
let category = '';
let query = '';
let user = null;
let detailId = null;
let updateTarget = null;
let installing = null; // AbortController for an install in progress
let publishing = null; // AbortController for a publish or update in progress

export function init(d) {
  deps = d;
}

export function markup() {
  const cats = CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  return `<div class="row between"><div><h2 class="section-title">App Store</h2><p class="subtle">An app is installed only after its package is loaded and its checksum matches the listing.</p></div><button class="button" data-store="refresh">Refresh</button></div>`+
    `<div id="storeAccount" class="store-account"></div>`+
    `<div class="store-tools"><input class="field" data-store-search placeholder="Search apps" aria-label="Search apps"><select class="field" data-store-category aria-label="Category"><option value="">All categories</option>${cats}</select></div>`+
    `<div id="storeStatus" class="subtle">Loading catalog…</div><div id="storeDetail"></div><div class="store-grid" id="storeGrid"></div>`+
    `<div class="divider"></div><details id="myAppsBox"><summary>My apps</summary><div id="myApps" class="subtle">Sign in to see your apps.</div><form class="store-form hidden" id="updateForm"><div class="subtle" id="updateTitle">Upload a new version</div>${formFields()}<div class="row" style="margin-top:9px"><button class="button primary">Submit update for review</button><button type="button" class="button" data-store="update-cancel">Cancel</button></div><div id="updateStatus" class="subtle"></div></form></details>`+
    `<div class="divider"></div><details><summary>Publish an app</summary><p class="subtle">You must be signed in. Submissions are reviewed before they appear in the catalog. Package: up to ${LIMITS.package / 1024} KB of HTML. Icon: up to ${LIMITS.icon / 1024} KB. Screenshots: up to ${LIMITS.maxScreenshots}, ${LIMITS.screenshot / 1048576} MB each (PNG, JPEG, or WebP).</p><form class="store-form" id="publishForm"><label class="field-label">App name</label><input class="field" name="name" required maxlength="48"><label class="field-label">Version</label><input class="field" name="version" required maxlength="32" placeholder="1.0.0"><label class="field-label">Category</label><select class="field" name="category" required>${cats}</select><label class="field-label">Description</label><input class="field" name="description" maxlength="500">${formFields()}<div class="row" style="margin-top:9px"><button class="button primary">Submit for review</button><button type="button" class="button" data-store="publish-cancel">Cancel upload</button></div><div id="publishStatus" class="subtle"></div></form></details>`;
}

function formFields() {
  return `<label class="field-label">Package (.html)</label><input class="field" name="package" type="file" accept=".html,text/html" required>`+
    `<label class="field-label">Icon (optional)</label><input class="field" name="icon" type="file" accept="image/png,image/jpeg,image/webp">`+
    `<label class="field-label">Screenshots (optional, up to ${LIMITS.maxScreenshots})</label><input class="field" name="screenshots" type="file" multiple accept="image/png,image/jpeg,image/webp">`+
    '';
}

export async function load() {
  const grid = $('#storeGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="empty">Loading catalog…</div>';
  try {
    const api = await getFirebase();
    records = await AS.loadCatalog({ api, category });
    $('#storeStatus').textContent = `${records.length} published app${records.length === 1 ? '' : 's'}${category ? ' in ' + category : ''}.`;
    renderCards(query);
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
    const verified = hasFile(r.packageFile) && /^[a-f0-9]{64}$/.test(r.sha256 || '');
    const have = deps.state().installed.find(x => x.id === r.id);
    let action;
    if (!verified) action = '<span class="badge">Unverified listing</span>';
    else if (have && have.sha256 === r.sha256) action = `<span class="badge">Installed</span><button class="button" data-store="uninstall" data-id="${esc(r.id)}">Uninstall</button>`;
    else action = `<button class="button primary" data-store="install" data-id="${esc(r.id)}">${have ? 'Update to ' + esc(r.version) : 'Install'}</button>`;
    const iconUrl = hasFile(r.iconFile) ? imageCache.get(imageKey(r.id, r.iconFile)) : '';
    const icon = safeImg(iconUrl) ? `<img class="store-icon" alt="" src="${safeImg(iconUrl)}">` : `<span class="glyph" data-icon-app="${esc(r.id)}">${deps.icon('store')}</span>`;
    return `<article class="store-card">${icon}<h3>${esc(r.name)}</h3><p>${esc(r.description || '')}</p><div class="subtle" style="font-size:11px">Version ${esc(r.version)} · ${esc(r.category || 'Other')} · by ${esc(r.ownerName || 'developer')}${verified ? ' · ' + fmtBytes(r.size) : ''}</div><div class="row between" style="margin-top:8px">${action}<button class="button" data-store="details" data-id="${esc(r.id)}">Details</button></div></article>`;
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

// ---- Accounts ----
export async function subscribe() {
  try {
    const api = await getFirebase();
    const unsub = api.onAuthStateChanged(api.auth, u => {
      user = u;
      renderAccount();
      renderMine();
    });
    const scope = deps.windowScope('store');
    if (scope) scope.add(unsub);
    else unsub();
  } catch (err) {
    console.error(err);
    const el = $('#storeAccount');
    if (el) el.innerHTML = `<div class="status-error">${esc(firebaseErrorMessage(err))}</div>`;
    return;
  }
  renderAccount();
}

function renderAccount() {
  const el = $('#storeAccount');
  if (!el) return;
  if (user) {
    el.innerHTML = `<div class="row between"><span class="subtle">Signed in as ${esc(user.email || user.displayName || 'your account')}</span><button class="button" data-store="signout">Sign out</button></div>`;
    return;
  }
  el.innerHTML = `<form class="store-form" id="authForm"><div class="subtle">Sign in to publish, review, or report apps. Browsing does not require an account.</div><input class="field" name="email" type="email" autocomplete="email" placeholder="Email" aria-label="Email" required><input class="field" name="password" type="password" autocomplete="current-password" placeholder="Password (6 or more characters)" aria-label="Password" required minlength="6"><div class="row" style="margin-top:6px"><button type="button" class="button primary" data-store="signin">Sign in</button><button type="button" class="button" data-store="register">Create account</button></div></form>`;
}

async function authSubmit(form, mode) {
  if (!form || !form.reportValidity()) return;
  const email = String(form.elements.email.value).trim();
  const password = String(form.elements.password.value);
  try {
    const api = await getFirebase();
    if (mode === 'register') await api.createUserWithEmailAndPassword(api.auth, email, password);
    else await api.signInWithEmailAndPassword(api.auth, email, password);
    form.reset();
    deps.toast(mode === 'register' ? 'Account created.' : 'Signed in.');
  } catch (err) {
    deps.toast(firebaseErrorMessage(err));
  }
}

async function signOut() {
  try {
    const api = await getFirebase();
    await api.signOut(api.auth);
    deps.toast('Signed out.');
  } catch (err) {
    deps.toast(firebaseErrorMessage(err));
  }
}

// ---- My apps ----
async function renderMine() {
  const el = $('#myApps');
  if (!el) return;
  if (!user) {
    mine = [];
    el.textContent = 'Sign in to see your apps.';
    return;
  }
  try {
    const api = await getFirebase();
    mine = await AS.loadMyApps({ api, user });
    el.innerHTML = mine.length ? mine.map(a => `<div class="row between" style="margin:6px 0"><span><strong>${esc(a.name)}</strong> v${esc(a.version)} · <span class="badge">${esc(a.status)}</span></span><span class="row"><button class="button" data-store="update-start" data-id="${esc(a.id)}">Upload update</button><button class="button danger" data-store="delete-app" data-id="${esc(a.id)}">Delete</button></span></div>`).join('') : 'You have not published any apps yet.';
  } catch (err) {
    el.innerHTML = `<div class="status-error">${esc(firebaseErrorMessage(err))}</div>`;
  }
}

async function deleteMine(id) {
  const app = mine.find(a => a.id === id);
  if (!app || !window.confirm(`Delete "${app.name}" and all its files? Installed copies on devices keep working until uninstalled.`)) return;
  try {
    const api = await getFirebase();
    const { leftovers } = await AS.deleteOwnApp({ api, user, appId: id, existing: app });
    deps.toast(leftovers.length ? `Deleted, but ${leftovers.length} file(s) remain in the database.` : 'App deleted.');
  } catch (err) {
    deps.toast(err.message || firebaseErrorMessage(err));
  }
  renderMine();
  load();
}

// ---- Details and reviews ----
async function showDetails(id) {
  detailId = id;
  const r = records.find(x => x.id === id) || mine.find(x => x.id === id);
  const el = $('#storeDetail');
  if (!el || !r) return;
  const iconUrl = hasFile(r.iconFile) ? imageCache.get(imageKey(r.id, r.iconFile)) : '';
  el.innerHTML = `<div class="store-detail"><button class="button" data-store="close-details">Close</button><div class="row" style="gap:12px;align-items:flex-start"><span id="detailIcon">${safeImg(iconUrl) ? `<img class="store-icon big" alt="" src="${safeImg(iconUrl)}">` : ''}</span><div><h2>${esc(r.name)}</h2><div class="subtle">Version ${esc(r.version)} · ${esc(r.category || 'Other')} · by ${esc(r.ownerName || 'developer')}</div><p>${esc(r.description || '')}</p></div></div>`+
    `<div class="row" id="detailShots" style="flex-wrap:wrap;gap:6px"></div><div id="reviews" class="subtle">Loading reviews…</div></div>`;
  loadDetailImages(r, id);
  try {
    const api = await getFirebase();
    const reviews = await AS.loadReviews({ api, appId: id });
    const avg = reviews.length ? (reviews.reduce((s, x) => s + (x.rating || 0), 0) / reviews.length).toFixed(1) : null;
    const list = reviews.map(x => `<div class="review"><strong>${esc(x.userName || 'Reader')}</strong> · ${'★'.repeat(x.rating)}${'☆'.repeat(5 - x.rating)}<p>${esc(x.text || '')}</p></div>`).join('');
    const form = user && r.status === 'published' ? `<form class="store-form" id="reviewForm"><label class="field-label">Your rating</label><select class="field" name="rating"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select><textarea class="field" name="text" maxlength="500" placeholder="Optional review"></textarea><button class="button primary" data-store="review">Post review</button></form>` : '';
    $('#reviews').innerHTML = `<h3>Reviews${avg ? ` · ${avg} average from ${reviews.length}` : ''}</h3>${list || '<div class="subtle">No reviews yet.</div>'}${form}`;
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
    await AS.submitReview({ api, user, appId: detailId, rating: form.elements.rating.value, text: form.elements.text.value, userName: user.displayName || user.email });
    deps.toast('Review posted.');
    showDetails(detailId);
  } catch (err) {
    deps.toast(err.message || firebaseErrorMessage(err));
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
    const api = await getFirebase().catch(err => {
      throw new Error(firebaseErrorMessage(err));
    });
    const meta = await installPackage(rec, {
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
  const meta = { name: form.elements.name.value, version: form.elements.version.value, description: form.elements.description.value, category: form.elements.category.value };
  try {
    const api = await getFirebase();
    if (!api.auth.currentUser) return deps.toast('Sign in to publish an app.');
    const files = await collectSubmission(form);
    if (!files.pkg) return deps.toast('Choose a package (.html file).');
    const r = await runWithStatus('#publishStatus', ({ signal, onProgress }) =>
      AS.publishNewApp({ api, user: api.auth.currentUser, metadata: meta, ...files, onProgress, signal }));
    form.reset();
    deps.toast('Submitted for review. It appears in the catalog once a moderator approves it.');
    renderMine();
    return r;
  } catch (err) {
    deps.toast(err.name === 'AbortError' ? 'Upload cancelled.' : err.message || firebaseErrorMessage(err));
  }
}

export async function submitUpdate(form) {
  const existing = mine.find(a => a.id === updateTarget);
  if (!existing) return deps.toast('Choose an app to update first.');
  const version = window.prompt(`New version number for ${existing.name} (currently ${existing.version})`, '');
  if (!version) return;
  const meta = { name: existing.name, version, description: existing.description, category: existing.category };
  try {
    const api = await getFirebase();
    const files = await collectSubmission(form);
    if (!files.pkg) return deps.toast('Choose the new package (.html file).');
    const r = await runWithStatus('#updateStatus', ({ signal, onProgress }) =>
      AS.publishUpdate({ api, user: api.auth.currentUser, appId: updateTarget, existing, metadata: meta, ...files, onProgress, signal }));
    form.reset();
    updateTarget = null;
    $('#updateForm').classList.add('hidden');
    deps.toast(r.replacedLeftovers.length ? `Update submitted. ${r.replacedLeftovers.length} old file(s) could not be removed.` : 'Update submitted for review.');
    renderMine();
    load();
  } catch (err) {
    deps.toast(err.name === 'AbortError' ? 'Upload cancelled.' : err.message || firebaseErrorMessage(err));
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
    case 'update-cancel':
      if (kind === 'update-cancel') {
        updateTarget = null;
        $('#updateForm')?.classList.add('hidden');
      }
      return publishing?.abort();
    case 'refresh': return load();
    case 'signin': return authSubmit(b.closest('form'), 'signin');
    case 'register': return authSubmit(b.closest('form'), 'register');
    case 'signout': return signOut();
    case 'details': return showDetails(id);
    case 'close-details':
      detailId = null;
      $('#storeDetail').innerHTML = '';
      return;
    case 'review': return postReview(b.closest('form'));
    case 'report': return report(id);
    case 'update-start': {
      updateTarget = id;
      const app = mine.find(a => a.id === id);
      const box = $('#updateForm');
      if (box) {
        box.classList.remove('hidden');
        $('#updateTitle').textContent = `Upload a new version of ${app?.name || 'this app'}`;
      }
      return;
    }
    case 'delete-app': return deleteMine(id);
  }
}

async function report(id) {
  try {
    const api = await getFirebase();
    const u = api.auth.currentUser;
    if (!u) return deps.toast('Sign in to report an app.');
    await api.addDoc(api.collection(api.db, 'reports'), { appId: id, reason: 'Reported from the App Store', reporterUid: u.uid, createdAt: api.serverTimestamp() });
    deps.toast('Thank you. The report was sent to moderators.');
  } catch (err) {
    deps.toast(firebaseErrorMessage(err));
  }
}
