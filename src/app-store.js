// App Store logic: submitting, withdrawing pending apps, submitting updates,
// reviews, reports, and catalog queries. No accounts are used.
//
// Access model (enforced by firebase/firestore.rules, not by this file):
//   - Anyone can submit an app. Submissions start as "pending" and are unlisted:
//     they can be read only by their random document id, never listed.
//   - Only moderators can publish, reject, or supersede apps. Published apps are
//     never changed or deleted by visitors.
//   - A visitor can withdraw an app that is still "pending", but only with its id.
//     Ids are random and are shown only to the browser that submitted the app.
//   - Chunks can be created only before their app document exists, so a finished
//     app's files cannot be overwritten. Chunks are removed with their app.
//
// Every function takes `api`, the object from getFirebase() (or a test double), so
// the sequencing can be tested without a live project. Nothing reports success until
// Firestore confirms the write. If a later step fails, chunks written by this
// operation are removed, and anything that cannot be removed is reported.
import { sha256Hex } from './install.js';
import { firebaseErrorMessage } from './firebase-client.js';
import { AssetError, fileId, deleteFile, downloadFile, imageDataUrl, uploadFile, validateImage, validatePackage, LIMITS } from './firestore-files.js';

export const CATEGORIES = Object.freeze(['Productivity', 'Games', 'Utilities', 'Education', 'Media', 'Developer tools', 'Other']);
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
const APP_ID_RE = /^[a-z0-9]{20}$/;
const APP_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const MAX_REVIEW_CHARS = 500;
export const MAX_PUBLISHER_CHARS = 40;

// Generates a random 20-character lowercase app id (rules require this shape).
export function newAppId() {
  return randomAlnum(20);
}

function randomAlnum(n) {
  const out = [];
  while (out.length < n) {
    for (const b of globalThis.crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < 252 && out.length < n) out.push(APP_ID_CHARS[b % 36]); // 252 = 36 * 7: no modulo bias
    }
  }
  return out.join('');
}

// Install ids must match install.js (lowercase, up to 64 characters). Listing keys
// from earlier builds can contain capitals, so they are normalised here.
export function installIdOf(app) {
  const k = String(app.listingKey || app.id || '');
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(k)) return k;
  return ('app-' + k.toLowerCase().replace(/[^a-z0-9-]/g, '')).slice(0, 64);
}

export function validateMetadata({ name, version, description = '', category }) {
  const n = String(name ?? '').trim();
  const v = String(version ?? '').trim();
  const d = String(description ?? '').trim();
  if (!n || n.length > 48) throw new AssetError('metadata', 'Enter an app name of up to 48 characters.');
  if (!VERSION_RE.test(v)) throw new AssetError('metadata', 'Enter a version such as 1.0.0 (letters, digits, dots, and dashes).');
  if (d.length > 500) throw new AssetError('metadata', 'The description must be 500 characters or fewer.');
  if (!CATEGORIES.includes(category)) throw new AssetError('metadata', 'Choose a category.');
  return { name: n, version: v, description: d, category };
}

export function cleanPublisherName(name) {
  return String(name ?? '').trim().slice(0, MAX_PUBLISHER_CHARS) || 'Anonymous';
}

// Validates every file before anything is written.
export function validateSubmission({ pkg, icon, screenshots = [] }) {
  if (!pkg?.bytes) throw new AssetError('missing', 'Choose a package (.html file).');
  const out = { pkg: validatePackage(pkg.bytes, pkg.name) };
  if (icon?.bytes) out.icon = validateImage('icon', icon.bytes, icon.name);
  if (screenshots.length > LIMITS.maxScreenshots) {
    throw new AssetError('too-many', `You can add up to ${LIMITS.maxScreenshots} screenshots.`);
  }
  out.screenshots = screenshots.map(s => validateImage('screenshot', s.bytes, s.name));
  return out;
}

// Tracks chunks written by one operation so they can be removed if it fails.
function tracker(api, appId) {
  const files = [];
  return {
    files,
    async upload(id, bytes, contentType, opts) {
      try {
        const desc = await uploadFile(api, { appId, id }, bytes, contentType, opts);
        files.push(desc);
        return desc;
      } catch (err) {
        if (err.partial) files.push(err.partial);
        throw err;
      }
    },
    async rollback() {
      const leftovers = [];
      for (const f of files.splice(0)) {
        try {
          await deleteFile(api, { appId, file: f });
        } catch {
          leftovers.push(f.id);
        }
      }
      return leftovers;
    },
  };
}

function requireApi(api) {
  if (!api?.db) throw new AssetError('setup', 'The App Store is not available.');
}

// Writes icons and screenshots for a submission, returning the descriptors to store.
async function uploadAssets(t, { token, icon, iconValid, screenshots, screenshotsValid, onProgress, signal }) {
  const fields = {};
  if (icon) {
    fields.iconFile = await t.upload(fileId({ kind: 'icon', token }), icon.bytes, iconValid.contentType, { onProgress: p => onProgress?.({ stage: 'icon', ...p }), signal });
  }
  if (screenshots.length) {
    fields.screenshots = [];
    for (let i = 0; i < screenshots.length; i++) {
      const id = fileId({ kind: 'screenshot', index: i + 1, token });
      fields.screenshots.push(await t.upload(id, screenshots[i].bytes, screenshotsValid[i].contentType, { onProgress: p => onProgress?.({ stage: `screenshot ${i + 1}`, ...p }), signal }));
    }
  }
  return fields;
}

// Submits an app for review. `supersedes` ({ id, listingKey }) marks an update to an
// app already in the catalog; the moderator who approves it retires the old listing.
export async function submitApp({ api, metadata, pkg, icon, screenshots = [], publisherName = '', supersedes = null, onProgress, signal }) {
  requireApi(api);
  const meta = validateMetadata(metadata);
  const valid = validateSubmission({ pkg, icon, screenshots });
  const appId = newAppId();
  const token = String(Date.now());
  const t = tracker(api, appId);
  const ref = api.doc(api.db, 'apps', appId);
  try {
    const digest = await sha256Hex(pkg.bytes);
    const pkgFile = await t.upload(fileId({ kind: 'package', version: meta.version, token }), pkg.bytes, valid.pkg.contentType, { onProgress: p => onProgress?.({ stage: 'package', ...p }), signal });
    const assets = await uploadAssets(t, { token, icon, iconValid: valid.icon, screenshots, screenshotsValid: valid.screenshots, onProgress, signal });
    const listingKey = supersedes ? supersedes.listingKey || supersedes.id : appId;
    const doc = {
      ...meta,
      packageFile: pkgFile,
      sha256: digest,
      size: pkg.bytes.byteLength,
      ...assets,
      publisherName: cleanPublisherName(publisherName),
      listingKey,
      ...(supersedes ? { supersedes: supersedes.id } : {}),
      status: 'pending',
      createdAt: api.serverTimestamp(),
      updatedAt: api.serverTimestamp(),
    };
    await api.setDoc(ref, doc);
    return { appId, listingKey, version: meta.version };
  } catch (err) {
    // If the app document was written after all, its chunks are in use: keep them.
    let written = false;
    try {
      written = (await api.getDoc(ref)).exists();
    } catch {
      written = false;
    }
    if (written) throw wrapError(err, [], 'The submission may have been saved; check its status in My apps before submitting again.');
    const leftovers = await t.rollback();
    throw wrapError(err, leftovers);
  }
}

// Removes a submission that is still pending. Chunks go first, so the app document
// never points at files that are already gone when it is removed; the chunk rule
// allows removal while the app is pending (or missing).
export async function withdrawPending({ api, appId, existing }) {
  requireApi(api);
  if (!APP_ID_RE.test(appId)) throw new AssetError('bad-path', 'Invalid app identifier.');
  if (!existing || existing.status !== 'pending') {
    throw new AssetError('not-pending', 'Only apps waiting for review can be withdrawn. Published apps are removed by moderators.');
  }
  const leftovers = [];
  for (const f of filesOf(existing)) {
    try {
      await deleteFile(api, { appId, file: f });
    } catch {
      leftovers.push(f.id);
    }
  }
  if (leftovers.length) {
    throw new AssetError('storage', `The submission was not withdrawn because ${leftovers.length} stored file(s) could not be removed. Try again.`);
  }
  await api.deleteDoc(api.doc(api.db, 'apps', appId));
  return { leftovers: [] };
}

export function filesOf(app) {
  return [app.packageFile, app.iconFile, ...(app.screenshots || [])].filter(f => f && f.id);
}

// Reviews are create-only, one per device (the review id is the device id).
export async function submitReview({ api, appId, reviewerId, rating, text = '', userName = '' }) {
  requireApi(api);
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw new AssetError('metadata', 'Choose a rating from 1 to 5.');
  const body = String(text).trim();
  if (body.length > MAX_REVIEW_CHARS) throw new AssetError('metadata', 'Reviews must be 500 characters or fewer.');
  await api.setDoc(api.doc(api.db, 'apps', appId, 'reviews', reviewerId), {
    rating: r,
    text: body,
    userName: cleanPublisherName(userName || 'Reader'),
    createdAt: api.serverTimestamp(),
  });
}

export async function loadReviews({ api, appId }) {
  const snap = await api.getDocs(api.collection(api.db, 'apps', appId, 'reviews'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Reports go to moderators. They reference only published apps (see the rules).
export async function reportApp({ api, appId, reason = 'Reported from the App Store' }) {
  requireApi(api);
  await api.addDoc(api.collection(api.db, 'reports'), {
    appId,
    reason: String(reason).slice(0, 500),
    createdAt: api.serverTimestamp(),
  });
}

export async function loadCatalog({ api, category = '' }) {
  requireApi(api);
  const clauses = [api.where('status', '==', 'published')];
  if (category) clauses.push(api.where('category', '==', category));
  const snap = await api.getDocs(api.query(api.collection(api.db, 'apps'), ...clauses));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Reads one submission by its id (pending or published). Null if it no longer exists.
export async function loadSubmission({ api, appId }) {
  requireApi(api);
  const snap = await api.getDoc(api.doc(api.db, 'apps', appId));
  return snap.exists() ? { id: appId, ...snap.data() } : null;
}

// Reads a listing's package chunks (used by the installer instead of a URL download).
export function loadPackage({ api, appId, file, expectedSize, maxBytes, onProgress, signal }) {
  return downloadFile(api, { appId, file, expectedSize, maxBytes, onProgress, signal });
}

// Reads an icon or screenshot and returns a data: URL for display.
export function loadImage({ api, appId, file, signal }) {
  return imageDataUrl(api, { appId, file, signal });
}

// Adds the step name to an error and lists files that could not be removed.
function wrapError(err, leftovers, note = '') {
  const e = err instanceof AssetError ? err : new AssetError('publish', err?.code ? firebaseErrorMessage(err) : err?.message || 'Publishing failed.');
  if (note) e.message = `${e.message} ${note}`;
  if (leftovers?.length) e.message += ` ${leftovers.length} stored file(s) could not be removed and remain in Firestore: ${leftovers.join(', ')}.`;
  e.leftovers = leftovers || [];
  return e;
}
