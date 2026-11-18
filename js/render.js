// ─── Canvas renderer ────────────────────────────────────────────────────────
// "The archive at night": top-down 3/4 view with shelving walls, lamplight and flashlights.
// The static maze is pre-rendered once per level/resize; only moving things draw per frame.
import { COLS, GUARD, ROWS, T } from './config.js';
import { idx } from './maze.js';
import { iconPath } from './icons.js';

const TAU = Math.PI * 2;
const SPINES = ['#7a3b2e', '#2f4f6f', '#6b5b2a', '#3f5e3a', '#5a3d63', '#8a6a3a', '#2e5a5a', '#6e2f3f', '#4a4a6a', '#7d5a2c', '#5b6b2f', '#3d3f66'];

function hash(a, b) {
  let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d');
    this.particles = [];
    this.layerKey = '';
    this.ts = 20;
    this.mode = 'fit';
    this.camX = 0;
    this.camY = 0;
    this.camLevel = null;
    this.shake = 0;
    this.lastNow = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Size the canvas to its CSS box. Chooses "fit" (whole maze) or "follow" (camera) mode. */
  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.dpr = dpr;
    this.W = Math.max(1, Math.round(cssW * dpr));
    this.H = Math.max(1, Math.round(cssH * dpr));
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.light.width = this.W;
    this.light.height = this.H;
    const fit = Math.floor(Math.min(this.W / COLS, this.H / ROWS));
    if (fit >= 13 * dpr) {
      this.mode = 'fit';
      this.ts = fit;
    } else {
      this.mode = 'follow';
      this.ts = Math.round(clamp(Math.min(this.W, this.H) / 14, 20 * dpr, 34 * dpr));
    }
    this.vignette = null;
    this.layerKey = '';
  }

  // ── Static layer ───────────────────────────────────────────────────────────
  ensureLayer(game) {
    const key = `${game.mazeVersion}:${this.ts}`;
    if (key === this.layerKey) return;
    this.layerKey = key;
    const ts = this.ts;
    const grid = game.grid;
    const pal = game.zone.palette;
    this.layer.width = COLS * ts;
    this.layer.height = ROWS * ts;
    const c = this.layer.getContext('2d');
    this.spikes = [];

    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const i = idx(r, col);
        if (grid[i] === T.WALL) continue;
        const x = col * ts;
        const y = r * ts;
        c.fillStyle = (r + col) % 2 ? pal.floorB : pal.floorA;
        c.fillRect(x, y, ts, ts);
        const dot = Math.max(1, Math.round(ts * 0.1));
        c.fillStyle = 'rgba(255,255,255,0.04)';
        c.fillRect(x + hash(i, 1) * (ts - dot), y + hash(i, 2) * (ts - dot), dot, dot);
        c.fillStyle = 'rgba(0,0,0,0.10)';
        c.fillRect(x + hash(i, 3) * (ts - dot), y + hash(i, 4) * (ts - dot), dot, dot);
        c.fillStyle = pal.grout;
        c.fillRect(x, y + ts - 1, ts, 1);
        c.fillRect(x + ts - 1, y, 1, ts);
      }
    }
    // Soft shadows cast by walls onto the floor (from the top-left light).
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const i = idx(r, col);
        if (grid[i] === T.WALL) continue;
        const x = col * ts;
        const y = r * ts;
        if (r > 0 && grid[idx(r - 1, col)] === T.WALL) {
          const g = c.createLinearGradient(0, y, 0, y + ts * 0.5);
          g.addColorStop(0, 'rgba(0,0,0,0.42)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g;
          c.fillRect(x, y, ts, ts * 0.5);
        }
        if (col > 0 && grid[idx(r, col - 1)] === T.WALL) {
          const g = c.createLinearGradient(x, 0, x + ts * 0.3, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.26)');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g;
          c.fillRect(x, y, ts * 0.3, ts);
        }
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const i = idx(r, col);
        const t = grid[i];
        if (t === T.WALL) this.drawWall(c, grid, r, col, i);
        else if (t === T.SPIKE) { this.drawSpikeBase(c, col * ts, r * ts); this.spikes.push(i); }
        else if (t === T.EXIT) this.drawExitBase(c, col * ts, r * ts);
      }
    }
  }

  drawWall(c, grid, r, col, i) {
    const ts = this.ts;
    const x = col * ts;
    const y = r * ts;
    const open = (rr, cc) => rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && grid[idx(rr, cc)] !== T.WALL;
    const below = open(r + 1, col);
    const faceH = below ? Math.round(ts * 0.38) : 0;
    const topH = ts - faceH;
    const rim = Math.max(1, Math.round(ts * 0.06));
    c.fillStyle = '#17152d';
    c.fillRect(x, y, ts, ts);
    c.fillStyle = '#25223f';
    c.fillRect(x + 1, y + 1, ts - 2, Math.max(0, topH - 2));
    c.fillStyle = 'rgba(212,178,90,0.42)';
    if (open(r - 1, col)) c.fillRect(x, y, ts, rim);
    if (open(r, col - 1)) c.fillRect(x, y, rim, topH);
    if (open(r, col + 1)) c.fillRect(x + ts - rim, y, rim, topH);
    if (!below) return;
    // Shelf front: a row of book spines.
    const fy = y + topH;
    c.fillStyle = '#2a1c13';
    c.fillRect(x, fy, ts, faceH);
    const inner = faceH - Math.max(2, Math.round(ts * 0.08));
    let bx = x + 1;
    for (let k = 0; bx < x + ts - 1; k++) {
      const w = Math.min(Math.max(1, Math.round(ts * (0.07 + hash(i, k) * 0.08))), x + ts - 1 - bx);
      const h = Math.max(1, Math.round(inner * (0.6 + hash(i, k + 31) * 0.38)));
      c.fillStyle = SPINES[Math.floor(hash(i, k + 7) * SPINES.length)];
      c.fillRect(bx, fy + faceH - 1 - h, w, h);
      if (ts >= 18 && w >= 2) {
        c.fillStyle = 'rgba(255,230,170,0.2)';
        c.fillRect(bx, fy + faceH - 1 - h + Math.round(h * 0.28), w, 1);
      }
      bx += w + (hash(i, k + 13) < 0.2 ? 1 : 0);
    }
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(x, fy, ts, rim);
    c.fillStyle = 'rgba(212,178,90,0.32)';
    c.fillRect(x, fy - 1, ts, 1);
    c.fillStyle = '#3d2b1c';
    c.fillRect(x, y + ts - rim, ts, rim);
  }

  drawSpikeBase(c, x, y) {
    const ts = this.ts;
    const pad = ts * 0.1;
    c.fillStyle = '#211e26';
    c.beginPath();
    c.roundRect(x + pad, y + pad, ts - pad * 2, ts - pad * 2, ts * 0.12);
    c.fill();
    for (const [sx, sy] of [[0.33, 0.36], [0.67, 0.36], [0.33, 0.72], [0.67, 0.72]]) {
      const bx = x + ts * sx;
      const by = y + ts * sy;
      const g = c.createLinearGradient(bx, by - ts * 0.28, bx, by);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#8c90a0');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(bx, by - ts * 0.28);
      c.lineTo(bx + ts * 0.11, by);
      c.lineTo(bx - ts * 0.11, by);
      c.closePath();
      c.fill();
    }
    c.strokeStyle = 'rgba(255,90,90,0.85)';
    c.lineWidth = Math.max(1, ts * 0.07);
    c.setLineDash([ts * 0.16, ts * 0.1]);
    c.strokeRect(x + pad * 0.6, y + pad * 0.6, ts - pad * 1.2, ts - pad * 1.2);
    c.setLineDash([]);
  }

  drawExitBase(c, x, y) {
    const ts = this.ts;
    c.fillStyle = '#0a2918';
    c.fillRect(x + ts * 0.08, y + ts * 0.04, ts * 0.84, ts * 0.92);
    c.fillStyle = '#11452a';
    c.fillRect(x + ts * 0.16, y + ts * 0.12, ts * 0.68, ts * 0.78);
    c.strokeStyle = '#3ddc84';
    c.lineWidth = Math.max(1, ts * 0.07);
    c.strokeRect(x + ts * 0.12, y + ts * 0.08, ts * 0.76, ts * 0.86);
    // Running-figure exit pictogram.
    const s = ts * 0.3;
    const cx = x + ts * 0.5;
    const cy = y + ts * 0.54;
    c.strokeStyle = '#ffffff';
    c.fillStyle = '#ffffff';
    c.lineWidth = Math.max(1, ts * 0.07);
    c.lineCap = 'round';
    c.beginPath();
    c.arc(cx + s * 0.25, cy - s * 0.75, s * 0.18, 0, TAU);
    c.fill();
    c.beginPath();
    c.moveTo(cx + s * 0.1, cy - s * 0.45);
    c.lineTo(cx - s * 0.1, cy + s * 0.15);
    c.moveTo(cx - s * 0.1, cy + s * 0.15);
    c.lineTo(cx - s * 0.5, cy + s * 0.65);
    c.moveTo(cx - s * 0.1, cy + s * 0.15);
    c.lineTo(cx + s * 0.35, cy + s * 0.45);
    c.lineTo(cx + s * 0.3, cy + s * 0.8);
    c.moveTo(cx - s * 0.45, cy - s * 0.15);
    c.lineTo(cx + s * 0.05, cy - s * 0.35);
    c.lineTo(cx + s * 0.45, cy - s * 0.05);
    c.stroke();
  }

  // ── Effects API (called by the app on game events) ─────────────────────────
  burst(x, y, color, count = 18, speed = 3) {
    if (this.reducedMotion) count = Math.ceil(count / 3);
    for (let n = 0; n < count; n++) {
      const a = Math.random() * TAU;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6 + Math.random() * 0.5, max: 1.1, color, size: 0.06 + Math.random() * 0.08, drag: 2.5 });
    }
  }

  ring(x, y, color) {
    this.particles.push({ x, y, vx: 0, vy: 0, life: 0.7, max: 0.7, color, ring: true, size: 0 });
  }

  dust(x, y) {
    this.particles.push({ x: x + (Math.random() - 0.5) * 0.3, y: y + 0.25, vx: (Math.random() - 0.5) * 0.4, vy: -0.2, life: 0.4, max: 0.4, color: '#d9cbb0', size: 0.05, drag: 1 });
  }

  shakeScreen(amount) {
    if (!this.reducedMotion) this.shake = Math.max(this.shake, amount);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────
  draw(game, now) {
    const ctx = this.ctx;
    const ts = this.ts;
    const t = now / 1000;
    const dt = this.lastNow ? Math.min(0.05, (now - this.lastNow) / 1000) : 0.016;
    this.lastNow = now;
    this.ensureLayer(game);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#06060d';
    ctx.fillRect(0, 0, this.W, this.H);

    const boardW = COLS * ts;
    const boardH = ROWS * ts;
    let ox;
    let oy;
    if (this.mode === 'fit' || !game.player) {
      ox = Math.floor((this.W - boardW) / 2);
      oy = Math.floor((this.H - boardH) / 2);
    } else {
      const tx = boardW <= this.W ? (boardW - this.W) / 2 : clamp(game.player.x * ts - this.W / 2, 0, boardW - this.W);
      const ty = boardH <= this.H ? (boardH - this.H) / 2 : clamp(game.player.y * ts - this.H / 2, 0, boardH - this.H);
      if (this.camLevel !== game.mazeVersion) { this.camX = tx; this.camY = ty; this.camLevel = game.mazeVersion; }
      this.camX += (tx - this.camX) * Math.min(1, dt * 10);
      this.camY += (ty - this.camY) * Math.min(1, dt * 10);
      ox = -Math.round(this.camX);
      oy = -Math.round(this.camY);
    }
    if (this.shake > 0.2) {
      ox += Math.round((Math.random() - 0.5) * this.shake);
      oy += Math.round((Math.random() - 0.5) * this.shake);
      this.shake *= Math.pow(0.02, dt);
    } else this.shake = 0;
    this.ox = ox;
    this.oy = oy;
    this.view = {
      c0: Math.max(0, Math.floor(-ox / ts)), c1: Math.min(COLS, Math.ceil((this.W - ox) / ts)),
      r0: Math.max(0, Math.floor(-oy / ts)), r1: Math.min(ROWS, Math.ceil((this.H - oy) / ts)),
    };

    ctx.drawImage(this.layer, ox, oy);
    ctx.save();
    ctx.translate(ox, oy);
    this.drawHazards(ctx, game, t);
    this.drawGas(ctx, game, t);
    this.drawCheckpoint(ctx, game, t);
    this.drawItems(ctx, game, t);
    const cones = game.guards.map((g) => this.cone(game, g));
    this.drawCones(ctx, game, cones);
    const actors = game.guards.map((g) => ({ y: g.y, draw: () => this.drawGuard(ctx, g) }));
    if (game.player) actors.push({ y: game.player.y, draw: () => this.drawPlayer(ctx, game, t) });
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());
    this.drawParticles(ctx, dt);
    ctx.restore();

    this.drawLighting(game, cones, ox, oy, t);

    ctx.save();
    ctx.translate(ox, oy);
    this.drawOverlays(ctx, game, t);
    ctx.restore();
    this.drawScreenFx(game, t);
  }

  drawHazards(ctx, game, t) {
    const ts = this.ts;
    for (const i of this.spikes) {
      const r = Math.floor(i / COLS);
      const c = i % COLS;
      ctx.fillStyle = `rgba(255,70,70,${0.08 + 0.08 * Math.sin(t * 4 + i)})`;
      ctx.fillRect(c * ts, r * ts, ts, ts);
    }
    const ex = (game.exit.c + 0.5) * ts;
    const ey = (game.exit.r + 0.5) * ts;
    const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, ts * 1.8);
    g.addColorStop(0, `rgba(61,220,132,${0.32 + 0.14 * Math.sin(t * 3)})`);
    g.addColorStop(1, 'rgba(61,220,132,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ex - ts * 1.8, ey - ts * 1.8, ts * 3.6, ts * 3.6);
  }

  drawGas(ctx, game, t) {
    const ts = this.ts;
    const gas = game.gas;
    if (!gas.active) {
      if (!game.player) return;
      const s = game.spawn;
      ctx.fillStyle = `rgba(80,230,140,${0.1 + 0.07 * Math.sin(t * 3)})`;
      ctx.fillRect(s.c * ts, s.r * ts, ts, ts);
      return;
    }
    const step = game.diff.gasStep;
    const { r0, r1, c0, c1 } = this.view;
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const i = r * COLS + c;
        if (!gas.cells[i]) continue;
        const a = Math.min(1, (game.time - gas.born[i]) / step);
        ctx.fillStyle = `rgba(46,196,106,${0.36 * a})`;
        ctx.fillRect(c * ts, r * ts, ts, ts);
        const ph = hash(i, 9) * TAU;
        const px = c * ts + ts * (0.5 + 0.2 * Math.sin(t * 0.9 + ph));
        const py = r * ts + ts * (0.5 + 0.2 * Math.cos(t * 0.7 + ph));
        ctx.fillStyle = `rgba(160,255,195,${0.11 * a})`;
        ctx.beginPath();
        ctx.arc(px, py, ts * 0.45, 0, TAU);
        ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(190,255,215,0.16)';
    for (const i of gas.front) ctx.fillRect((i % COLS) * ts, Math.floor(i / COLS) * ts, ts, ts);
  }

  drawCheckpoint(ctx, game, t) {
    const cp = game.checkpoint;
    if (!cp) return;
    const ts = this.ts;
    const x = cp.x * ts;
    const y = cp.y * ts;
    const pulse = (t * 0.8) % 1;
    ctx.strokeStyle = `rgba(90,162,255,${0.6 * (1 - pulse)})`;
    ctx.lineWidth = Math.max(1, ts * 0.06);
    ctx.beginPath();
    ctx.ellipse(x, y + ts * 0.25, ts * (0.2 + pulse * 0.4), ts * (0.08 + pulse * 0.16), 0, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#cfe2ff';
    ctx.lineWidth = Math.max(1, ts * 0.06);
    ctx.beginPath();
    ctx.moveTo(x - ts * 0.15, y + ts * 0.28);
    ctx.lineTo(x - ts * 0.15, y - ts * 0.38);
    ctx.stroke();
    ctx.fillStyle = '#5aa2ff';
    ctx.beginPath();
    ctx.moveTo(x - ts * 0.15, y - ts * 0.38);
    ctx.lineTo(x + ts * 0.3, y - ts * 0.24);
    ctx.lineTo(x - ts * 0.15, y - ts * 0.1);
    ctx.closePath();
    ctx.fill();
  }

  drawItems(ctx, game, t) {
    const ts = this.ts;
    for (const item of game.items) {
      if (item.got) continue;
      const cx = (item.c + 0.5) * ts;
      const base = (item.r + 0.5) * ts;
      const cy = base - ts * 0.06 + Math.sin(t * 2.2 + item.phase) * ts * 0.07;
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx, base + ts * 0.32, ts * 0.28, ts * 0.09, 0, 0, TAU);
      ctx.fill();
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, ts * 0.95);
      glow.addColorStop(0, rgba(item.color, 0.55));
      glow.addColorStop(1, rgba(item.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, ts * 0.95, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0d0f1c';
      ctx.beginPath();
      ctx.arc(cx, cy, ts * 0.37, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = item.color;
      ctx.lineWidth = Math.max(1.5, ts * 0.07);
      ctx.stroke();
      ctx.save();
      ctx.translate(cx - ts * 0.24, cy - ts * 0.24);
      ctx.scale((ts * 0.48) / 24, (ts * 0.48) / 24);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(iconPath(item.id));
      ctx.restore();
      const a = t * 2 + item.phase;
      ctx.fillStyle = rgba(item.color, 0.9);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * ts * 0.52, cy + Math.sin(a) * ts * 0.52, Math.max(1, ts * 0.05), 0, TAU);
      ctx.fill();
    }
  }

  /** Flashlight polygon: rays cast across the cone, stopped by walls (tile units). */
  cone(game, g) {
    const range = game.diff.vision;
    const rays = 20;
    const pts = [];
    for (let k = 0; k <= rays; k++) {
      const a = g.angle - GUARD.coneHalf + (2 * GUARD.coneHalf * k) / rays;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let d = 0.25;
      while (d < range) {
        const x = g.x + ca * d;
        const y = g.y + sa * d;
        const r = Math.floor(y);
        const c = Math.floor(x);
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS || game.grid[r * COLS + c] === T.WALL) break;
        d += 0.12;
      }
      pts.push([g.x + ca * d, g.y + sa * d]);
    }
    return pts;
  }

  drawCones(ctx, game, cones) {
    const ts = this.ts;
    game.guards.forEach((g, n) => {
      const color = g.state === 'chase' ? '255,80,80' : g.state === 'suspicious' ? '255,190,80' : '255,228,150';
      const grad = ctx.createRadialGradient(g.x * ts, g.y * ts, 0, g.x * ts, g.y * ts, game.diff.vision * ts);
      grad.addColorStop(0, `rgba(${color},${g.state === 'patrol' ? 0.2 : 0.3})`);
      grad.addColorStop(1, `rgba(${color},0.02)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(g.x * ts, g.y * ts);
      for (const [x, y] of cones[n]) ctx.lineTo(x * ts, y * ts);
      ctx.closePath();
      ctx.fill();
    });
  }

  drawGuard(ctx, g) {
    const ts = this.ts;
    const s = ts / 22;
    const chase = g.state === 'chase';
    const face = Math.cos(g.angle) >= 0 ? 1 : -1;
    const step = g.moving ? Math.sin(g.anim * Math.PI) : 0;
    ctx.save();
    ctx.translate(g.x * ts, g.y * ts + Math.abs(step) * -1.2 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 8 * s, 8 * s, 3.5 * s, 0, 0, TAU);
    ctx.fill();
    ctx.scale(face * s, s);
    ctx.fillStyle = '#161c2e';
    ctx.fillRect(-5, 2 + step * 2, 4, 8 - step * 2);
    ctx.fillRect(1, 2 - step * 2, 4, 8 + step * 2);
    ctx.fillStyle = chase ? '#33437a' : '#283556';
    ctx.beginPath();
    ctx.roundRect(-7, -9, 14, 13, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#0f1424';
    ctx.fillRect(-7, 0, 14, 2);
    ctx.fillStyle = '#d4b25a';
    ctx.beginPath();
    ctx.arc(-2.5, -4.5, 1.7, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#283556';
    ctx.fillRect(3, -6, 6, 3);
    ctx.fillStyle = '#9aa3b5';
    ctx.fillRect(8, -6.5, 5, 3.4);
    ctx.fillStyle = chase ? '#ffb4b4' : '#fff1bf';
    ctx.fillRect(12.5, -6.5, 1.6, 3.4);
    ctx.fillStyle = '#c99a78';
    ctx.beginPath();
    ctx.arc(0, -14, 5.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#121729';
    ctx.beginPath();
    ctx.roundRect(-6.5, -21, 13, 5.5, 2);
    ctx.fill();
    ctx.fillRect(0, -16.6, 8.5, 2);
    ctx.fillStyle = '#d4b25a';
    ctx.fillRect(-1.5, -19.6, 3, 2);
    ctx.fillStyle = chase ? '#ff4d4d' : '#1a1a1a';
    ctx.beginPath();
    ctx.arc(2.8, -13.6, 1.15, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawPlayer(ctx, game, t) {
    const ts = this.ts;
    const p = game.player;
    const s = ts / 22;
    const swing = p.moving ? Math.sin(p.anim * Math.PI * 2) : 0;
    const bob = p.moving ? Math.abs(Math.sin(p.anim * Math.PI)) * -2 * s : 0;
    if (p.sprinting && Math.random() < 0.5) this.dust(p.x, p.y);
    ctx.save();
    if (p.shield > 0) ctx.globalAlpha = 0.45 + 0.45 * Math.abs(Math.sin(t * 14));
    ctx.translate(p.x * ts, p.y * ts + bob);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(0, 9 * s, 9 * s, 3.6 * s, 0, 0, TAU);
    ctx.fill();
    if (p.sprinting) {
      ctx.strokeStyle = 'rgba(120,200,255,0.5)';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.ellipse(0, -5 * s, 13 * s, 17 * s, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.scale(p.face * s, s);
    // Legs and shoes
    ctx.fillStyle = '#2a3050';
    ctx.fillRect(-6, 3 - swing * 3, 5, 9 + swing * 3);
    ctx.fillRect(1, 3 + swing * 3, 5, 9 - swing * 3);
    ctx.fillStyle = '#ece4d4';
    ctx.fillRect(-7, 11, 7, 3);
    ctx.fillRect(0, 11, 7, 3);
    // Backpack
    ctx.fillStyle = '#7a5a14';
    ctx.beginPath();
    ctx.roundRect(-13, -10, 7, 13, 2);
    ctx.fill();
    ctx.fillStyle = '#ffcc44';
    ctx.fillRect(-12, -5, 5, 2.5);
    // Jacket
    const jacket = ctx.createLinearGradient(-8, -10, 7, 4);
    jacket.addColorStop(0, '#e3b53c');
    jacket.addColorStop(1, '#9b7a1f');
    ctx.fillStyle = jacket;
    ctx.beginPath();
    ctx.roundRect(-7, -10, 14, 14, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.arc(1, -3, 2.8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffcc44';
    ctx.font = 'bold 4px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', 1, -2.8);
    // Arm (front)
    ctx.save();
    ctx.translate(4, -6);
    ctx.rotate(swing * 0.35);
    ctx.fillStyle = '#d8a85e';
    ctx.fillRect(0, 0, 4, 9);
    ctx.restore();
    // Head, hair, glasses
    ctx.fillStyle = '#f0c888';
    ctx.beginPath();
    ctx.arc(0, -16, 7, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();
    ctx.fillStyle = '#1a0a00';
    ctx.beginPath();
    ctx.arc(-0.5, -19.5, 6.6, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-5, -18, 3, Math.PI * 0.9, Math.PI * 1.8);
    ctx.fill();
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = 0.9;
    ctx.strokeRect(0.5, -17.5, 3.6, 2.8);
    ctx.strokeRect(-4.5, -17.5, 3.6, 2.8);
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(2.4, -16.1, 0.9, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawParticles(ctx, dt) {
    const ts = this.ts;
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      if (p.ring) {
        ctx.strokeStyle = rgba(p.color, a * 0.9);
        ctx.lineWidth = Math.max(1, ts * 0.08);
        ctx.beginPath();
        ctx.arc(p.x * ts, p.y * ts, ts * (0.3 + (1 - a) * 1.4), 0, TAU);
        ctx.stroke();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = Math.exp(-(p.drag || 0) * dt);
      p.vx *= k;
      p.vy *= k;
      ctx.fillStyle = rgba(p.color, a);
      ctx.beginPath();
      ctx.arc(p.x * ts, p.y * ts, Math.max(1, p.size * ts), 0, TAU);
      ctx.fill();
    }
  }

  drawLighting(game, cones, ox, oy, t) {
    const l = this.lctx;
    const ts = this.ts;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, this.W, this.H);
    l.fillStyle = game.player ? 'rgba(3,4,12,0.38)' : 'rgba(3,4,12,0.5)';
    l.fillRect(0, 0, this.W, this.H);
    l.globalCompositeOperation = 'destination-out';
    l.translate(ox, oy);
    const hole = (x, y, radius, strength) => {
      const g = l.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = g;
      l.beginPath();
      l.arc(x, y, radius, 0, TAU);
      l.fill();
    };
    if (game.player) {
      const flicker = this.reducedMotion ? 1 : 1 + 0.02 * Math.sin(t * 7) + 0.015 * Math.sin(t * 13);
      hole(game.player.x * ts, game.player.y * ts, ts * 5.2 * flicker, 0.95);
    }
    for (const item of game.items) if (!item.got) hole((item.c + 0.5) * ts, (item.r + 0.5) * ts, ts * 1.6, 0.75);
    hole((game.exit.c + 0.5) * ts, (game.exit.r + 0.5) * ts, ts * 2.8, 0.9);
    if (game.checkpoint) hole(game.checkpoint.x * ts, game.checkpoint.y * ts, ts * 1.3, 0.6);
    game.guards.forEach((g, n) => {
      hole(g.x * ts, g.y * ts, ts * 1.3, 0.65);
      const grad = l.createRadialGradient(g.x * ts, g.y * ts, 0, g.x * ts, g.y * ts, game.diff.vision * ts);
      grad.addColorStop(0, 'rgba(0,0,0,0.85)');
      grad.addColorStop(1, 'rgba(0,0,0,0.1)');
      l.fillStyle = grad;
      l.beginPath();
      l.moveTo(g.x * ts, g.y * ts);
      for (const [x, y] of cones[n]) l.lineTo(x * ts, y * ts);
      l.closePath();
      l.fill();
    });
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.light, 0, 0);
  }

  drawOverlays(ctx, game, t) {
    const ts = this.ts;
    const label = Math.max(9 * this.dpr, ts * 0.42);
    // Guard state badges
    for (const g of game.guards) {
      if (g.state === 'patrol') continue;
      const chase = g.state === 'chase';
      const x = g.x * ts;
      const y = g.y * ts - ts * 1.25 - (chase ? Math.abs(Math.sin(t * 8)) * ts * 0.12 : 0);
      ctx.fillStyle = chase ? '#ff4d4d' : g.state === 'search' ? '#8fa3c7' : '#ffb340';
      ctx.beginPath();
      ctx.arc(x, y, label * 0.62, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0b0b14';
      ctx.font = `800 ${label * 0.85}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(chase ? '!' : '?', x, y + label * 0.04);
    }
    // Exit label
    if (ts >= 14 * this.dpr) {
      const ex = (game.exit.c + 0.5) * ts;
      const ey = game.exit.r * ts - ts * 0.35;
      ctx.font = `700 ${label * 0.8}px Inter, system-ui, sans-serif`;
      const w = ctx.measureText('EXIT').width + label;
      ctx.fillStyle = '#3ddc84';
      ctx.beginPath();
      ctx.roundRect(ex - w / 2, ey - label * 0.6, w, label * 1.2, label * 0.6);
      ctx.fill();
      ctx.fillStyle = '#04150b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('EXIT', ex, ey + label * 0.04);
    }
    // Player name tag
    const p = game.player;
    if (p && game.name) {
      ctx.font = `700 ${label * 0.8}px Inter, system-ui, sans-serif`;
      const w = ctx.measureText(game.name).width + label * 0.9;
      // Keep the tag on screen and on the board even when the player hugs an edge.
      const minX = Math.max(w / 2 + 2, -this.ox + w / 2 + 4);
      const maxX = Math.min(COLS * ts - w / 2 - 2, this.W - this.ox - w / 2 - 4);
      const x = clamp(p.x * ts, minX, Math.max(minX, maxX));
      const y = Math.max(p.y * ts - ts * 1.35, -this.oy + label * 0.7);
      ctx.fillStyle = 'rgba(7,7,15,0.78)';
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - label * 0.58, w, label * 1.16, label * 0.58);
      ctx.fill();
      ctx.fillStyle = '#f0dca0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(game.name, x, y + label * 0.04);
    }
  }

  drawScreenFx(game, t) {
    const ctx = this.ctx;
    if (!this.vignette) {
      const g = ctx.createRadialGradient(this.W / 2, this.H / 2, Math.min(this.W, this.H) * 0.35, this.W / 2, this.H / 2, Math.max(this.W, this.H) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      this.vignette = g;
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, this.W, this.H);
    if (!game.player || !game.alive) return;
    const edge = (color, alpha) => {
      const w = Math.min(this.W, this.H) * 0.12;
      const sides = [
        [0, 0, this.W, w, 0, 0, 0, w], [0, this.H - w, this.W, w, 0, this.H, 0, this.H - w],
        [0, 0, w, this.H, 0, 0, w, 0], [this.W - w, 0, w, this.H, this.W, 0, this.W - w, 0],
      ];
      for (const [x, y, ww, hh, x0, y0, x1, y1] of sides) {
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, `rgba(${color},${alpha})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, ww, hh);
      }
    };
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    if (game.guards.some((g) => g.state === 'chase')) edge('255,60,60', 0.18 + 0.12 * pulse);
    const near = game.gas.near;
    if (near !== null && near <= 5) edge('60,220,120', (0.3 - near * 0.04) * (0.6 + 0.4 * pulse));
  }

  /** Small overview map (used when the camera follows the player on small screens). */
  drawMinimap(mctx, game, w, h) {
    const s = Math.min(w / COLS, h / ROWS);
    const ox = (w - COLS * s) / 2;
    const oy = (h - ROWS * s) / 2;
    mctx.clearRect(0, 0, w, h);
    mctx.fillStyle = 'rgba(7,7,15,0.85)';
    mctx.fillRect(0, 0, w, h);
    for (let i = 0; i < game.grid.length; i++) {
      const t = game.grid[i];
      if (t === T.WALL) continue;
      mctx.fillStyle = game.gas.cells[i] ? '#2ec46a' : t === T.SPIKE ? '#a33' : t === T.EXIT ? '#3ddc84' : '#3a3552';
      mctx.fillRect(ox + (i % COLS) * s, oy + Math.floor(i / COLS) * s, Math.ceil(s), Math.ceil(s));
    }
    const dot = (x, y, color, size) => {
      mctx.fillStyle = color;
      mctx.fillRect(ox + x * s - size / 2, oy + y * s - size / 2, size, size);
    };
    for (const item of game.items) if (!item.got) dot(item.c + 0.5, item.r + 0.5, item.color, s * 2);
    for (const g of game.guards) dot(g.x, g.y, g.state === 'chase' ? '#ff4d4d' : '#ff9a9a', s * 2);
    if (game.player) dot(game.player.x, game.player.y, '#f0dca0', s * 2.4);
    if (this.mode === 'follow') {
      mctx.strokeStyle = 'rgba(240,220,160,0.6)';
      mctx.lineWidth = 1;
      mctx.strokeRect(ox + (-this.ox / this.ts) * s, oy + (-this.oy / this.ts) * s, (this.W / this.ts) * s, (this.H / this.ts) * s);
    }
  }
}
