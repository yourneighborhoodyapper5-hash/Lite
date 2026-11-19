// Device-local App Store state. There are no accounts, so this stands in for
// "My apps" and for review ownership:
//   - deviceId: a random id for this browser, used as the review document id
//   - submissions: this browser's submissions (app id, listing key, name, version)
//   - reviewed: app ids this browser has reviewed
//   - submitTimes: when this browser last submitted (for the rate limit)
// Everything here is per browser and can be cleared by the user. It is a usability
// feature, not a security boundary: anyone can clear it or use another browser.
const KEY = 'lightdesk-store-v1';
export const MAX_SUBMISSIONS_PER_DAY = 5;
export const MIN_SUBMIT_GAP_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomToken(length) {
  const out = [];
  while (out.length < length) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < 248 && out.length < length) out.push(ALPHABET[b % ALPHABET.length]); // rejection sampling: no modulo bias
    }
  }
  return out.join('');
}

function read() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && typeof d === 'object') {
      return {
        deviceId: typeof d.deviceId === 'string' ? d.deviceId : '',
        submissions: Array.isArray(d.submissions) ? d.submissions : [],
        reviewed: Array.isArray(d.reviewed) ? d.reviewed : [],
        submitTimes: Array.isArray(d.submitTimes) ? d.submitTimes : [],
      };
    }
  } catch {}
  return { deviceId: '', submissions: [], reviewed: [], submitTimes: [] };
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function deviceId() {
  const s = read();
  if (s.deviceId) return s.deviceId;
  const id = randomToken(24);
  write({ ...s, deviceId: id });
  return id;
}

// Returns { ok: true } or { ok: false, message }.
export function submitAllowance(now = Date.now()) {
  const s = read();
  const recent = s.submitTimes.filter(t => typeof t === 'number' && now - t < DAY_MS);
  if (recent.length >= MAX_SUBMISSIONS_PER_DAY) {
    return { ok: false, message: `This browser can submit up to ${MAX_SUBMISSIONS_PER_DAY} apps in 24 hours. Try again later.` };
  }
  const last = Math.max(0, ...recent);
  if (last && now - last < MIN_SUBMIT_GAP_MS) {
    return { ok: false, message: 'Wait a minute before submitting another app.' };
  }
  return { ok: true };
}

export function recordSubmission(entry, now = Date.now()) {
  const s = read();
  const submitTimes = [...s.submitTimes.filter(t => typeof t === 'number' && now - t < DAY_MS), now];
  const submissions = [{ ...entry, submittedAt: now }, ...s.submissions.filter(x => x.appId !== entry.appId)].slice(0, 50);
  write({ ...s, submitTimes, submissions });
}

export function mySubmissions() {
  return read().submissions;
}

export function forgetSubmission(appId) {
  const s = read();
  write({ ...s, submissions: s.submissions.filter(x => x.appId !== appId) });
}

export function hasReviewed(appId) {
  return read().reviewed.includes(appId);
}

export function markReviewed(appId) {
  const s = read();
  if (!s.reviewed.includes(appId)) write({ ...s, reviewed: [...s.reviewed, appId].slice(-500) });
}
