// App Store logic: publishing, updating, deleting, reviews, catalog queries.
//
// Everything is stored in Firestore: app metadata in apps/{appId}, and package
// and image bytes as chunk documents (see firestore-files.js).
//
// Every function takes `api`, the object from getFirebase() (or a test double),
// so the sequencing can be tested without a live project. Nothing here reports
// success until the Firestore write has completed. If a later step fails, the
// chunks already written in this operation are removed, and that is reported.
import { sha256Hex } from './install.js';
import { AssetError, fileId, deleteFile, downloadFile, imageDataUrl, uploadFile, validateImage, validatePackage, LIMITS } from './firestore-files.js';

export const CATEGORIES = Object.freeze(['Productivity', 'Games', 'Utilities', 'Education', 'Media', 'Developer tools', 'Other']);
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;

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

// Validates every file before anything is uploaded.
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

// Tracks files written by one operation so they can be removed if it fails.
function tracker(api, appId) {
  const files = [];
  return {
    files,
    async upload(uid, id, bytes, contentType, opts) {
      try {
        const desc = await uploadFile(api, { uid, appId, id }, bytes, contentType, opts);
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

function requireUser(user) {
  if (!user?.uid) throw new AssetError('auth', 'Sign in to continue.');
}

// Writes icons and screenshots for an app, returning the fields to store.
async function uploadAssets(t, { uid, token, icon, iconValid, screenshots, screenshotsValid, onProgress, signal }) {
  const fields = {};
  if (icon) {
    fields.iconFile = await t.upload(uid, fileId({ kind: 'icon', token }), icon.bytes, iconValid.contentType, { onProgress: p => onProgress?.({ stage: 'icon', ...p }), signal });
  }
  if (screenshots.length) {
    fields.screenshots = [];
    for (let i = 0; i < screenshots.length; i++) {
      const id = fileId({ kind: 'screenshot', index: i + 1, token });
      fields.screenshots.push(await t.upload(uid, id, screenshots[i].bytes, screenshotsValid[i].contentType, { onProgress: p => onProgress?.({ stage: `screenshot ${i + 1}`, ...p }), signal }));
    }
  }
  return fields;
}

// Publishes a new app for review (status "pending").
export async function publishNewApp({ api, user, metadata, pkg, icon, screenshots = [], onProgress, signal }) {
  requireUser(user);
  const meta = validateMetadata(metadata);
  const valid = validateSubmission({ pkg, icon, screenshots });
  const uid = user.uid;
  const ref = api.doc(api.collection(api.db, 'apps'));
  const appId = ref.id;
  const token = String(Date.now());
  const t = tracker(api, appId);
  let appWritten = false;
  try {
    const digest = await sha256Hex(pkg.bytes);
    const pkgRes = await t.upload(uid, fileId({ kind: 'package', version: meta.version, token }), pkg.bytes, valid.pkg.contentType, { onProgress: p => onProgress?.({ stage: 'package', ...p }), signal });
    const assets = await uploadAssets(t, { uid, token, icon, iconValid: valid.icon, screenshots, screenshotsValid: valid.screenshots, onProgress, signal });
    const doc = {
      ...meta,
      packageFile: pkgRes,
      sha256: digest,
      size: pkg.bytes.byteLength,
      ...assets,
      ownerUid: uid,
      ownerName: String(user.displayName || 'Developer').slice(0, 80),
      status: 'pending',
      createdAt: api.serverTimestamp(),
      updatedAt: api.serverTimestamp(),
    };
    await api.setDoc(ref, doc);
    appWritten = true;
    await api.setDoc(api.doc(api.db, 'apps', appId, 'versions', meta.version), versionRecord(api, uid, meta, pkgRes, digest, pkg.bytes.byteLength));
    return { appId, version: meta.version };
  } catch (err) {
    // Remove the chunks only if the app document no longer references them.
    // If the document cannot be removed, it still points at these files, so keep them.
    if (appWritten) {
      try {
        await api.deleteDoc(ref);
      } catch {
        throw wrapError(err, [], 'The app record could not be removed, so its stored files were kept. Check the App Store in Firebase.');
      }
    }
    const leftovers = await t.rollback();
    throw wrapError(err, leftovers);
  }
}

function versionRecord(api, uid, meta, pkgRes, digest, size) {
  return {
    version: meta.version,
    packageFile: pkgRes,
    sha256: digest,
    size,
    ownerUid: uid,
    createdAt: api.serverTimestamp(),
  };
}

// Publishes a new version of an app the user owns. The app returns to "pending"
// until a moderator approves it, so the catalog shows the approved version in
// the meantime only if it is still published (see docs: updates are re-reviewed).
export async function publishUpdate({ api, user, appId, existing, metadata, pkg, icon, screenshots = [], onProgress, signal }) {
  requireUser(user);
  if (!existing || existing.ownerUid !== user.uid) throw new AssetError('not-owner', 'You can only update apps you published.');
  const meta = validateMetadata(metadata);
  if (meta.version === existing.version) throw new AssetError('metadata', 'Choose a new version number for the update.');
  const valid = validateSubmission({ pkg, icon, screenshots });
  const token = String(Date.now());
  const t = tracker(api, appId);
  const ref = api.doc(api.db, 'apps', appId);
  const oldFiles = [];
  let appUpdated = false;
  try {
    const digest = await sha256Hex(pkg.bytes);
    const pkgRes = await t.upload(user.uid, fileId({ kind: 'package', version: meta.version, token }), pkg.bytes, valid.pkg.contentType, { onProgress: p => onProgress?.({ stage: 'package', ...p }), signal });
    const assets = await uploadAssets(t, { uid: user.uid, token, icon, iconValid: valid.icon, screenshots, screenshotsValid: valid.screenshots, onProgress, signal });
    if (assets.iconFile && existing.iconFile) oldFiles.push(existing.iconFile);
    if (assets.screenshots && Array.isArray(existing.screenshots)) oldFiles.push(...existing.screenshots.filter(s => s?.id));
    await api.updateDoc(ref, {
      ...meta,
      packageFile: pkgRes,
      sha256: digest,
      size: pkg.bytes.byteLength,
      ...assets,
      status: 'pending',
      updatedAt: api.serverTimestamp(),
    });
    appUpdated = true;
    await api.setDoc(api.doc(api.db, 'apps', appId, 'versions', meta.version), versionRecord(api, user.uid, meta, pkgRes, digest, pkg.bytes.byteLength));
  } catch (err) {
    if (appUpdated) {
      // The app now points at the new files. Keep them; the version record is the only missing part.
      throw wrapError(err, [], 'The app was updated, but its version history record could not be written. The new files were kept.');
    }
    const leftovers = await t.rollback();
    throw wrapError(err, leftovers);
  }
  // The new files are live. Remove the replaced ones; report anything that stays.
  const replacedLeftovers = [];
  for (const f of oldFiles) {
    try {
      await deleteFile(api, { appId, file: f });
    } catch {
      replacedLeftovers.push(f.id);
    }
  }
  return { version: meta.version, replacedLeftovers };
}

// Deletes an app the user owns: its versions and metadata first, then its stored files.
export async function deleteOwnApp({ api, user, appId, existing }) {
  requireUser(user);
  if (!existing || existing.ownerUid !== user.uid) throw new AssetError('not-owner', 'You can only delete apps you published.');
  const versions = await api.getDocs(api.collection(api.db, 'apps', appId, 'versions'));
  const files = new Map();
  const add = f => {
    if (f?.id) files.set(f.id, f);
  };
  for (const v of versions.docs) add(v.data().packageFile);
  add(existing.packageFile);
  add(existing.iconFile);
  for (const s of existing.screenshots || []) add(s);
  for (const v of versions.docs) await api.deleteDoc(v.ref);
  await api.deleteDoc(api.doc(api.db, 'apps', appId));
  const leftovers = [];
  for (const f of files.values()) {
    try {
      await deleteFile(api, { appId, file: f });
    } catch {
      leftovers.push(f.id);
    }
  }
  return { leftovers };
}

// Reads a listing's package chunks (used by the installer instead of a URL download).
export function loadPackage({ api, appId, file, expectedSize, maxBytes, onProgress, signal }) {
  return downloadFile(api, { appId, file, expectedSize, maxBytes, onProgress, signal });
}

// Reads an icon or screenshot and returns a data: URL for display.
export function loadImage({ api, appId, file, signal }) {
  return imageDataUrl(api, { appId, file, signal });
}

export async function submitReview({ api, user, appId, rating, text = '', userName = '' }) {
  requireUser(user);
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) throw new AssetError('metadata', 'Choose a rating from 1 to 5.');
  const body = String(text).trim();
  if (body.length > 500) throw new AssetError('metadata', 'Reviews must be 500 characters or fewer.');
  await api.setDoc(api.doc(api.db, 'apps', appId, 'reviews', user.uid), {
    rating: r,
    text: body,
    userName: String(userName || 'Reader').slice(0, 80),
    updatedAt: api.serverTimestamp(),
  });
}

export async function loadReviews({ api, appId }) {
  const snap = await api.getDocs(api.collection(api.db, 'apps', appId, 'reviews'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function loadCatalog({ api, category = '' }) {
  const clauses = [api.where('status', '==', 'published')];
  if (category) clauses.push(api.where('category', '==', category));
  const snap = await api.getDocs(api.query(api.collection(api.db, 'apps'), ...clauses));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function loadMyApps({ api, user }) {
  requireUser(user);
  const snap = await api.getDocs(api.query(api.collection(api.db, 'apps'), api.where('ownerUid', '==', user.uid)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Adds the step name to an error and lists files that could not be removed.
function wrapError(err, leftovers, note = '') {
  const e = err instanceof AssetError ? err : new AssetError('publish', err?.message || 'Publishing failed.');
  if (note) e.message = `${e.message} ${note}`;
  if (leftovers?.length) e.message += ` ${leftovers.length} stored file(s) could not be removed and remain in Firestore: ${leftovers.join(', ')}.`;
  e.leftovers = leftovers || [];
  return e;
}
