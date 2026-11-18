// ─── Leaderboard ────────────────────────────────────────────────────────────
// Top 10, kept on this device and synced with the shared Google Sheets board
// (Apps Script source: server/leaderboard/Code.gs).
// Everything coming back from the sheet is validated before use: anyone can write to it.
//
// Sync rules:
// - The upgraded script (version 2) merges what it receives, so the game sends only its own
//   new runs. Runs that fail to upload wait in a queue and go up on the next sync.
// - The old script replaced the whole sheet with whatever was posted. Against it the game
//   posts the merged board, and only straight after a successful download, never a list
//   built from this device alone (that is how the shared board used to get wiped).
import { LEADERBOARD_URL, STORAGE_KEYS, TOTAL_CURIOSITY } from './config.js';

const RATING_VALUE = { A: 3, B: 2, C: 1 };
const MAX_PENDING = 20;
export const RATINGS = {
  A: { label: 'Legendary Explorer', color: '#ff9f1c', message: 'Perfect run. No deaths. All 25 Curiosity Points collected. The Archives yield every secret.' },
  B: { label: 'Skilled Navigator', color: '#ffd23f', message: 'Escaped without dying — but some knowledge was left behind. The Archives have more.' },
  C: { label: 'Archive Survivor', color: '#5aa2ff', message: 'You escaped, but death visited along the way. The Archives remember every stumble.' },
};

/** Uppercase letters, digits, space and . _ - only; starts with a letter or digit; 16 characters max. */
export function cleanName(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').replace(/^[^A-Z0-9]+/, '')
    .replace(/\s+/g, ' ').trim().slice(0, 16);
}

export function sanitize(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e && typeof e === 'object' ? {
      playerName: cleanName(e.playerName),
      timeMs: Math.round(Number(e.timeMs)),
      curiosity: Math.max(0, Math.min(TOTAL_CURIOSITY, Math.round(Number(e.curiosity) || 0))),
      rating: RATING_VALUE[e.rating] ? e.rating : 'C',
      dateISO: typeof e.dateISO === 'string' ? e.dateISO.slice(0, 40) : '',
    } : null))
    .filter((e) => e && e.playerName.length >= 2 && Number.isFinite(e.timeMs) && e.timeMs > 0);
}

/** Rating first (A > B > C), then fastest time, then most curiosity. */
export function compare(a, b) {
  return (RATING_VALUE[b.rating] - RATING_VALUE[a.rating]) || (a.timeMs - b.timeMs) || (b.curiosity - a.curiosity);
}

/** Best entry per name, sorted, top 10. */
export function rank(list) {
  const best = new Map();
  for (const e of list) {
    if (!best.has(e.playerName) || compare(e, best.get(e.playerName)) < 0) best.set(e.playerName, e);
  }
  return [...best.values()].sort(compare).slice(0, 10);
}

export function tierName(i) {
  return ['Legendary', 'Grandmaster', 'Pro'][i] || 'Explorer';
}

export function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const sameRun = (a, b) => a.playerName === b.playerName && a.timeMs === b.timeMs && a.curiosity === b.curiosity && a.rating === b.rating;

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function loadLocal() {
  return rank(sanitize(readJSON(STORAGE_KEYS.leaderboard)));
}

function saveLocal(list) {
  try {
    localStorage.setItem(STORAGE_KEYS.leaderboard, JSON.stringify(list));
    const lines = ['ASHOKA ARCHIVES — EXPLORER LEADERBOARD', `Updated: ${new Date().toLocaleString()}`, '',
      'POS | TIER         | NAME             | TIME      | CURIOSITY | RANK', '-'.repeat(68)];
    list.forEach((e, i) => lines.push(`${String(i + 1).padEnd(4)}| ${tierName(i).toUpperCase().padEnd(13)}| ${e.playerName.padEnd(17)}| ${formatTime(e.timeMs).padEnd(10)}| ${String(e.curiosity).padStart(2)}/${TOTAL_CURIOSITY}     | ${e.rating}`));
    localStorage.setItem(STORAGE_KEYS.leaderboardText, lines.join('\n'));
  } catch { /* storage unavailable */ }
}

export function loadPending() {
  return sanitize(readJSON(STORAGE_KEYS.pending));
}

function savePending(list) {
  try {
    if (list.length) localStorage.setItem(STORAGE_KEYS.pending, JSON.stringify(list.slice(-MAX_PENDING)));
    else localStorage.removeItem(STORAGE_KEYS.pending);
  } catch { /* storage unavailable */ }
}

function queue(entry) {
  const pending = loadPending();
  if (!pending.some((p) => sameRun(p, entry))) pending.push(entry);
  savePending(pending);
}

// ── Network ──────────────────────────────────────────────────────────────────
/** Download the shared board. Also tells us which version of the script is deployed. */
async function download() {
  const res = await fetch(`${LEADERBOARD_URL}?v=2`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return { version: 1, entries: sanitize(data) };
  if (data && data.version === 2 && Array.isArray(data.entries)) return { version: 2, entries: sanitize(data.entries) };
  throw new Error('Unexpected leaderboard response');
}

async function post(body) {
  const res = await fetch(LEADERBOARD_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** Upload queued runs (if any) and return the merged board, or null when offline. */
async function sync() {
  try {
    const remote = await download();
    const pending = loadPending();
    let board = remote.entries;
    if (pending.length && remote.version === 2) {
      const res = await post(pending.length === 1 ? { entry: pending[0] } : { entries: pending });
      const data = await res.json();
      if (!data || data.ok !== true || !Array.isArray(data.entries)) throw new Error((data && data.error) || 'Rejected');
      board = sanitize(data.entries);
      savePending([]);
    } else if (pending.length) {
      board = rank([...remote.entries, ...pending]);
      await post(board);
      savePending([]);
    }
    const merged = rank([...board, ...loadLocal()]);
    saveLocal(merged);
    return merged;
  } catch {
    return null;
  }
}

/** Fetch the shared board (uploading any queued runs first) and merge it with this device's results. */
export async function fetchBoard() {
  const merged = await sync();
  return merged ? { entries: merged, online: true } : { entries: loadLocal(), online: false };
}

/** Record a ranked run locally, then upload it in the background. */
export function submitRun(result) {
  const entry = {
    playerName: cleanName(result.name), timeMs: Math.round(result.timeMs), curiosity: result.curio,
    rating: result.rating, dateISO: new Date().toISOString(),
  };
  const local = rank([...loadLocal(), entry]);
  saveLocal(local);
  queue(entry);
  const done = fetchBoard();
  return { entries: local, entry, sync: done };
}

export function isNameTakenByOther(name, savedName) {
  return name !== savedName && loadLocal().some((e) => e.playerName === name);
}
