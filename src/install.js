// Real application installation.
//
// An install reports success only after all of these succeed, in order:
//   1. the listing passes validateRecord()
//   2. the package is loaded (downloaded from a URL, or read from Firestore chunks via
//      loadPackage), with real byte progress, and capped in size
//   3. its size and SHA-256 match the listing
//   4. it decodes as UTF-8 and looks like an HTML application
//   5. it is written to package storage
//   6. the installation is registered (and persisted)
// If step 5 or 6 fails, the previous package is restored so nothing is half-installed.

export const MAX_PACKAGE_BYTES = 300 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const HTML_RE = /<\s*(!doctype|html|head|body|div|main|section|script|style)\b/i;

export class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

export function validateRecord(rec, base = globalThis.location?.href ?? 'http://localhost/') {
  const fail = message => {
    throw new InstallError('invalid-record', message);
  };
  if (!rec || typeof rec !== 'object') fail('The app listing is missing.');
  if (typeof rec.id !== 'string' || !ID_RE.test(rec.id)) fail('The app has an invalid identifier.');
  if (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > 80) fail('The app name is missing or too long.');
  if (typeof rec.version !== 'string' || !rec.version.trim() || rec.version.length > 32) fail('The app version is missing or invalid.');
  if (typeof rec.sha256 !== 'string' || !SHA_RE.test(rec.sha256)) {
    fail('This listing has no valid package checksum, so it cannot be installed safely.');
  }
  if (!Number.isInteger(rec.size) || rec.size < 1 || rec.size > MAX_PACKAGE_BYTES) {
    fail(`The package must be between 1 byte and ${MAX_PACKAGE_BYTES / 1024} KB.`);
  }
  if (rec.packageFile !== undefined) {
    // Package stored as Firestore chunks (the App Store).
    const f = rec.packageFile;
    if (!f || typeof f.id !== 'string' || !f.id || !Number.isInteger(f.chunks) || f.chunks < 1 || f.chunks > 8) {
      fail('This listing has an invalid package reference.');
    }
    return true;
  }
  if (typeof rec.packageUrl !== 'string') fail('This listing has no package location.');
  let url;
  try {
    url = new URL(rec.packageUrl, base);
  } catch {
    fail('The package location is not a valid URL.');
  }
  const localDev = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localDev) fail('Packages must be served over HTTPS.');
  return true;
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Streams the package, reporting real byte counts and enforcing the size cap
// while reading (not only from the Content-Length header).
export async function downloadPackage(url, { fetchImpl = globalThis.fetch, expectedSize = 0, maxBytes = MAX_PACKAGE_BYTES, onProgress, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { signal, cache: 'no-store', credentials: 'omit' });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new InstallError('network', 'Could not reach the package server. Check your connection and try again.');
  }
  if (!res.ok) throw new InstallError('http', `The package server responded with ${res.status}. Nothing was installed.`);
  const declared = Number(res.headers.get('content-length')) || expectedSize || 0;
  if (declared > maxBytes) throw new InstallError('too-large', 'The package is larger than the allowed size. Nothing was installed.');

  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new InstallError('too-large', 'The package is larger than the allowed size. Nothing was installed.');
    onProgress?.({ loaded: bytes.byteLength, total: declared || bytes.byteLength });
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > maxBytes) {
      await reader.cancel();
      throw new InstallError('too-large', 'The package is larger than the allowed size. Nothing was installed.');
    }
    chunks.push(value);
    onProgress?.({ loaded, total: declared || expectedSize || 0 });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

export function decodePackage(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InstallError('not-text', 'The package is not valid UTF-8 text. Nothing was installed.');
  }
  if (!HTML_RE.test(text)) throw new InstallError('not-html', 'The package is not an HTML application. Nothing was installed.');
  return text;
}

function storageError(err) {
  if (err?.name === 'QuotaExceededError') {
    return new InstallError('quota', 'Not enough browser storage to install this app. Remove an app or free space, then try again.');
  }
  return new InstallError('storage', `Could not save the app package: ${err?.message || 'unknown error'}`);
}

// deps: { fetchImpl, loadPackage, store, registry, onProgress, signal }
//   loadPackage: async ({ expectedSize, maxBytes, onProgress, signal }) => Uint8Array.
//                Required for listings with packageFile (Firestore chunks).
//   store:    { get(id), put(id, value), delete(id) }        (storage.js)
//   registry: { get(id), put(meta), remove(id) }; put/remove throw if they cannot persist
export async function installPackage(record, { fetchImpl, loadPackage, store, registry, onProgress, signal } = {}) {
  validateRecord(record);
  const existing = registry.get(record.id);
  if (existing && existing.version === record.version && existing.sha256 === record.sha256) {
    throw new InstallError('already-installed', `${record.name} ${record.version} is already installed.`);
  }

  let bytes;
  if (record.packageFile) {
    if (typeof loadPackage !== 'function') throw new InstallError('no-loader', 'This listing needs the App Store to load its package. Nothing was installed.');
    bytes = await loadPackage({ expectedSize: record.size, maxBytes: MAX_PACKAGE_BYTES, onProgress, signal });
  } else {
    bytes = await downloadPackage(record.packageUrl, { fetchImpl, expectedSize: record.size, onProgress, signal });
  }
  if (bytes.byteLength !== record.size) {
    throw new InstallError('size-mismatch', 'The downloaded package size does not match the listing. Nothing was installed.');
  }
  const digest = await sha256Hex(bytes);
  if (digest !== record.sha256) {
    throw new InstallError('checksum', 'The package failed its checksum. Nothing was installed.');
  }
  const html = decodePackage(bytes);

  const previous = await store.get(record.id);
  try {
    await store.put(record.id, { html, version: record.version, sha256: record.sha256 });
  } catch (err) {
    throw storageError(err);
  }

  const meta = {
    id: record.id,
    name: record.name.trim(),
    description: String(record.description || '').slice(0, 500),
    version: record.version,
    sha256: record.sha256,
    size: record.size,
    installedAt: Date.now(),
  };
  try {
    registry.put(meta);
  } catch (err) {
    await restorePackage(store, record.id, previous);
    throw storageError(err);
  }
  return meta;
}

async function restorePackage(store, id, previous) {
  try {
    if (previous) await store.put(id, previous);
    else await store.delete(id);
  } catch (err) {
    console.error('[install] could not restore previous package', id, err);
  }
}

// Removes the registration first. If the package bytes cannot be deleted
// afterwards, the app is still uninstalled and the leftover data is reported.
export async function uninstallPackage(id, { store, registry }) {
  if (!registry.get(id)) throw new InstallError('not-installed', 'That app is not installed.');
  registry.remove(id);
  try {
    await store.delete(id);
  } catch (err) {
    throw new InstallError('cleanup', `The app was removed, but its stored package could not be deleted (${err?.message || 'unknown error'}).`);
  }
}
