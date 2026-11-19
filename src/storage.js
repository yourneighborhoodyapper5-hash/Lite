// Package storage. Large app packages live in IndexedDB; small settings stay in
// localStorage (lightdesk-v4). Both adapters expose the same interface so the
// installer can be tested without a browser.

const DB_NAME = 'lightdesk-packages';
const DB_VERSION = 1;
const STORE_NAME = 'packages';

const request = req =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Storage request failed'));
  });

const transaction = (db, mode, run) =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const out = run(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve(out?.result);
    tx.onerror = () => reject(tx.error || new Error('Storage transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Storage transaction was aborted'));
  });

// Opens (and if needed creates) the package database.
export function openPackageDatabase(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open package storage.'));
    req.onblocked = () => reject(new Error('Package storage is blocked by another LightDesk tab. Close other tabs and reload.'));
  });
}

export function createIndexedDbPackageStore(db) {
  return {
    kind: 'indexeddb',
    get: id => transaction(db, 'readonly', s => s.get(id)),
    put: (id, value) => transaction(db, 'readwrite', s => s.put(value, id)),
    delete: id => transaction(db, 'readwrite', s => s.delete(id)),
    keys: () => transaction(db, 'readonly', s => s.getAllKeys()),
    close: () => db.close(),
  };
}

// Same interface, kept in memory. Used by tests and by the desktop when
// IndexedDB cannot be opened, so the rest of the system still runs.
export function createMemoryPackageStore() {
  const items = new Map();
  return {
    kind: 'memory',
    get: async id => items.get(id),
    put: async (id, value) => {
      items.set(id, structuredClone(value));
    },
    delete: async id => {
      items.delete(id);
    },
    keys: async () => [...items.keys()],
    close() {},
  };
}
