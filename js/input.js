// ─── Input ──────────────────────────────────────────────────────────────────
// Keyboard (by physical key code, so Shift can't leave a key "stuck"), gamepad and touch,
// merged into one move vector plus discrete actions.
const MOVE = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
};
const SPRINT = ['ShiftLeft', 'ShiftRight'];
const GAME_KEYS = new Set([...Object.values(MOVE).flat(), ...SPRINT, 'Space']);
const KEY_ACTIONS = {
  Escape: 'pause', KeyP: 'pause', KeyR: 'restart', KeyC: 'checkpoint', KeyL: 'leaderboard', KeyM: 'mute',
};
// Standard gamepad layout.
const PAD_ACTIONS = { 0: 'confirm', 1: 'back', 2: 'checkpoint', 3: 'confirm', 8: 'checkpoint', 9: 'pause' };
const PAD_DEAD = 0.22;

export class Input {
  constructor() {
    this.down = new Set();
    this.handlers = {};
    this.lastActivity = performance.now();
    this.captureKeys = false; // true while playing: stops arrows/space scrolling the page
    this.touch = { active: false, id: null, ox: 0, oy: 0, vx: 0, vy: 0, sprint: false };
    this.pad = { index: null, connected: false, x: 0, y: 0, sprint: false, prev: [], navY: 0 };
    this.touchCapable = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clear(); });
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') this.touchCapable = true;
      this.activity();
    }, { passive: true, capture: true });
    window.addEventListener('gamepadconnected', (e) => this.setPad(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index !== this.pad.index) return;
      this.pad.index = null;
      this.pad.connected = false;
      this.emit('paddisconnected');
    });
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); }
  emit(event, data) { for (const fn of this.handlers[event] || []) fn(data); }

  activity() {
    this.lastActivity = performance.now();
    this.emit('activity');
  }

  clear() {
    this.down.clear();
    this.touch.active = false;
    this.touch.vx = 0;
    this.touch.vy = 0;
    this.touch.sprint = false;
    this.emit('stick', this.touch);
  }

  onKeyDown(e) {
    this.activity();
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (this.captureKeys && GAME_KEYS.has(e.code)) e.preventDefault();
    this.down.add(e.code);
    if (e.repeat) return;
    const action = KEY_ACTIONS[e.code];
    if (action) this.emit('action', { action, source: 'keyboard', event: e });
  }

  setPad(gp) {
    this.pad.index = gp.index;
    if (!this.pad.connected) {
      this.pad.connected = true;
      this.emit('padconnected', gp);
    }
  }

  pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = this.pad.index !== null ? pads[this.pad.index] : null;
    if (!gp) {
      for (const p of pads) if (p) { gp = p; this.setPad(p); break; }
    }
    if (!gp) {
      this.pad.x = 0;
      this.pad.y = 0;
      this.pad.sprint = false;
      return;
    }
    const pressed = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let ax = gp.axes[0] || 0;
    let ay = gp.axes[1] || 0;
    if (pressed(14)) ax = -1;
    if (pressed(15)) ax = 1;
    if (pressed(12)) ay = -1;
    if (pressed(13)) ay = 1;
    const mag = Math.hypot(ax, ay);
    if (mag < PAD_DEAD) {
      ax = 0;
      ay = 0;
    } else {
      const scaled = Math.min(1, (mag - PAD_DEAD) / (1 - PAD_DEAD)); // radial dead zone
      ax = (ax / mag) * scaled;
      ay = (ay / mag) * scaled;
      this.activity();
    }
    this.pad.x = ax;
    this.pad.y = ay;
    this.pad.sprint = pressed(4) || pressed(5) || (gp.buttons[6]?.value || 0) > 0.3 || (gp.buttons[7]?.value || 0) > 0.3;

    // Menu navigation: one step per stick/d-pad push.
    const navY = ay < -0.6 ? -1 : ay > 0.6 ? 1 : 0;
    if (navY && navY !== this.pad.navY) this.emit('nav', navY);
    this.pad.navY = navY;

    gp.buttons.forEach((b, i) => {
      if (b.pressed && !this.pad.prev[i]) {
        this.activity();
        if (PAD_ACTIONS[i]) this.emit('action', { action: PAD_ACTIONS[i], source: 'pad' });
      }
      this.pad.prev[i] = b.pressed;
    });
  }

  /** Current movement (x, y in -1..1) and sprint state from every source. */
  read() {
    this.pollPad();
    const held = (codes) => codes.some((c) => this.down.has(c));
    let x = (held(MOVE.right) ? 1 : 0) - (held(MOVE.left) ? 1 : 0);
    let y = (held(MOVE.down) ? 1 : 0) - (held(MOVE.up) ? 1 : 0);
    if (x && y) { x *= Math.SQRT1_2; y *= Math.SQRT1_2; }
    if (this.touch.active && (this.touch.vx || this.touch.vy)) { x = this.touch.vx; y = this.touch.vy; }
    if (this.pad.x || this.pad.y) { x = this.pad.x; y = this.pad.y; }
    return { x, y, sprint: held(SPRINT) || this.touch.sprint || this.pad.sprint };
  }

  /** Floating thumbstick: touch anywhere on `zone` and drag. */
  attachTouch(zone, sprintButton, radius = 52) {
    zone.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || this.touch.active) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      Object.assign(this.touch, { active: true, id: e.pointerId, ox: e.clientX, oy: e.clientY, vx: 0, vy: 0 });
      this.emit('stick', this.touch);
    });
    zone.addEventListener('pointermove', (e) => {
      if (!this.touch.active || e.pointerId !== this.touch.id) return;
      const dx = e.clientX - this.touch.ox;
      const dy = e.clientY - this.touch.oy;
      const m = Math.hypot(dx, dy);
      const k = m < 6 ? 0 : Math.min(1, m / radius) / m;
      this.touch.vx = dx * k;
      this.touch.vy = dy * k;
      this.emit('stick', this.touch);
    });
    const end = (e) => {
      if (e.pointerId !== this.touch.id) return;
      Object.assign(this.touch, { active: false, id: null, vx: 0, vy: 0 });
      this.emit('stick', this.touch);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    if (sprintButton) {
      const set = (on) => (e) => { e.preventDefault(); e.stopPropagation(); this.touch.sprint = on; sprintButton.classList.toggle('is-held', on); };
      sprintButton.addEventListener('pointerdown', set(true));
      sprintButton.addEventListener('pointerup', set(false));
      sprintButton.addEventListener('pointercancel', set(false));
      sprintButton.addEventListener('pointerleave', set(false));
    }
  }
}
