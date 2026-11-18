// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CELLS, COLS, MAX_LEVEL, T } from '../js/config.js';
import {
  bfs, findPath, generateMaze, idx, lineOfSight, makeRng, pickGuardSpawns, placeItems, safe, walkable,
} from '../js/maze.js';

const levels = [...Array(MAX_LEVEL).keys()];

test('mazes are deterministic per level', () => {
  for (const l of levels) {
    assert.deepEqual(generateMaze(l).grid, generateMaze(l).grid, `level ${l + 1}`);
  }
});

test('the exit is always reachable without touching a spike', () => {
  for (const l of levels) {
    const m = generateMaze(l);
    assert.ok(bfs(m.grid, m.spawn.r, m.spawn.c, safe)[idx(m.exit.r, m.exit.c)] > 0, `level ${l + 1}`);
  }
});

test('spikes never cut anything off (every tile has a spike-free route)', () => {
  for (const l of levels) {
    const m = generateMaze(l);
    const any = bfs(m.grid, m.spawn.r, m.spawn.c, walkable);
    const noSpikes = bfs(m.grid, m.spawn.r, m.spawn.c, safe);
    for (let i = 0; i < CELLS; i++) {
      if (any[i] >= 0 && m.grid[i] !== T.SPIKE) {
        assert.ok(noSpikes[i] >= 0, `level ${l + 1}: tile ${i} only reachable over a spike`);
      }
    }
  }
});

test('spikes exist, scale with level and are never clustered', () => {
  let previous = 0;
  for (const l of levels) {
    const m = generateMaze(l);
    const spikes = [];
    for (let i = 0; i < CELLS; i++) if (m.grid[i] === T.SPIKE) spikes.push([Math.floor(i / COLS), i % COLS]);
    assert.ok(spikes.length >= 4, `level ${l + 1} has only ${spikes.length} spikes`);
    assert.ok(spikes.length >= previous - 1, `level ${l + 1} has fewer spikes than the level before`);
    previous = spikes.length;
    for (let a = 0; a < spikes.length; a++) {
      for (let b = a + 1; b < spikes.length; b++) {
        const gap = Math.max(Math.abs(spikes[a][0] - spikes[b][0]), Math.abs(spikes[a][1] - spikes[b][1]));
        assert.ok(gap > 3, `level ${l + 1}: spikes ${spikes[a]} and ${spikes[b]} are adjacent`);
      }
    }
  }
});

test('curiosity points are reachable spike-free, spread out and not on hazards', () => {
  for (const l of levels) {
    const m = generateMaze(l);
    const dist = bfs(m.grid, m.spawn.r, m.spawn.c, safe);
    for (let run = 0; run < 25; run++) {
      const items = placeItems(m, 5, makeRng(run * 977 + l));
      assert.equal(items.length, 5);
      for (const p of items) {
        assert.equal(m.grid[idx(p.r, p.c)], T.FLOOR);
        assert.ok(dist[idx(p.r, p.c)] >= 10, 'too close to the spawn');
      }
      for (let a = 0; a < 5; a++) {
        for (let b = a + 1; b < 5; b++) {
          assert.ok(Math.hypot(items[a].r - items[b].r, items[a].c - items[b].c) >= 4, 'items clustered');
        }
      }
    }
  }
});

test('guards spawn far from the player by path, on safe floor', () => {
  for (const l of levels) {
    const m = generateMaze(l);
    const from = { r: 17, c: 25 };
    const dist = bfs(m.grid, from.r, from.c, walkable);
    const spawns = pickGuardSpawns(m, 10, from, makeRng(l));
    assert.equal(spawns.length, 10);
    for (const s of spawns) {
      assert.equal(m.grid[idx(s.r, s.c)], T.FLOOR);
      assert.ok(dist[idx(s.r, s.c)] >= 14, 'guard spawned too close');
    }
  }
});

test('paths avoid spikes and line of sight is blocked by walls', () => {
  const m = generateMaze(0);
  const path = findPath(m.grid, m.spawn.r, m.spawn.c, m.exit.r, m.exit.c, safe);
  assert.ok(path.length > 30);
  assert.ok(path.every((i) => m.grid[i] !== T.SPIKE && m.grid[i] !== T.WALL));
  // Two corridor cells separated by the solid outer wall never see each other.
  assert.equal(lineOfSight(m.grid, 1.5, 1.5, 1.5, 0.2), false);
  assert.equal(lineOfSight(m.grid, 1.5, 1.5, 2.5, 1.5), true);
});
