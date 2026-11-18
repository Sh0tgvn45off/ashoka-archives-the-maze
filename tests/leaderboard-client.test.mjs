// Sync rules of js/leaderboard.js against fake old (v1) and new (v2) leaderboard scripts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { submitRun, fetchBoard, loadPending, cleanName } = await import('../js/leaderboard.js');

let calls;
let server;
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  return server(url, opts);
};
const reply = (data) => ({ ok: true, json: async () => data });
const offline = () => { throw new TypeError('Failed to fetch'); };
const remoteBoard = [{ playerName: 'EXPLORER', timeMs: 302242, curiosity: 5, rating: 'B', dateISO: '2026-04-27T06:42:27.320Z' }];
const result = { name: 'laz', timeMs: 250000.4, curio: 25, rating: 'A' };

beforeEach(() => { store.clear(); calls = []; });

test('v2 script: only the new run is posted, and the returned board is used', async () => {
  server = (url, opts) => (opts.method === 'POST'
    ? reply({ ok: true, version: 2, entries: [{ playerName: 'LAZ', timeMs: 250000, curiosity: 25, rating: 'A' }, ...remoteBoard] })
    : reply({ ok: true, version: 2, entries: remoteBoard }));
  const { sync } = submitRun(result);
  const { entries, online } = await sync;
  assert.equal(online, true);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(Array.isArray(posts[0].body), false);
  assert.equal(posts[0].body.entry.playerName, 'LAZ');
  assert.equal(posts[0].body.entry.timeMs, 250000);
  assert.deepEqual(entries.map((e) => e.playerName), ['LAZ', 'EXPLORER']);
  assert.equal(loadPending().length, 0);
});

test('offline: nothing is posted and the run waits in the queue', async () => {
  server = offline;
  const { sync } = submitRun(result);
  const { online } = await sync;
  assert.equal(online, false);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(loadPending().length, 1);
});

test('queued runs upload on the next sync', async () => {
  server = offline;
  await submitRun(result).sync;
  server = (url, opts) => (opts.method === 'POST'
    ? reply({ ok: true, version: 2, entries: [{ playerName: 'LAZ', timeMs: 250000, curiosity: 25, rating: 'A' }] })
    : reply({ ok: true, version: 2, entries: [] }));
  calls = [];
  const { online } = await fetchBoard();
  assert.equal(online, true);
  assert.equal(calls.filter((c) => c.method === 'POST')[0].body.entry.playerName, 'LAZ');
  assert.equal(loadPending().length, 0);
});

test('a rejected upload stays queued', async () => {
  server = (url, opts) => (opts.method === 'POST' ? reply({ ok: false, version: 2, error: 'busy' }) : reply({ ok: true, version: 2, entries: [] }));
  const { online } = await submitRun(result).sync;
  assert.equal(online, false);
  assert.equal(loadPending().length, 1);
});

test('old script: the full merged board is posted, never a device-only list', async () => {
  server = (url, opts) => (opts.method === 'POST' ? reply('ok') : reply(remoteBoard));
  await submitRun(result).sync;
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(Array.isArray(post.body));
  assert.deepEqual(post.body.map((e) => e.playerName).sort(), ['EXPLORER', 'LAZ']);
});

test('names must start with a letter or digit', () => {
  assert.equal(cleanName('  -.laz_99!! '), 'LAZ_99');
  assert.equal(cleanName('=sum(a1)'), 'SUMA1');
});
