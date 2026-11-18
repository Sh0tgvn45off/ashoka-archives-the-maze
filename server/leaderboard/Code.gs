/**
 * Ashoka Archives — The Maze · shared leaderboard
 * Google Apps Script web app backed by the leaderboard Google Sheet.
 *
 *   GET  …/exec        → top-10 array            (old and new game clients)
 *   GET  …/exec?v=2    → { ok, version: 2, entries }
 *   POST …/exec        body (text/plain JSON), one of:
 *                        { entry: {...} }        one finished run (new game)
 *                        { entries: [...] }      runs queued while offline (new game)
 *                        [ ... ]                 the old game's full top-10 list
 *                      → { ok, version: 2, accepted, duplicates, rejected, entries }
 *
 * A POST can only ADD runs. Nothing a client sends can delete, reorder or replace the board
 * (the previous script cleared the sheet and wrote whatever it received, so one device with
 * a stale cache could wipe everyone's scores).
 *
 * Sheets:
 *   runs         every accepted run, append-only: the source of truth
 *   leaderboard  best run per name, top 10, rebuilt from "runs" after every write
 *
 * Deploy (keeps the /exec URL the game already uses):
 *   1. Paste this file over Code.gs in the Apps Script editor and save.
 *   2. Run setup() once (creates "runs" from the current board and formats both sheets).
 *   3. Deploy → Manage deployments → the existing web app → ✏️ Edit →
 *      Version: "New version" → Deploy.   (Execute as: Me · Who has access: Anyone)
 *
 * Moderation: delete the offending row(s) in "runs", then run rebuildBoard().
 */

const SHEET_ID = '1KsKLTeP3P8DnCKOAMMC0R4549PrGUoAiohJEv3K_D7c';
const BOARD_SHEET = 'leaderboard';
const RUNS_SHEET = 'runs';
const BOARD_HEADERS = ['playerName', 'timeMs', 'curiosity', 'rating', 'dateISO'];
const RUN_HEADERS = BOARD_HEADERS.concat(['receivedISO', 'source']);
// Names and dates are stored as plain text so "007" stays "007" and nothing is read as a formula.
const BOARD_FORMATS = ['@', '0', '0', '@', '@'];
const RUN_FORMATS = ['@', '0', '0', '@', '@', '@', '@'];

const BOARD_SIZE = 10;
const TOTAL_CURIOSITY = 25;
// Fastest physically possible run: the shortest spawn→exit routes of all five mazes add up to
// 462 tiles, which takes 60.8 s even sprinting non-stop (7.6 tiles/s). Update if the mazes change.
const MIN_TIME_MS = 60 * 1000;
const MAX_TIME_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_POST = 25;
const MAX_POSTS_PER_MINUTE = 30;
const RATING_VALUE = { A: 3, B: 2, C: 1 };
const NAME_PATTERN = /^[A-Z0-9][A-Z0-9 ._-]{1,15}$/;
const CACHE_KEY = 'board-v2';
const CACHE_SECONDS = 60;

// ── Web app ──────────────────────────────────────────────────────────────────
function doGet(e) {
  const entries = readBoardCached_();
  if (e && e.parameter && e.parameter.v === '2') return json_({ ok: true, version: 2, entries: entries });
  return json_(entries);
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    return json_({ ok: false, version: 2, error: 'invalid-json' });
  }

  let candidates;
  let source;
  if (Array.isArray(payload)) { candidates = payload; source = 'legacy'; }
  else if (payload && Array.isArray(payload.entries)) { candidates = payload.entries; source = 'queued'; }
  else if (payload && payload.entry) { candidates = [payload.entry]; source = 'game'; }
  else return json_({ ok: false, version: 2, error: 'no-entries' });

  const clean = [];
  let rejected = Math.max(0, candidates.length - MAX_ENTRIES_PER_POST);
  candidates.slice(0, MAX_ENTRIES_PER_POST).forEach(function (c) {
    const n = normalize_(c);
    if (n) clean.push(n); else rejected++;
  });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return json_({ ok: false, version: 2, error: 'busy' });
  try {
    if (!allowPost_()) return json_({ ok: false, version: 2, error: 'rate-limited' });
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const runsSheet = ensureRunsSheet_(ss);
    const runs = readRuns_(runsSheet);
    const seen = {};
    runs.forEach(function (r) { seen[key_(r)] = true; });
    const fresh = [];
    clean.forEach(function (r) {
      const k = key_(r);
      if (!seen[k]) { seen[k] = true; fresh.push(r); }
    });
    const received = new Date().toISOString();
    if (fresh.length) appendRuns_(runsSheet, fresh.map(function (r) { return toRunRow_(r, received, source); }));
    const board = rank_(runs.concat(fresh));
    if (fresh.length) writeBoard_(ss, board);
    CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(board), CACHE_SECONDS);
    return json_({
      ok: true, version: 2, accepted: fresh.length, duplicates: clean.length - fresh.length, rejected: rejected, entries: board,
    });
  } finally {
    lock.releaseLock();
  }
}

// ── Run these from the editor ────────────────────────────────────────────────
/** One-time setup: creates "runs" (seeded from the current board) and formats both sheets. */
function setup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const runsSheet = ensureRunsSheet_(ss);
  const boardSheet = ensureSheet_(ss, BOARD_SHEET, BOARD_HEADERS).sheet;
  applyColumnFormats_(runsSheet, RUN_FORMATS);
  applyColumnFormats_(boardSheet, BOARD_FORMATS);
  rebuildBoard();
  Logger.log('Setup complete: %s runs, %s on the board.', readRuns_(runsSheet).length, readBoard_(ss).length);
}

/** Recompute the top 10 from "runs" (use after deleting rows there). */
function rebuildBoard() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const board = rank_(readRuns_(ensureRunsSheet_(ss)));
    writeBoard_(ss, board);
    CacheService.getScriptCache().remove(CACHE_KEY);
    Logger.log('Board rebuilt with %s entries.', board.length);
    return board;
  } finally {
    lock.releaseLock();
  }
}

// ── Validation & ranking ─────────────────────────────────────────────────────
/** A clean run, or null when anything about it is invalid or implausible. */
function normalize_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const playerName = String(raw.playerName == null ? '' : raw.playerName)
    .toUpperCase().replace(/[^A-Z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!NAME_PATTERN.test(playerName)) return null;

  const timeMs = Math.round(Number(raw.timeMs));
  if (!isFinite(timeMs) || timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS) return null;

  const curiosity = Number(raw.curiosity);
  if (!isFinite(curiosity) || Math.floor(curiosity) !== curiosity || curiosity < 0 || curiosity > TOTAL_CURIOSITY) return null;

  let rating = String(raw.rating == null ? '' : raw.rating).toUpperCase().trim();
  if (rating === '') rating = 'C';
  if (!RATING_VALUE[rating]) return null;
  if (rating === 'A' && curiosity !== TOTAL_CURIOSITY) return null; // A means every Curiosity Point

  return { playerName: playerName, timeMs: timeMs, curiosity: curiosity, rating: rating, dateISO: isoDate_(raw.dateISO) };
}

function isoDate_(raw) {
  // Sheets turns ISO strings into Date objects; accept both.
  const d = raw && typeof raw.getTime === 'function' ? new Date(raw.getTime()) : new Date(String(raw == null ? '' : raw));
  const t = d.getTime();
  if (!isFinite(t) || t > Date.now() + 864e5 || t < Date.UTC(2024, 0, 1)) return new Date().toISOString();
  return d.toISOString();
}

function key_(r) {
  return [r.playerName, r.timeMs, r.curiosity, r.rating].join('|');
}

/** Rating first (A > B > C), then fastest time, then most curiosity, then earliest. */
function compare_(a, b) {
  return (RATING_VALUE[b.rating] - RATING_VALUE[a.rating])
    || (a.timeMs - b.timeMs)
    || (b.curiosity - a.curiosity)
    || (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0);
}

/** Best run per name, sorted, top 10. */
function rank_(list) {
  const best = {};
  list.forEach(function (e) {
    const current = best[e.playerName];
    if (!current || compare_(e, current) < 0) best[e.playerName] = e;
  });
  return Object.keys(best).map(function (k) { return best[k]; }).sort(compare_).slice(0, BOARD_SIZE);
}

// ── Sheet access ─────────────────────────────────────────────────────────────
function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  let created = false;
  if (!sheet) {
    sheet = ss.insertSheet(name);
    created = true;
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return { sheet: sheet, created: created };
}

/** The "runs" sheet. When it is first created it is seeded with the current board, so nothing is lost. */
function ensureRunsSheet_(ss) {
  const result = ensureSheet_(ss, RUNS_SHEET, RUN_HEADERS);
  if (result.created) {
    const existing = readBoard_(ss);
    const now = new Date().toISOString();
    if (existing.length) appendRuns_(result.sheet, existing.map(function (r) { return toRunRow_(r, now, 'import'); }));
  }
  return result.sheet;
}

function readRows_(sheet, width) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, width).getValues();
}

function rowToRun_(row) {
  return normalize_({ playerName: row[0], timeMs: row[1], curiosity: row[2], rating: row[3], dateISO: row[4] });
}

function readRuns_(sheet) {
  return readRows_(sheet, RUN_HEADERS.length).map(rowToRun_).filter(Boolean);
}

function readBoard_(ss) {
  const sheet = ss.getSheetByName(BOARD_SHEET);
  if (!sheet) return [];
  return rank_(readRows_(sheet, BOARD_HEADERS.length).map(rowToRun_).filter(Boolean));
}

function readBoardCached_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (err) { /* fall through to the sheet */ }
  }
  const board = readBoard_(SpreadsheetApp.openById(SHEET_ID));
  cache.put(CACHE_KEY, JSON.stringify(board), CACHE_SECONDS);
  return board;
}

function toRunRow_(r, receivedISO, source) {
  return [r.playerName, r.timeMs, r.curiosity, r.rating, r.dateISO, receivedISO, source];
}

function appendRuns_(sheet, rows) {
  const range = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, RUN_HEADERS.length);
  range.setNumberFormats(rows.map(function () { return RUN_FORMATS; }));
  range.setValues(rows);
}

function writeBoard_(ss, board) {
  const sheet = ensureSheet_(ss, BOARD_SHEET, BOARD_HEADERS).sheet;
  sheet.clearContents();
  const rows = [BOARD_HEADERS].concat(board.map(function (r) {
    return [r.playerName, r.timeMs, r.curiosity, r.rating, r.dateISO];
  }));
  const range = sheet.getRange(1, 1, rows.length, BOARD_HEADERS.length);
  range.setNumberFormats(rows.map(function () { return BOARD_FORMATS; }));
  range.setValues(rows);
  sheet.getRange(1, 1, 1, BOARD_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function applyColumnFormats_(sheet, formats) {
  formats.forEach(function (f, i) {
    sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat(f);
  });
}

/** Global write budget per minute (checked inside the lock). */
function allowPost_() {
  const cache = CacheService.getScriptCache();
  const key = 'posts-' + Math.floor(Date.now() / 60000);
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 120);
  return count <= MAX_POSTS_PER_MINUTE;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
