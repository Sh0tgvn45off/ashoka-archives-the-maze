// Runs server/leaderboard/Code.gs (the Apps Script web app) against an in-memory fake of
// SpreadsheetApp / LockService / CacheService / ContentService.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../server/leaderboard/Code.gs', import.meta.url), 'utf8');

function fakeSheet() {
  const sheet = {
    rows: [],
    getLastRow() { return this.rows.length; },
    getMaxRows() { return 1000; },
    clearContents() { this.rows = []; },
    setFrozenRows() {},
    getRange(row, col, numRows = 1, numCols = 1) {
      const self = this;
      const range = {
        setValues(values) {
          values.forEach((vals, i) => {
            const r = row - 1 + i;
            while (self.rows.length <= r) self.rows.push([]);
            vals.forEach((v, j) => { self.rows[r][col - 1 + j] = v; });
          });
          return range;
        },
        getValues() {
          return Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => {
            const v = (self.rows[row - 1 + i] || [])[col - 1 + j];
            return v === undefined ? '' : v;
          }));
        },
        setNumberFormats() { return range; },
        setNumberFormat() { return range; },
        setFontWeight() { return range; },
      };
      return range;
    },
  };
  return sheet;
}

function setupWorld({ legacyBoard = [] } = {}) {
  const sheets = new Map();
  const board = fakeSheet();
  board.rows.push(['playerName', 'timeMs', 'curiosity', 'rating', 'dateISO']);
  legacyBoard.forEach((r) => board.rows.push(r));
  sheets.set('leaderboard', board);
  const cache = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = fakeSheet(); sheets.set(n, s); return s; },
  };
  const ctx = {
    SpreadsheetApp: { openById: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (content) => ({ content, setMimeType() { return this; } }),
    },
    Logger: { log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const get = (v) => JSON.parse(ctx.doGet({ parameter: v ? { v } : {} }).content);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).content);
  return { ctx, sheets, cache, get, post };
}

const run = (playerName, timeMs, curiosity, rating, dateISO = '2026-11-01T10:00:00.000Z') => ({ playerName, timeMs, curiosity, rating, dateISO });
const EXPLORER = ['EXPLORER', 302242, 5, 'B', new Date('2026-04-27T06:42:27.320Z')]; // what the live sheet holds today

test('GET keeps the old array shape and adds a versioned shape', () => {
  const w = setupWorld({ legacyBoard: [EXPLORER] });
  const arr = w.get();
  assert.ok(Array.isArray(arr));
  assert.deepEqual(arr[0], { playerName: 'EXPLORER', timeMs: 302242, curiosity: 5, rating: 'B', dateISO: '2026-04-27T06:42:27.320Z' });
  const v2 = w.get('2');
  assert.equal(v2.version, 2);
  assert.equal(v2.entries.length, 1);
});

test('the first POST seeds "runs" from the existing board, so nothing is lost', () => {
  const w = setupWorld({ legacyBoard: [EXPLORER] });
  const res = w.post({ entry: run('LAZ', 250000, 25, 'A') });
  assert.equal(res.ok, true);
  assert.equal(res.accepted, 1);
  assert.deepEqual(res.entries.map((e) => e.playerName), ['LAZ', 'EXPLORER']);
  const runs = w.sheets.get('runs').rows;
  assert.equal(runs.length, 3); // header + imported + new
  assert.equal(runs[1][6], 'import');
  assert.equal(runs[2][6], 'game');
  assert.deepEqual(w.get().map((e) => e.playerName), ['LAZ', 'EXPLORER']);
});

test('nothing a client posts can wipe the board', () => {
  const w = setupWorld({ legacyBoard: [EXPLORER] });
  for (const body of [[], [run('X', 1, 0, 'C')], { entries: [] }, '[]', 'null', '{"entry":null}']) w.post(body);
  assert.deepEqual(w.get().map((e) => e.playerName), ['EXPLORER']);
});

test("the old game's full-list POST only adds its new run (no duplicates)", () => {
  const w = setupWorld({ legacyBoard: [EXPLORER] });
  const current = w.get();
  const res = w.post([...current, run('ASHOKA', 400000, 12, 'B')]);
  assert.equal(res.accepted, 1);
  assert.equal(res.duplicates, 1);
  const again = w.post([...current, run('ASHOKA', 400000, 12, 'B')]);
  assert.equal(again.accepted, 0);
  assert.equal(w.sheets.get('runs').rows.length, 3);
});

test('invalid or implausible runs are rejected', () => {
  const w = setupWorld();
  const res = w.post({
    entries: [
      run('==', 300000, 5, 'B'),            // no usable name
      run('-DASH', 300000, 5, 'B'),         // must start with a letter or digit
      run('SPEEDY', 5000, 5, 'B'),          // faster than physically possible
      run('LIAR', 300000, 20, 'A'),         // A requires all 25 points
      run('GREEDY', 300000, 30, 'B'),       // more points than exist
      run('ODD', 300000, 5, 'Z'),           // unknown rating
      'not an object',
      run('OK NAME', 300000, 5, 'B'),
    ],
  });
  assert.equal(res.accepted, 1);
  assert.equal(res.rejected, 7);
  assert.deepEqual(res.entries.map((e) => e.playerName), ['OK NAME']);
  assert.deepEqual(w.post('{nope'), { ok: false, version: 2, error: 'invalid-json' });
});

test('names are cleaned to plain text before storage', () => {
  const w = setupWorld();
  const res = w.post({ entry: run('=hyperlink("x")', 300000, 5, 'B') });
  assert.equal(res.entries[0].playerName, 'HYPERLINKX');
  assert.equal(w.sheets.get('runs').rows[1][0], 'HYPERLINKX');
});

test('ranking: best run per name, rating first, then time, top 10', () => {
  const w = setupWorld();
  const entries = [];
  for (let i = 0; i < 12; i++) entries.push(run(`P${i}`, 200000 + i * 1000, 10, 'C'));
  entries.push(run('P0', 500000, 25, 'A'));   // P0's A beats its faster C
  entries.push(run('FAST', 90000, 3, 'B'));
  const res = w.post({ entries });
  assert.equal(res.entries.length, 10);
  assert.deepEqual(res.entries.slice(0, 3).map((e) => [e.playerName, e.rating]), [['P0', 'A'], ['FAST', 'B'], ['P1', 'C']]);
});

test('rate limit: at most 30 writes per minute', () => {
  const w = setupWorld();
  let last;
  for (let i = 0; i < 31; i++) last = w.post({ entry: run(`R${i}`, 300000 + i, 1, 'C') });
  assert.deepEqual(last, { ok: false, version: 2, error: 'rate-limited' });
});

test('setup() is idempotent and rebuildBoard() reflects deleted runs', () => {
  const w = setupWorld({ legacyBoard: [EXPLORER] });
  w.ctx.setup();
  w.ctx.setup();
  const runs = w.sheets.get('runs');
  assert.equal(runs.rows.length, 2); // header + one import, not two
  w.post({ entry: run('RUDE NAME', 200000, 5, 'B') });
  assert.equal(w.get()[0].playerName, 'RUDE NAME');
  runs.rows = runs.rows.filter((r) => r[0] !== 'RUDE NAME'); // moderator deletes the row
  w.ctx.rebuildBoard();
  assert.deepEqual(w.get().map((e) => e.playerName), ['EXPLORER']);
});
