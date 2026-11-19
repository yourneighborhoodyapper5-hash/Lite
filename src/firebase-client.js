// Firebase loader and error mapping for LightDesk.
// The SDK (version pinned below) is loaded only when the App Store needs it.
// The App Store uses Firestore only, and visitors never sign in: Firebase
// Authentication is not loaded by the page. (Moderators approve apps with
// custom claims set outside the page; see firebase/README.md.)
// The web config is public by design; security comes from the Firestore rules
// in firebase/, not from keeping this config secret.

export const FIREBASE_VERSION = '13.4.0';
const BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;

// Copied from the project brief. The API key must be the full 39-character value.
export const firebaseConfig = {
  apiKey: 'AIzaSyA9LgxDNBDY5BPjwhBbldaHVoMAYI9y19E',
  authDomain: 'peak-app-storage.firebaseapp.com',
  projectId: 'peak-app-storage',
  messagingSenderId: '420331576022',
  appId: '1:420331576022:web:f82e4b90fa3c4a72160777',
};

let cached = null;

// Resolves to one object with the SDK functions plus app and db.
export function getFirebase() {
  if (cached) return cached;
  cached = (async () => {
    const [appSdk, dbSdk] = await Promise.all([
      import(BASE + 'firebase-app.js'),
      import(BASE + 'firebase-firestore.js'),
    ]);
    const app = appSdk.initializeApp(firebaseConfig);
    return {
      ...dbSdk,
      app,
      db: dbSdk.getFirestore(app),
    };
  })();
  return cached.catch(err => {
    cached = null;
    throw err;
  });
}

const KNOWN = {
  'auth/invalid-api-key': 'Firebase configuration is invalid (API key).',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Firebase configuration is invalid (API key).',
  'auth/email-already-in-use': 'An account already exists for that email address.',
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/invalid-email': 'That email address is not valid.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'Could not reach Firebase. Check your connection.',
  'auth/unauthorized-domain': 'This site is not authorized for Firebase sign-in. Add its domain in Firebase Authentication settings.',
  'permission-denied': 'Firebase denied this request. The app may already be removed, or the request was not allowed by the security rules.',
  'unavailable': 'Firebase is unavailable right now. Try again shortly.',
  'not-found': 'That item no longer exists.',
  'resource-exhausted': 'The Firestore quota for this Firebase project has been reached.',
  'invalid-argument': 'Firestore rejected the data. It may be too large.',
  'deadline-exceeded': 'Firestore took too long to respond. Try again.',
};

// Turns Firebase and network errors into messages the user can act on.
export function firebaseErrorMessage(err) {
  const code = err?.code || '';
  if (KNOWN[code]) return KNOWN[code];
  const msg = err?.message || '';
  if (/Failed to fetch|dynamically imported module|NetworkError|Load failed/i.test(msg)) {
    return 'Could not load Firebase. Check your connection.';
  }
  return `Firebase error${code ? ' (' + code + ')' : ''}: ${msg || 'unknown error'}`;
}
