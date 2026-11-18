// ─── Maze generation & grid search ──────────────────────────────────────────
// Pure functions, no DOM: tested directly by tests/maze.test.mjs.
// Grid: Uint8Array of tile codes, index = row * COLS + col.
import { COLS, ROWS, CELLS, T } from './config.js';

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];

export const idx = (r, c) => r * COLS + c;
export const rowOf = (i) => (i / COLS) | 0;
export const colOf = (i) => i % COLS;
export const inBounds = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;

/** Anything that isn't a wall (spikes are walkable, and deadly). */
export const walkable = (t) => t !== T.WALL;
/** Walkable without stepping on a spike. Guards and fairness checks use this. */
export const safe = (t) => t !== T.WALL && t !== T.SPIKE;

/** Small, fast, seedable PRNG so every player gets the same maze per level. */
export function makeRng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  const next = () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0;
    return s / 0x100000000;
  };
  return {
    next,
    int: (a, b) => a + Math.floor(next() * (b - a)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

/** Breadth-first distances from (sr, sc). -1 = unreachable. */
export function bfs(grid, sr, sc, pass = walkable, maxDist = Infinity) {
  const dist = new Int16Array(CELLS).fill(-1);
  const queue = new Int32Array(CELLS);
  let head = 0;
  let tail = 0;
  const start = idx(sr, sc);
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const d = dist[cur];
    if (d >= maxDist) continue;
    const r = rowOf(cur);
    const c = cur - r * COLS;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const ni = nr * COLS + nc;
      if (dist[ni] !== -1 || !pass(grid[ni])) continue;
      dist[ni] = d + 1;
      queue[tail++] = ni;
    }
  }
  return dist;
}

/** Shortest path of cell indices from (sr, sc) to (tr, tc), inclusive. [] if none. */
export function findPath(grid, sr, sc, tr, tc, pass = safe) {
  const start = idx(sr, sc);
  const goal = idx(tr, tc);
  if (start === goal) return [start];
  const prev = new Int32Array(CELLS).fill(-2);
  const queue = new Int32Array(CELLS);
  let head = 0;
  let tail = 0;
  prev[start] = -1;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) break;
    const r = rowOf(cur);
    const c = cur - r * COLS;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const ni = nr * COLS + nc;
      if (prev[ni] !== -2 || !pass(grid[ni])) continue;
      prev[ni] = cur;
      queue[tail++] = ni;
    }
  }
  if (prev[goal] === -2) return [];
  const path = [];
  for (let n = goal; n !== -1; n = prev[n]) path.push(n);
  return path.reverse();
}

/** True when no wall lies on the straight line between two points (tile units). */
export function lineOfSight(grid, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const r = Math.floor(y0 + dy * t);
    const c = Math.floor(x0 + dx * t);
    if (!inBounds(r, c) || grid[idx(r, c)] === T.WALL) return false;
  }
  return true;
}

function openNeighbourCount(grid, r, c) {
  let n = 0;
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (inBounds(nr, nc) && grid[idx(nr, nc)] !== T.WALL) n++;
  }
  return n;
}

function reachableCount(grid, spawn, pass) {
  const dist = bfs(grid, spawn.r, spawn.c, pass);
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (dist[i] >= 0) n++;
  return { n, dist };
}

const SEEDS = [0xa1b2, 0xc3d4, 0xe5f6, 0x1a2b, 0x3c4d];
// Exit position rotates around the maze per level (spawn is always top-left).
const EXITS = [
  [ROWS - 2, COLS - 2], // L1 bottom-right
  [ROWS - 2, 1],        // L2 bottom-left
  [1, COLS - 2],        // L3 top-right
  [ROWS - 2, 25],       // L4 bottom-centre
  [17, COLS - 2],       // L5 mid-right
];

const mazeCache = new Map();

/**
 * Deterministic maze for a level (same for every player, so times are comparable).
 * Braided recursive backtracker: many loops, few dead ends, multiple routes to the exit.
 * Spikes are placed so they never cut anything off: every tile reachable before a spike is
 * placed stays reachable without stepping on any spike.
 */
export function generateMaze(levelIndex) {
  if (mazeCache.has(levelIndex)) {
    const m = mazeCache.get(levelIndex);
    return { ...m, grid: m.grid.slice() };
  }
  const rng = makeRng(SEEDS[levelIndex % SEEDS.length] * 7919 + levelIndex * 1000003);
  const grid = new Uint8Array(CELLS).fill(T.WALL);

  // 1. Iterative recursive-backtracker on the odd-cell lattice.
  const seen = new Uint8Array(CELLS);
  const stack = [[1, 1]];
  seen[idx(1, 1)] = 1;
  grid[idx(1, 1)] = T.FLOOR;
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const options = [];
    for (const [dr, dc] of [[0, 2], [0, -2], [2, 0], [-2, 0]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr > 0 && nr < ROWS - 1 && nc > 0 && nc < COLS - 1 && !seen[idx(nr, nc)]) options.push([nr, nc, dr, dc]);
    }
    if (!options.length) { stack.pop(); continue; }
    const [nr, nc, dr, dc] = rng.pick(options);
    seen[idx(nr, nc)] = 1;
    grid[idx(r + dr / 2, c + dc / 2)] = T.FLOOR;
    grid[idx(nr, nc)] = T.FLOOR;
    stack.push([nr, nc]);
  }

  // 2. Braid: open ~65% of dead ends into a neighbouring corridor.
  const deadEnds = [];
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (grid[idx(r, c)] === T.FLOOR && openNeighbourCount(grid, r, c) === 1) deadEnds.push([r, c]);
    }
  }
  for (const [r, c] of rng.shuffle(deadEnds).slice(0, Math.floor(deadEnds.length * 0.65))) {
    for (const [dr, dc] of rng.shuffle(DIRS)) {
      const wr = r + dr;
      const wc = c + dc;
      const nr = r + dr * 2;
      const nc = c + dc * 2;
      if (wr > 0 && wr < ROWS - 1 && wc > 0 && wc < COLS - 1 && grid[idx(wr, wc)] === T.WALL &&
          nr > 0 && nr < ROWS - 1 && nc > 0 && nc < COLS - 1 && grid[idx(nr, nc)] === T.FLOOR) {
        grid[idx(wr, wc)] = T.FLOOR;
        break;
      }
    }
  }

  // 3. A few extra cross-links (more on later levels) to create loops.
  const crossLinks = 12 + levelIndex * 2;
  for (let added = 0, tries = 0; added < crossLinks && tries < 1000; tries++) {
    const r = rng.int(1, ROWS - 1);
    const c = rng.int(1, COLS - 1);
    if (grid[idx(r, c)] !== T.WALL) continue;
    if (openNeighbourCount(grid, r, c) >= 2) { grid[idx(r, c)] = T.FLOOR; added++; }
  }

  // 4. Spawn (top-left) and exit (rotates per level).
  const spawn = { r: 1, c: 1 };
  const [er, ec] = EXITS[levelIndex % EXITS.length];
  const exit = { r: er, c: ec };
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = er + dr;
      const cc = ec + dc;
      if (rr > 0 && rr < ROWS - 1 && cc > 0 && cc < COLS - 1) grid[idx(rr, cc)] = T.FLOOR;
    }
  }
  grid[idx(er, ec)] = T.EXIT;
  for (let dr = 0; dr <= 1; dr++) for (let dc = 0; dc <= 1; dc++) grid[idx(1 + dr, 1 + dc)] = T.FLOOR;

  // 5. Connectivity safety net (the braided maze is always connected, but never trust it).
  if (bfs(grid, spawn.r, spawn.c)[idx(er, ec)] < 0) {
    let r = spawn.r;
    let c = spawn.c;
    while (r !== er || c !== ec) {
      if (r < er) r++; else if (r > er) r--; else if (c < ec) c++; else c--;
      if (grid[idx(r, c)] === T.WALL) grid[idx(r, c)] = T.FLOOR;
    }
  }

  // 6. Spikes: on corridor tiles away from spawn/exit, never clustered, never blocking.
  const spikeTarget = Math.min(5 + levelIndex * 2, 13);
  const candidates = [];
  for (let r = 2; r < ROWS - 2; r++) {
    for (let c = 2; c < COLS - 2; c++) {
      if (grid[idx(r, c)] !== T.FLOOR) continue;
      if (Math.hypot(r - spawn.r, c - spawn.c) < 6) continue;
      if (Math.hypot(r - er, c - ec) < 4) continue;
      if (openNeighbourCount(grid, r, c) >= 2) candidates.push([r, c]);
    }
  }
  let base = reachableCount(grid, spawn, safe).n;
  const spikes = [];
  for (const [r, c] of rng.shuffle(candidates)) {
    if (spikes.length >= spikeTarget) break;
    if (spikes.some(([sr, sc]) => Math.max(Math.abs(sr - r), Math.abs(sc - c)) <= 3)) continue;
    grid[idx(r, c)] = T.SPIKE;
    const { n, dist } = reachableCount(grid, spawn, safe);
    if (n === base - 1 && dist[idx(er, ec)] >= 0) {
      base = n;
      spikes.push([r, c]);
    } else {
      grid[idx(r, c)] = T.FLOOR;
    }
  }

  const maze = { grid, spawn, exit, levelIndex };
  mazeCache.set(levelIndex, { ...maze, grid: grid.slice() });
  return maze;
}

/**
 * Curiosity Point positions: reachable without touching spikes, spread out across the maze,
 * away from the spawn and the exit. `rng` varies per run so routes differ between runs.
 */
export function placeItems(maze, count, rng) {
  const { grid, spawn, exit } = maze;
  const dist = bfs(grid, spawn.r, spawn.c, safe);
  const candidates = [];
  for (let i = 0; i < CELLS; i++) {
    if (grid[i] !== T.FLOOR || dist[i] < 10) continue;
    const r = rowOf(i);
    const c = i - r * COLS;
    if (Math.hypot(r - exit.r, c - exit.c) < 4) continue;
    candidates.push({ r, c });
  }
  const shuffled = rng.shuffle(candidates);
  for (const minGap of [10, 8, 6, 4, 0]) {
    const picked = [];
    for (const p of shuffled) {
      if (picked.every((q) => Math.hypot(q.r - p.r, q.c - p.c) >= minGap)) picked.push(p);
      if (picked.length === count) return picked;
    }
  }
  return shuffled.slice(0, count);
}

/** Guard start tiles: far (by path) from `from`, spread apart, never on spikes. */
export function pickGuardSpawns(maze, count, from, rng, minPath = 14) {
  const dist = bfs(maze.grid, from.r, from.c, walkable);
  const candidates = [];
  for (let i = 0; i < CELLS; i++) {
    if (maze.grid[i] !== T.FLOOR || dist[i] < minPath) continue;
    candidates.push({ r: rowOf(i), c: colOf(i) });
  }
  const shuffled = rng.shuffle(candidates);
  for (const minGap of [7, 5, 3, 0]) {
    const picked = [];
    for (const p of shuffled) {
      if (picked.every((q) => Math.hypot(q.r - p.r, q.c - p.c) >= minGap)) picked.push(p);
      if (picked.length === count) return picked;
    }
  }
  return shuffled.slice(0, count);
}
