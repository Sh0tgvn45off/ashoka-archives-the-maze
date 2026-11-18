// Run: node --test tests/game.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLS, LIVES, MAX_LEVEL, T } from '../js/config.js';
import { Game } from '../js/game.js';
import { findPath, idx, safe } from '../js/maze.js';

const DT = 1 / 60;

function recorder() {
  const events = [];
  return { events, emit: (type, data) => events.push({ type, data }) };
}

/** Steer the player along the shortest spike-free path to a target cell. */
function steer(game, tr, tc) {
  const p = game.player;
  const path = findPath(game.grid, Math.floor(p.y), Math.floor(p.x), tr, tc, safe);
  const next = path[1] ?? path[0];
  const nx = (next % COLS) + 0.5;
  const ny = Math.floor(next / COLS) + 0.5;
  const dx = nx - p.x;
  const dy = ny - p.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d, sprint: false };
}

test('autopilot reaches the exit of every level without getting stuck (collision + corner assist)', () => {
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const { events, emit } = recorder();
    const game = new Game(emit);
    game.startRun({ startLevel: level, name: 'TEST' });
    let frames = 0;
    while (game.alive && frames < 60 * 240) {
      game.player.shield = 999; // ignore guards and gas: this test is about movement
      game.update(DT, steer(game, game.exit.r, game.exit.c));
      frames++;
    }
    const done = events.find((e) => e.type === 'levelComplete' || e.type === 'runComplete');
    assert.ok(done, `level ${level}: never reached the exit (stuck at ${game.player.x.toFixed(2)},${game.player.y.toFixed(2)})`);
  }
});

test('a guard spots a player in its cone, but not through a wall', () => {
  const game = new Game(recorder().emit);
  game.startRun({ startLevel: 1, name: 'TEST' });
  const g = game.guards[0];
  // Open corridor: put the player 3 tiles straight ahead of the guard along row 1.
  g.x = 3.5; g.y = 1.5; g.angle = 0;
  game.player.x = 6.5; game.player.y = 1.5;
  for (let c = 1; c <= 8; c++) game.grid[idx(1, c)] = T.FLOOR;
  assert.equal(game.guardSees(g, 3, 3, 0), true, 'should see straight down an open corridor');
  game.grid[idx(1, 5)] = T.WALL;
  assert.equal(game.guardSees(g, 3, 3, 0), false, 'must not see through a wall');
  game.grid[idx(1, 5)] = T.FLOOR;
  g.angle = Math.PI; // facing away
  assert.equal(game.guardSees(g, 3, 3, 0), false, 'must not see behind itself');
});

test('a seen player is chased after the notice delay, and the alert fires once', () => {
  const { events, emit } = recorder();
  const game = new Game(emit);
  game.startRun({ startLevel: 1, name: 'TEST' });
  game.guards.length = 1;
  const g = game.guards[0];
  for (let c = 1; c <= 12; c++) game.grid[idx(1, c)] = T.FLOOR;
  g.x = 10.5; g.y = 1.5; g.angle = Math.PI; g.path = []; g.waitT = 5;
  game.player.x = 7.5; game.player.y = 1.5; // 3 tiles: inside level 1's 4.5-tile vision
  game.updateGuards(DT);
  assert.equal(g.state, 'suspicious', 'first sighting should only make the guard suspicious');
  for (let i = 0; i < 40; i++) game.updateGuards(DT);
  assert.equal(g.state, 'chase');
  assert.equal(events.filter((e) => e.type === 'alert').length, 1);
});

test('gas wakes up after leaving the spawn, spreads, and kills a player who stands in it', () => {
  const { events, emit } = recorder();
  const game = new Game(emit);
  game.startRun({ startLevel: 1, name: 'TEST' });
  game.guards = [];
  // Walk until the gas triggers.
  let frames = 0;
  while (!game.gas.active && frames++ < 60 * 30) game.update(DT, steer(game, game.exit.r, game.exit.c));
  assert.ok(game.gas.active, 'gas never activated');
  assert.ok(events.some((e) => e.type === 'gasStart'));
  // Stand still: the front eventually reaches the player.
  frames = 0;
  while (game.alive && frames++ < 60 * 120) game.update(DT, { x: 0, y: 0 });
  const death = events.find((e) => e.type === 'death');
  assert.ok(death, 'standing still in the corridor should get you gassed');
  assert.equal(death.data.cause, 'gas');
  assert.equal(death.data.livesLeft, LIVES - 1);
});

test('dying after a checkpoint keeps the curiosity points collected before it', () => {
  const game = new Game(recorder().emit);
  game.startRun({ startLevel: 1, name: 'TEST' });
  game.items[0].got = true; game.levelCurio = 1; game.curioTotal = 1;
  game.saveCheckpoint();
  game.items[1].got = true; game.levelCurio = 2; game.curioTotal = 2;
  game.die('guard');
  game.retry();
  assert.equal(game.items[0].got, true);
  assert.equal(game.items[1].got, false);
  assert.equal(game.levelCurio, 1);
  assert.equal(game.curioTotal, 1);
  assert.ok(game.player.shield > 0, 'respawn should grant a short shield');
  for (const g of game.guards) {
    assert.ok(Math.hypot(g.x - game.player.x, g.y - game.player.y) > 3, 'guard respawned on top of the player');
  }
});

test('spikes kill, timers only count active play, and three deaths end the run', () => {
  const { events, emit } = recorder();
  const game = new Game(emit);
  game.startRun({ startLevel: 1, name: 'TEST' });
  game.guards = [];
  const spike = game.grid.indexOf(T.SPIKE);
  assert.ok(spike >= 0);
  for (let n = 0; n < LIVES; n++) {
    game.player.x = (spike % COLS) + 0.5;
    game.player.y = Math.floor(spike / COLS) + 0.5;
    game.update(DT, { x: 0, y: 0 });
    assert.equal(events.at(-1).data.cause, 'spike');
    if (n < LIVES - 1) game.retry();
  }
  assert.equal(events.at(-1).data.gameOver, true);
  const before = game.runTime;
  game.update(1, { x: 0, y: 0 }); // dead: the clock must not move
  assert.equal(game.runTime, before);
});
