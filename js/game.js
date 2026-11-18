// ─── Game simulation ────────────────────────────────────────────────────────
// Owns the world state and rules. No DOM: the app shell calls update(dt, input) only while
// the game is actually running, and listens to emitted events to drive UI and audio.
import {
  CELLS, CHAOS, COLS, CURIOSITY_PER_LEVEL, GUARD, LEVELS, LIVES, MAX_LEVEL, PLAYER, ROWS, T, TOTAL_CURIOSITY,
} from './config.js';
import { KNOWLEDGE } from './knowledge.js';
import {
  bfs, colOf, findPath, generateMaze, idx, inBounds, lineOfSight, makeRng, pickGuardSpawns, placeItems, rowOf,
  safe, walkable,
} from './maze.js';

const TAU = Math.PI * 2;
const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Game {
  constructor(emit = () => {}) {
    this.emit = emit;
    this.level = 1;
    this.chaos = false;
    this.preview = true;
    this.time = 0;
    this.mazeVersion = 0;
  }

  /** Difficulty numbers for the current level (chaos overrides them). */
  get diff() { return this.chaos ? { ...LEVELS[this.level - 1], ...CHAOS } : LEVELS[this.level - 1]; }
  /** Zone presentation (name, palette, story) for the current level. */
  get zone() { return LEVELS[this.level - 1]; }

  // ── Run & level lifecycle ──────────────────────────────────────────────────
  startRun({ startLevel = 1, chaos = false, name = 'EXPLORER' } = {}) {
    this.chaos = chaos;
    this.startLevel = startLevel;
    this.ranked = !chaos && startLevel === 1;
    this.name = name;
    this.level = startLevel;
    this.deaths = 0;
    this.runTime = 0;
    this.curioTotal = 0;
    this.finished = false;
    this.runSeed = (Math.random() * 0x7fffffff) | 0;
    this.loadLevel();
  }

  /** Menu backdrop: the maze alone, no actors, nothing updates. */
  loadPreview(level = 1) {
    this.preview = true;
    this.level = level;
    this.chaos = false;
    this.applyMaze(generateMaze(level - 1));
    this.items = [];
    this.guards = [];
    this.player = null;
    this.gas = emptyGas();
    this.alive = false;
  }

  applyMaze(maze) {
    this.grid = maze.grid;
    this.spawn = maze.spawn;
    this.exit = maze.exit;
    this.spawnDist = bfs(this.grid, this.spawn.r, this.spawn.c, walkable);
    this.mazeVersion++;
  }

  loadLevel() {
    this.preview = false;
    const maze = generateMaze(this.level - 1);
    this.applyMaze(maze);
    const rng = makeRng(this.runSeed + this.level * 7717);
    this.items = placeItems(maze, CURIOSITY_PER_LEVEL, rng).map((p, i) => ({
      ...KNOWLEDGE[i], r: p.r, c: p.c, got: false, phase: rng.next() * TAU,
    }));
    this.levelTime = 0;
    this.levelCurio = 0;
    this.levelDeaths = 0;
    this.checkpoint = null;
    this.completed = false;
    this.resetActors(null);
  }

  /** Place the player (spawn or checkpoint), spawn guards far away, reset the gas. */
  resetActors(at) {
    const from = at || { r: this.spawn.r, c: this.spawn.c, x: this.spawn.c + 0.5, y: this.spawn.r + 0.5 };
    this.player = {
      x: from.x, y: from.y, face: 1, dirX: 1, dirY: 0, moving: false, sprinting: false, anim: 0,
      stamina: PLAYER.staminaMax, regenWait: 0, exhausted: 0, shield: at ? PLAYER.respawnShield : 0,
    };
    const rng = makeRng(this.runSeed + this.level * 131 + this.deaths * 17 + (at ? 9 : 0));
    this.guards = pickGuardSpawns(this, this.diff.guards, { r: from.r, c: from.c }, rng, at ? 10 : 14)
      .map((s) => newGuard(s, rng));
    this.gas = emptyGas();
    this.alive = true;
  }

  nextLevel() {
    this.level++;
    this.loadLevel();
  }

  /** After a death with lives left: back to the checkpoint (or the start of the level). */
  retry() {
    const cp = this.checkpoint;
    if (cp) {
      this.items.forEach((it, i) => { it.got = cp.got[i]; });
      this.curioTotal += cp.levelCurio - this.levelCurio;
      this.levelCurio = cp.levelCurio;
    } else {
      this.curioTotal -= this.levelCurio;
      this.levelCurio = 0;
      this.items.forEach((it) => { it.got = false; });
    }
    this.resetActors(cp ? { r: cp.r, c: cp.c, x: cp.x, y: cp.y } : null);
  }

  /** R: start the level over (no death counted; level progress and level time reset). */
  restartLevel() {
    this.curioTotal -= this.levelCurio;
    this.levelCurio = 0;
    this.items.forEach((it) => { it.got = false; });
    this.checkpoint = null;
    this.levelTime = 0;
    this.resetActors(null);
  }

  saveCheckpoint() {
    if (!this.alive || !this.player) return false;
    const r = Math.floor(this.player.y);
    const c = Math.floor(this.player.x);
    const i = idx(r, c);
    if (this.grid[i] !== T.FLOOR || this.gas.cells[i]) {
      this.emit('checkpointDenied');
      return false;
    }
    this.checkpoint = { x: c + 0.5, y: r + 0.5, r, c, got: this.items.map((it) => it.got), levelCurio: this.levelCurio };
    this.emit('checkpoint', this.checkpoint);
    return true;
  }

  result() {
    const rating = this.deaths === 0 && this.curioTotal >= TOTAL_CURIOSITY ? 'A' : this.deaths === 0 ? 'B' : 'C';
    return {
      name: this.name, timeMs: Math.round(this.runTime), curio: this.curioTotal, deaths: this.deaths,
      rating, ranked: this.ranked, chaos: this.chaos, startLevel: this.startLevel,
    };
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  update(dt, input) {
    if (!this.alive || this.preview) return;
    this.time += dt;
    this.runTime += dt * 1000;
    this.levelTime += dt * 1000;
    this.updatePlayer(dt, input);
    if (!this.alive) return;
    this.updateGuards(dt);
    if (!this.alive) return;
    this.updateGas(dt);
  }

  updatePlayer(dt, input) {
    const p = this.player;
    let mx = input.x || 0;
    let my = input.y || 0;
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }
    const moving = mag > 0.12;

    // Stamina: drains while sprinting, refills after a short rest, locks out when emptied.
    if (p.exhausted > 0) {
      p.exhausted = Math.max(0, p.exhausted - dt);
      p.sprinting = false;
    } else if (input.sprint && moving && p.stamina > 0) {
      p.sprinting = true;
      p.stamina = Math.max(0, p.stamina - dt);
      p.regenWait = PLAYER.regenDelay;
      if (p.stamina === 0) {
        p.sprinting = false;
        p.exhausted = PLAYER.exhaustedTime;
        this.emit('exhausted');
      }
    } else {
      p.sprinting = false;
      if (p.regenWait > 0) p.regenWait -= dt;
      else p.stamina = Math.min(PLAYER.staminaMax, p.stamina + PLAYER.staminaRegen * dt);
    }
    if (p.shield > 0) p.shield = Math.max(0, p.shield - dt);

    p.moving = moving;
    if (moving) {
      const speed = PLAYER.speed * (p.sprinting ? PLAYER.sprintMult : 1);
      this.movePlayer(mx * speed * dt, my * speed * dt);
      if (Math.abs(mx) > 0.1) p.face = mx > 0 ? 1 : -1;
      p.dirX = mx;
      p.dirY = my;
      p.anim = (p.anim + dt * (p.sprinting ? 11 : 7)) % 4;
    }

    const i = idx(Math.floor(p.y), Math.floor(p.x));
    const tile = this.grid[i];
    if (tile === T.SPIKE) { this.die('spike'); return; }
    if (tile === T.EXIT) { this.completeLevel(); return; }
    for (const item of this.items) {
      if (!item.got && Math.hypot(item.c + 0.5 - p.x, item.r + 0.5 - p.y) < PLAYER.pickupRadius) {
        item.got = true;
        this.levelCurio++;
        this.curioTotal++;
        this.emit('pickup', item);
        break; // one card at a time
      }
    }
  }

  hits(x, y) {
    const R = PLAYER.radius;
    for (const [cx, cy] of [[x - R, y - R], [x + R, y - R], [x - R, y + R], [x + R, y + R]]) {
      const r = Math.floor(cy);
      const c = Math.floor(cx);
      if (!inBounds(r, c) || this.grid[idx(r, c)] === T.WALL) return true;
    }
    return false;
  }

  /** Sub-stepped movement (no wall tunnelling) with corner assist. */
  movePlayer(dx, dy) {
    const p = this.player;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / 0.08));
    const sx = dx / steps;
    const sy = dy / steps;
    let blockedX = false;
    let blockedY = false;
    for (let s = 0; s < steps; s++) {
      if (sx) { if (!this.hits(p.x + sx, p.y)) p.x += sx; else blockedX = true; }
      if (sy) { if (!this.hits(p.x, p.y + sy)) p.y += sy; else blockedY = true; }
    }
    // Pushing into a wall while slightly off a corridor's centre line slides you into it,
    // so turning into side corridors doesn't snag on corners.
    if (blockedX && Math.abs(dx) >= Math.abs(dy)) this.assist('x', Math.sign(dx), dist);
    if (blockedY && Math.abs(dy) >= Math.abs(dx)) this.assist('y', Math.sign(dy), dist);
  }

  assist(axis, dir, amount) {
    const p = this.player;
    const R = PLAYER.radius + 0.06;
    if (axis === 'x') {
      const lane = Math.round(p.y - 0.5) + 0.5;
      const off = lane - p.y;
      if (Math.abs(off) < 0.005 || Math.abs(off) > 0.48) return;
      const ahead = Math.floor(p.x + dir * R);
      if (!inBounds(Math.floor(lane), ahead) || !walkable(this.grid[idx(Math.floor(lane), ahead)])) return;
      const step = Math.sign(off) * Math.min(Math.abs(off), amount);
      if (!this.hits(p.x, p.y + step)) p.y += step;
    } else {
      const lane = Math.round(p.x - 0.5) + 0.5;
      const off = lane - p.x;
      if (Math.abs(off) < 0.005 || Math.abs(off) > 0.48) return;
      const ahead = Math.floor(p.y + dir * R);
      if (!inBounds(ahead, Math.floor(lane)) || !walkable(this.grid[idx(ahead, Math.floor(lane))])) return;
      const step = Math.sign(off) * Math.min(Math.abs(off), amount);
      if (!this.hits(p.x + step, p.y)) p.x += step;
    }
  }

  // ── Guards ─────────────────────────────────────────────────────────────────
  guardSees(g, dist, dx, dy) {
    if (dist > this.diff.vision) return false;
    if (dist > GUARD.senseRadius && Math.abs(wrapAngle(Math.atan2(dy, dx) - g.angle)) > GUARD.coneHalf) return false;
    return lineOfSight(this.grid, g.x, g.y, this.player.x, this.player.y);
  }

  updateGuards(dt) {
    const d = this.diff;
    const p = this.player;
    for (const g of this.guards) {
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      const dist = Math.hypot(dx, dy);
      const exposed = p.shield <= 0;
      const sees = exposed && this.guardSees(g, dist, dx, dy);
      const hears = exposed && p.sprinting && dist <= d.hearing;
      g.sees = sees;

      if (g.state === 'patrol') {
        if (sees || hears) this.toSuspicious(g, hears && !sees);
        else this.patrol(g, dt);
      } else if (g.state === 'suspicious') {
        g.moving = false;
        if (sees) { g.lastX = p.x; g.lastY = p.y; g.notice += dt * (dist < 2.5 ? 2.2 : 1); }
        else g.notice = Math.max(0, g.notice - dt * 0.4);
        this.turnToward(g, Math.atan2(g.lastY - g.y, g.lastX - g.x), dt);
        g.susT -= dt;
        if (g.notice >= GUARD.noticeTime * (this.chaos ? 0.6 : 1)) this.toChase(g);
        else if (g.susT <= 0) this.toSearch(g);
      } else if (g.state === 'chase') {
        if (sees) { g.lastX = p.x; g.lastY = p.y; g.lostT = 0; } else g.lostT += dt;
        g.pathT -= dt;
        if (g.pathT <= 0 || g.path.length <= 1) {
          g.pathT = GUARD.repathEvery;
          g.path = findPath(this.grid, Math.floor(g.y), Math.floor(g.x), Math.floor(g.lastY), Math.floor(g.lastX), safe);
        }
        this.follow(g, d.chase, dt);
        if (g.lostT >= GUARD.loseTime) this.toSearch(g);
      } else if (g.state === 'search') {
        if (sees) { this.toChase(g); }
        else if (g.path.length > 1) this.follow(g, d.patrol * 1.3, dt);
        else {
          g.moving = false;
          g.searchT -= dt;
          g.angle = wrapAngle(g.angle + g.scanDir * dt * 2.4);
          if (g.searchT <= 0) { g.state = 'patrol'; g.path = []; g.waitT = 0.5; }
        }
      }
      g.anim = (g.anim + dt * (g.moving ? (g.state === 'chase' ? 9 : 6) : 1.5)) % 4;
      if (exposed && Math.hypot(p.x - g.x, p.y - g.y) < GUARD.catchRadius) { this.die('guard'); return; }
    }
  }

  toSuspicious(g, heardOnly) {
    g.state = 'suspicious';
    g.susT = 1.3;
    g.notice = heardOnly ? GUARD.noticeTime * 0.5 : 0;
    g.lastX = this.player.x;
    g.lastY = this.player.y;
    g.path = [];
    this.emit('suspicious', g);
  }

  toChase(g) {
    if (g.state === 'chase') return;
    g.state = 'chase';
    g.lostT = 0;
    g.pathT = 0;
    this.emit('alert', g);
  }

  toSearch(g) {
    g.state = 'search';
    g.searchT = GUARD.searchTime;
    g.scanDir = Math.random() < 0.5 ? -1 : 1;
    g.path = findPath(this.grid, Math.floor(g.y), Math.floor(g.x), Math.floor(g.lastY), Math.floor(g.lastX), safe);
  }

  patrol(g, dt) {
    if (g.path.length > 1) { this.follow(g, this.diff.patrol, dt); return; }
    g.moving = false;
    if (g.waitT > 0) {
      g.waitT -= dt;
      g.angle = wrapAngle(g.angle + g.scanDir * dt * 1.1); // look around while waiting
      return;
    }
    const gr = Math.floor(g.y);
    const gc = Math.floor(g.x);
    const dist = bfs(this.grid, gr, gc, safe, 18);
    const options = [];
    for (let i = 0; i < CELLS; i++) if (dist[i] >= 6 && this.grid[i] === T.FLOOR) options.push(i);
    if (options.length) {
      const target = options[Math.floor(Math.random() * options.length)];
      g.path = findPath(this.grid, gr, gc, rowOf(target), colOf(target), safe);
    }
    g.waitT = 0.6 + Math.random() * 1.4;
    g.scanDir = Math.random() < 0.5 ? -1 : 1;
  }

  follow(g, speed, dt) {
    let budget = speed * dt;
    g.moving = g.path.length > 1;
    while (budget > 0 && g.path.length > 1) {
      const next = g.path[1];
      const tx = colOf(next) + 0.5;
      const ty = rowOf(next) + 0.5;
      const ddx = tx - g.x;
      const ddy = ty - g.y;
      const dd = Math.hypot(ddx, ddy);
      if (dd > 1e-4) this.turnToward(g, Math.atan2(ddy, ddx), dt);
      if (dd <= budget) { g.x = tx; g.y = ty; budget -= dd; g.path.shift(); }
      else { g.x += (ddx / dd) * budget; g.y += (ddy / dd) * budget; budget = 0; }
    }
  }

  turnToward(g, target, dt) {
    const delta = wrapAngle(target - g.angle);
    const maxTurn = GUARD.turnRate * dt;
    g.angle = wrapAngle(g.angle + Math.max(-maxTurn, Math.min(maxTurn, delta)));
  }

  // ── Fumigation gas ─────────────────────────────────────────────────────────
  updateGas(dt) {
    const d = this.diff;
    const gas = this.gas;
    const p = this.player;
    const pi = idx(Math.floor(p.y), Math.floor(p.x));
    if (!gas.active) {
      if (this.spawnDist[pi] >= d.gasTrigger) {
        gas.active = true;
        const s = idx(this.spawn.r, this.spawn.c);
        gas.cells[s] = 1;
        gas.born[s] = this.time;
        gas.front = [s];
        this.emit('gasStart');
      }
      return;
    }
    // The whole front advances one tile in every direction each gasStep seconds.
    gas.timer += dt;
    while (gas.timer >= d.gasStep && gas.front.length) {
      gas.timer -= d.gasStep;
      const next = [];
      for (const i of gas.front) {
        const r = rowOf(i);
        const c = i - r * COLS;
        for (const [dr, dc] of DIRS) {
          const nr = r + dr;
          const nc = c + dc;
          if (!inBounds(nr, nc)) continue;
          const ni = nr * COLS + nc;
          if (gas.cells[ni] || this.grid[ni] === T.WALL) continue;
          gas.cells[ni] = 1;
          gas.born[ni] = this.time;
          next.push(ni);
        }
      }
      gas.front = next;
    }
    gas.nearT -= dt;
    if (gas.nearT <= 0) {
      gas.nearT = 0.25;
      gas.near = this.gasDistance(pi, 14);
    }
    if (gas.cells[pi] && p.shield <= 0) this.die('gas');
  }

  /** Path distance (≤ limit) from a cell to the nearest gas tile, or null. */
  gasDistance(from, limit) {
    if (this.gas.cells[from]) return 0;
    const dist = bfs(this.grid, rowOf(from), colOf(from), walkable, limit);
    let best = null;
    for (let i = 0; i < CELLS; i++) {
      if (dist[i] > 0 && this.gas.cells[i] && (best === null || dist[i] < best)) best = dist[i];
    }
    return best;
  }

  // ── Outcomes ───────────────────────────────────────────────────────────────
  die(cause) {
    if (!this.alive) return;
    this.alive = false;
    this.deaths++;
    this.levelDeaths++;
    const livesLeft = Math.max(0, LIVES - this.deaths);
    this.lastDeath = { cause, x: this.player.x, y: this.player.y };
    this.emit('death', { cause, livesLeft, gameOver: livesLeft === 0 });
  }

  completeLevel() {
    if (!this.alive) return;
    this.alive = false;
    this.completed = true;
    const secs = this.levelTime / 1000;
    const stats = {
      level: this.level, zone: this.zone.zone, timeMs: this.levelTime, curio: this.levelCurio,
      curioTotal: this.curioTotal, deaths: this.deaths, levelDeaths: this.levelDeaths,
      score: Math.max(0, Math.round(500 - secs * 3)) + this.levelCurio * 50,
    };
    if (this.level >= MAX_LEVEL) {
      this.finished = true;
      this.emit('runComplete', { ...this.result(), stats });
    } else {
      this.emit('levelComplete', stats);
    }
  }
}

function emptyGas() {
  return {
    active: false, cells: new Uint8Array(CELLS), born: new Float32Array(CELLS), front: [], timer: 0, near: null, nearT: 0,
  };
}

function newGuard(spawn, rng) {
  return {
    x: spawn.c + 0.5, y: spawn.r + 0.5, angle: rng.next() * TAU - Math.PI, state: 'patrol', path: [], pathT: 0,
    waitT: rng.next() * 1.5, notice: 0, susT: 0, lostT: 0, searchT: 0, lastX: 0, lastY: 0, anim: rng.next() * 4,
    scanDir: rng.next() < 0.5 ? -1 : 1, moving: false, sees: false,
  };
}

export { ROWS, COLS };
