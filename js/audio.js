// ─── Audio ──────────────────────────────────────────────────────────────────
// Music and the recorded effects load only after the first user gesture (the music file is
// 12.8 MB). Short UI blips are synthesized, so they need no files.
import { ASSETS, STORAGE_KEYS } from './config.js';

const MUSIC_VOLUME = 0.5;
const TONES = {
  checkpoint: [[660, 0.08], [990, 0.14]],
  denied: [[196, 0.14]],
  death: [[246, 0.16], [164, 0.38]],
  level: [[523, 0.1], [659, 0.1], [784, 0.2]],
  gas: [[150, 0.3]],
  ui: [[880, 0.04]],
};

export class AudioManager {
  constructor() {
    this.ready = false;
    this.alertAt = -Infinity;
    try { this.muted = localStorage.getItem(STORAGE_KEYS.muted) === '1'; } catch { this.muted = false; }
  }

  /** Call from a user gesture (button press / key) to satisfy autoplay rules. */
  unlock() {
    if (this.ready) return;
    this.ready = true;
    this.music = new Audio(ASSETS.music);
    this.music.loop = true;
    this.music.volume = MUSIC_VOLUME;
    this.sfx = { alert: new Audio(ASSETS.alert), pickup: new Audio(ASSETS.pickup) };
    this.sfx.alert.volume = 0.85;
    this.sfx.pickup.volume = 0.85;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
  }

  playMusic() {
    if (this.ready && !this.muted) this.music.play().catch(() => {});
  }

  pauseMusic() {
    if (this.music) this.music.pause();
  }

  restartMusic() {
    if (!this.music) return;
    this.music.currentTime = 0;
    this.playMusic();
  }

  setMuted(muted) {
    this.muted = muted;
    try { localStorage.setItem(STORAGE_KEYS.muted, muted ? '1' : '0'); } catch { /* storage unavailable */ }
    if (muted) this.pauseMusic(); else this.playMusic();
  }

  duck(level, ms) {
    if (!this.music) return;
    this.music.volume = MUSIC_VOLUME * level;
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => { if (this.music) this.music.volume = MUSIC_VOLUME; }, ms);
  }

  play(name) {
    if (!this.ready || this.muted || !this.sfx[name]) return;
    const a = this.sfx[name];
    a.currentTime = 0;
    a.play().catch(() => {});
  }

  /** Guard alert, at most every 6 seconds so a chase doesn't spam it. */
  alert() {
    const now = performance.now();
    if (now - this.alertAt < 6000) return;
    this.alertAt = now;
    this.duck(0.25, 3500);
    this.play('alert');
  }

  pickup() {
    this.duck(0.3, 1800);
    this.play('pickup');
  }

  tone(kind) {
    if (!this.ctx || this.muted || !TONES[kind]) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    let t = ctx.currentTime;
    for (const [freq, dur] of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === 'death' ? 'sawtooth' : 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(kind === 'death' ? 0.12 : 0.16, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur * 0.85;
    }
  }
}
