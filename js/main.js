// ─── App shell ──────────────────────────────────────────────────────────────
// Connects the simulation, renderer, input, audio and leaderboard to the page.
// One state machine decides which screen is visible and whether the world is ticking.
import {
  CHAOS, CURIOSITY_PER_LEVEL, IDLE_SECONDS, LEVELS, LIVES, MAX_LEVEL, PLAYER, STORAGE_KEYS, TOTAL_CURIOSITY,
} from './config.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { AudioManager } from './audio.js';
import { svgIcon } from './icons.js';
import {
  RATINGS, cleanName, fetchBoard, formatTime, isNameTakenByOther, loadLocal, submitRun, tierName,
} from './leaderboard.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), hud: $('hud'), panel: $('panel'), board: $('board'), canvas: $('game'), minimap: $('minimap'),
  overlay: $('overlay'), toast: $('toast'), stick: $('stick'), stickKnob: $('stickKnob'), touch: $('touchControls'),
  tSprint: $('tSprint'), tCheckpoint: $('tCheckpoint'),
  hudLevel: $('hudLevel'), hudZone: $('hudZone'), hudTime: $('hudTime'), hudCurio: $('hudCurio'),
  hudGas: $('hudGas'), hudGasText: $('hudGasText'), hudLives: $('hudLives'), hudRank: $('hudRank'),
  btnMute: $('btnMute'), btnPause: $('btnPause'),
  curioSlots: $('curioSlots'), curioTotal: $('curioTotal'), staminaFill: $('staminaFill'), staminaText: $('staminaText'),
  checkpointText: $('checkpointText'),
  nameForm: $('nameForm'), nameInput: $('nameInput'), nameError: $('nameError'), padHint: $('padHint'),
  levelGrid: $('levelGrid'),
  introLevel: $('introLevel'), introZone: $('introZone'), introStory: $('introStory'), introChips: $('introChips'),
  introMode: $('introMode'), btnBegin: $('btnBegin'),
  pauseWhere: $('pauseWhere'), pauseStats: $('pauseStats'),
  cardImage: $('cardImage'), cardCount: $('cardCount'), cardIcon: $('cardIcon'), cardName: $('cardName'),
  cardFacts: $('cardFacts'), cardTimer: $('cardTimer'), btnCardClose: $('btnCardClose'),
  deathCard: $('deathCard'), deathIcon: $('deathIcon'), deathTitle: $('deathTitle'), deathReason: $('deathReason'),
  deathTip: $('deathTip'), deathLives: $('deathLives'), deathMeta: $('deathMeta'), btnRetry: $('btnRetry'),
  btnDeathNew: $('btnDeathNew'),
  doneZone: $('doneZone'), doneTitle: $('doneTitle'), doneStats: $('doneStats'), doneNext: $('doneNext'),
  winCard: $('winCard'), winRating: $('winRating'), winLabel: $('winLabel'), winMessage: $('winMessage'),
  winStats: $('winStats'), winBoard: $('winBoard'), winSync: $('winSync'),
  boardTable: $('boardTable'), boardSync: $('boardSync'),
};

const SCREENS = {
  menu: 'screen-menu', howto: 'screen-howto', levels: 'screen-levels', board: 'screen-board', intro: 'screen-intro',
  paused: 'screen-pause', card: 'screen-card', dead: 'screen-death', levelDone: 'screen-level-done', win: 'screen-win',
  idle: 'screen-idle',
};
const CARD_LOCK_MS = 700; // stops a held key or button from closing a story card instantly

const DEATHS = {
  guard: {
    icon: 'guard', accent: '#ff5a5a', title: 'You were caught',
    reason: 'A guard apprehended you in the Archives. You have been taken to the CADI — Committee Against Disciplinary Infractions.',
    tip: "Guards can't see through the shelves. Duck into a side corridor and break their line of sight — they'll search, then give up.",
  },
  gas: {
    icon: 'gas', accent: '#3ddc84', title: 'You have been fumigated',
    reason: 'The fumigation gas overtook you in the corridors. You are being rushed to the Ashoka Infirmary for treatment.',
    tip: 'The gas starts at the entrance and spreads one tile at a time. Keep moving — the HUD turns green, then red, as it closes in.',
  },
  spike: {
    icon: 'spike', accent: '#ffb340', title: 'You hit a spike trap',
    reason: 'You walked straight into a spike trap hidden between the shelves.',
    tip: 'Spikes have a red warning border, and there is always a spike-free route around them.',
  },
};

// ── Core objects ──────────────────────────────────────────────────────────────
const audio = new AudioManager();
const input = new Input();
const renderer = new Renderer(el.canvas);
const mctx = el.minimap.getContext('2d');
const game = new Game((type, data) => onGameEvent(type, data));

let state = 'menu';
let running = false;       // a run is in progress (HUD + panel visible)
let returnTo = 'menu';     // where Back goes from How to play / Leaderboard
let idleReturn = 'menu';
let ignoreActionsUntil = 0;
let cardOpenedAt = 0;
let pendingTimer = 0;
let nameWarned = '';
let lastRun = { startLevel: 1, chaos: false };
let lastResultEntry = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    node.outerHTML = svgIcon(node.dataset.icon, { size: 20 });
  });
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconNode(name, size = 18) {
  const span = document.createElement('span');
  span.innerHTML = svgIcon(name, { size });
  return span.firstChild;
}

function chip(icon, text, extra = '') {
  const c = make('span', `chip ${extra}`.trim());
  c.append(iconNode(icon, 16), document.createTextNode(text));
  return c;
}

function stat(label, value) {
  const s = make('div', 'stat');
  s.append(make('div', 'stat__label', label), make('div', 'stat__value', value));
  return s;
}

function setButtonLabel(btn, icon, text) {
  btn.replaceChildren(...(icon ? [iconNode(icon, 18)] : []), document.createTextNode(text));
}

function renderLives(container, left, total = LIVES) {
  const key = `${left}/${total}`;
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  container.replaceChildren();
  for (let i = 0; i < total; i++) {
    const h = make('span', i < left ? 'heart' : 'heart is-lost');
    h.append(iconNode('heart', 18));
    container.append(h);
  }
  container.setAttribute('aria-label', `${left} of ${total} lives left`);
}

function gasLabel(step) {
  if (step >= 2.5) return 'slow';
  if (step >= 2) return 'steady';
  if (step >= 1.6) return 'quick';
  if (step >= 1.3) return 'fast';
  if (step >= 1) return 'very fast';
  return 'extreme';
}

const toast = (() => {
  let timer = 0;
  return (text, kind = '', ms = 2200) => {
    el.toast.textContent = text;
    el.toast.className = `toast is-visible${kind ? ` toast--${kind}` : ''}`;
    clearTimeout(timer);
    timer = setTimeout(() => el.toast.classList.remove('is-visible'), ms);
  };
})();

function savedName() {
  try { return localStorage.getItem(STORAGE_KEYS.playerName) || ''; } catch { return ''; }
}

function later(fn, ms) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(fn, ms);
}

// ── State machine ─────────────────────────────────────────────────────────────
function setState(next, { focus = true } = {}) {
  state = next;
  el.app.dataset.state = next;
  const screenId = SCREENS[next];
  el.overlay.hidden = !screenId;
  for (const [key, id] of Object.entries(SCREENS)) $(id).hidden = key !== next;

  input.captureKeys = next === 'playing';
  el.app.dataset.running = String(running);
  el.hud.hidden = !running;
  el.panel.hidden = !running;
  el.touch.hidden = !(running && next === 'playing' && input.touchCapable);
  if (next !== 'playing') { el.stick.hidden = true; input.clear(); }

  if (next === 'playing') {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    audio.playMusic();
  } else if (next === 'paused' || next === 'menu' || next === 'idle') {
    audio.pauseMusic();
  }
  if (screenId && focus) requestAnimationFrame(() => focusScreen(screenId));
}

function focusScreen(screenId) {
  const screen = $(screenId);
  if (!screen || screen.hidden) return;
  if (screenId === 'screen-menu' && !el.nameInput.value && !input.touchCapable) {
    el.nameInput.focus({ preventScroll: true });
    return;
  }
  const target = screen.querySelector('[data-autofocus]:not([hidden])') || focusables(screen)[0];
  if (target) target.focus({ preventScroll: true });
}

function focusables(root) {
  return [...root.querySelectorAll('button, input, a[href]')].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
}

function openSub(next) {
  returnTo = state;
  setState(next);
}

function back() {
  setState(returnTo || 'menu');
}

function goMenu() {
  clearTimeout(pendingTimer);
  running = false;
  game.loadPreview(game.level || 1);
  returnTo = 'menu';
  setState('menu');
}

// ── Runs ──────────────────────────────────────────────────────────────────────
function readName({ required }) {
  const name = cleanName(el.nameInput.value);
  el.nameInput.value = name;
  if (name.length < 2) {
    if (!required) return 'EXPLORER';
    el.nameError.textContent = 'Enter at least 2 letters or numbers to appear on the leaderboard.';
    el.nameInput.setAttribute('aria-invalid', 'true');
    el.nameInput.focus();
    return null;
  }
  if (required && nameWarned !== name && isNameTakenByOther(name, savedName())) {
    nameWarned = name;
    el.nameError.textContent = `${name} is already on this device's leaderboard. Press Start again to play as ${name} (only the best run counts), or choose another name.`;
    el.nameInput.setAttribute('aria-invalid', 'true');
    return null;
  }
  el.nameError.textContent = '';
  el.nameInput.removeAttribute('aria-invalid');
  try { localStorage.setItem(STORAGE_KEYS.playerName, name); } catch { /* storage unavailable */ }
  return name;
}

function beginRun({ startLevel = 1, chaos = false }) {
  const ranked = !chaos && startLevel === 1;
  const name = readName({ required: ranked });
  if (!name) return;
  audio.unlock();
  lastRun = { startLevel, chaos };
  lastResultEntry = null;
  game.startRun({ startLevel, chaos, name });
  running = true;
  el.hudRank.textContent = chaos ? 'Chaos' : ranked ? 'Ranked' : 'Practice';
  el.hudRank.className = `chip ${chaos ? 'chip--danger' : ranked ? 'chip--good' : 'chip--quiet'}`;
  buildCurioSlots();
  showIntro();
}

function restartRun() {
  beginRun(lastRun);
}

function showIntro() {
  const z = game.zone;
  const d = game.diff;
  el.introLevel.textContent = `Level ${game.level} of ${MAX_LEVEL}`;
  el.introZone.textContent = z.zone;
  el.introStory.textContent = z.story;
  el.introChips.replaceChildren(
    chip('guard', `${d.guards} guards`),
    chip('gas', `Gas: ${gasLabel(d.gasStep)}`),
    chip('star', `${CURIOSITY_PER_LEVEL} Curiosity Points`, 'chip--amber'),
    chip('heart', `${LIVES - game.deaths} ${LIVES - game.deaths === 1 ? 'life' : 'lives'} left`),
  );
  el.introMode.textContent = game.chaos
    ? `Chaos mode — ${CHAOS.guards} guards per level, not ranked`
    : game.ranked ? 'Ranked run — only active play time counts' : 'Practice run — not ranked';
  setButtonLabel(el.btnBegin, 'play', `Enter the ${z.zone}`);
  el.introZone.closest('.card').style.setProperty('--accent', z.palette.accent);
  updateHud(true);
  setState('intro');
}

function startPlaying() {
  audio.unlock();
  setState('playing');
}

function pause() {
  if (state !== 'playing') return;
  el.pauseWhere.textContent = `Level ${game.level} · ${game.zone.zone}`;
  el.pauseStats.replaceChildren(
    chip('clock', formatTime(game.runTime)),
    chip('star', `${game.curioTotal}/${TOTAL_CURIOSITY}`, 'chip--amber'),
    chip('heart', `${LIVES - game.deaths} left`),
  );
  setState('paused');
}

function restartLevel() {
  clearTimeout(pendingTimer);
  game.restartLevel();
  updateHud(true);
  setState('playing');
  toast('Level restarted', 'info');
}

function saveCheckpoint() {
  if (state === 'playing') game.saveCheckpoint();
}

// ── Game events ───────────────────────────────────────────────────────────────
function onGameEvent(type, data) {
  switch (type) {
    case 'pickup': {
      audio.pickup();
      renderer.burst(data.c + 0.5, data.r + 0.5, data.color, 28, 3.4);
      renderer.ring(data.c + 0.5, data.r + 0.5, data.color);
      showCard(data);
      break;
    }
    case 'death': {
      const fx = { guard: '#ff5a5a', gas: '#3ddc84', spike: '#ffb340' }[data.cause];
      renderer.burst(game.lastDeath.x, game.lastDeath.y, fx, 34, 3.8);
      renderer.shakeScreen(14 * renderer.dpr);
      audio.tone('death');
      audio.duck(0.25, 1600);
      setState('dying');
      later(() => showDeath(data), 950);
      break;
    }
    case 'levelComplete':
      audio.tone('level');
      renderer.burst(game.exit.c + 0.5, game.exit.r + 0.5, '#3ddc84', 36, 3.6);
      setState('dying');
      later(() => showLevelDone(data), 650);
      break;
    case 'runComplete':
      audio.tone('level');
      renderer.burst(game.exit.c + 0.5, game.exit.r + 0.5, '#f0dca0', 50, 4.2);
      setState('dying');
      later(() => showWin(data), 750);
      break;
    case 'alert':
      audio.alert();
      toast('Spotted! Break line of sight', 'danger', 1800);
      break;
    case 'gasStart':
      audio.tone('gas');
      toast('Fumigation started — the gas is spreading from the entrance', 'good', 3200);
      break;
    case 'checkpoint':
      audio.tone('checkpoint');
      renderer.ring(data.x, data.y, '#5aa2ff');
      renderer.burst(data.x, data.y, '#5aa2ff', 14, 2);
      toast('Checkpoint saved', 'info');
      break;
    case 'checkpointDenied':
      audio.tone('denied');
      toast("Can't save a checkpoint here", 'danger', 1600);
      break;
    case 'exhausted':
      toast('Out of breath — sprint recovers in a moment', '', 1800);
      break;
    default:
  }
}

function showCard(item) {
  el.cardImage.src = item.image;
  el.cardImage.alt = `${item.name.toLowerCase()} at the Archives`;
  el.cardCount.textContent = `Curiosity Point ${game.levelCurio} of ${CURIOSITY_PER_LEVEL} · ${game.curioTotal}/${TOTAL_CURIOSITY} this run`;
  el.cardIcon.innerHTML = svgIcon(item.id, { size: 30 });
  el.cardName.textContent = item.name;
  el.cardFacts.innerHTML = item.facts; // trusted static content from knowledge.js
  el.cardFacts.scrollTop = 0;
  $('screen-card').querySelector('.knowledge').style.setProperty('--accent', item.color);
  cardOpenedAt = performance.now();
  el.cardTimer.style.transition = 'none';
  el.cardTimer.style.transform = 'scaleX(0)';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.cardTimer.style.transition = `transform ${CARD_LOCK_MS}ms linear`;
    el.cardTimer.style.transform = 'scaleX(1)';
  }));
  updateHud(true);
  setState('card');
}

function closeCard() {
  if (state !== 'card' || performance.now() - cardOpenedAt < CARD_LOCK_MS) return;
  setState('playing');
}

function showDeath({ cause, livesLeft, gameOver }) {
  const info = DEATHS[cause];
  el.deathCard.style.setProperty('--accent', gameOver ? '#ff5a5a' : info.accent);
  el.deathIcon.innerHTML = svgIcon(info.icon, { size: 32 });
  el.deathTitle.textContent = gameOver ? 'Game over' : info.title;
  el.deathReason.textContent = gameOver ? `${info.reason} That was your last life.` : info.reason;
  el.deathTip.textContent = info.tip;
  renderLives(el.deathLives, livesLeft);
  el.deathMeta.textContent = gameOver
    ? `Reached Level ${game.level} · ${game.curioTotal}/${TOTAL_CURIOSITY} Curiosity Points · ${formatTime(game.runTime)}`
    : game.checkpoint ? 'You will return to your checkpoint with the points you had when you saved it.'
      : 'No checkpoint saved — you will restart this level. Press C to save one next time.';
  el.btnRetry.hidden = gameOver;
  el.btnDeathNew.className = gameOver ? 'btn btn--primary' : 'btn btn--ghost';
  if (gameOver) el.btnDeathNew.dataset.autofocus = ''; else delete el.btnDeathNew.dataset.autofocus;
  updateHud(true);
  setState('dead');
}

function retry() {
  if (game.deaths >= LIVES) return;
  game.retry();
  updateHud(true);
  setState('playing');
}

function showLevelDone(stats) {
  el.doneZone.textContent = `Level ${stats.level} · ${stats.zone}`;
  el.doneTitle.textContent = stats.curio === CURIOSITY_PER_LEVEL ? 'Wing cleared — every secret found' : 'Level complete';
  el.doneStats.replaceChildren(
    stat('Level time', formatTime(stats.timeMs)),
    stat('Curiosity', `${stats.curio}/${CURIOSITY_PER_LEVEL}`),
    stat('Deaths', String(stats.levelDeaths)),
    stat('Score', String(stats.score)),
  );
  const nz = LEVELS[stats.level];
  const nd = game.chaos ? { ...nz, ...CHAOS } : nz;
  el.doneNext.replaceChildren(
    document.createTextNode(`Next · Level ${stats.level + 1}`), make('br'), make('b', '', nz.zone), make('br'),
    document.createTextNode(`${nd.guards} guards · gas ${gasLabel(nd.gasStep)}`),
  );
  updateHud(true);
  setState('levelDone');
}

function nextLevel() {
  game.nextLevel();
  updateHud(true);
  showIntro();
}

function showWin(result) {
  const r = RATINGS[result.rating];
  el.winCard.style.setProperty('--rating', r.color);
  el.winRating.textContent = result.rating;
  el.winLabel.textContent = r.label;
  el.winMessage.textContent = r.message;
  el.winStats.replaceChildren(
    stat('Total time', formatTime(result.timeMs)),
    stat('Curiosity', `${result.curio}/${TOTAL_CURIOSITY}`),
    stat('Deaths', String(result.deaths)),
    stat('Mode', result.chaos ? 'Chaos' : result.ranked ? 'Ranked' : 'Practice'),
  );
  if (result.ranked) {
    const { entries, entry, sync } = submitRun(result);
    lastResultEntry = entry;
    renderBoard(el.winBoard, entries, entry);
    el.winSync.textContent = 'Saving to the shared leaderboard…';
    sync.then(({ entries: merged, online }) => {
      renderBoard(el.winBoard, merged, entry);
      const placed = merged.findIndex((e) => e.playerName === entry.playerName && e.timeMs === entry.timeMs);
      const where = placed >= 0 ? `You placed #${placed + 1} — ${tierName(placed)} tier.` : 'Your best run on the board is shown above.';
      el.winSync.textContent = online ? where
        : `${where} Saved on this device — it will upload to the shared board when the connection is back.`;
    });
  } else {
    renderBoard(el.winBoard, loadLocal(), null);
    el.winSync.textContent = result.chaos
      ? 'Chaos runs are not ranked — start a ranked run from the menu to make the board.'
      : 'Practice runs are not ranked — start at Level 1 from the menu to make the board.';
  }
  updateHud(true);
  setState('win');
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
function renderBoard(container, entries, highlight) {
  container.replaceChildren();
  const table = make('table');
  const head = make('tr');
  [['#', 'num'], ['Explorer', ''], ['Rank', ''], ['Time', 'num'], ['Curiosity', 'num'], ['Tier', '']].forEach(([t, c]) => {
    const th = make('th', c, t);
    th.scope = 'col';
    head.append(th);
  });
  const thead = make('thead');
  thead.append(head);
  const tbody = make('tbody');
  if (!entries.length) {
    const tr = make('tr');
    const td = make('td', 'empty', 'No runs yet — be the first explorer on the board.');
    td.colSpan = 6;
    tr.append(td);
    tbody.append(tr);
  }
  entries.forEach((e, i) => {
    const tr = make('tr');
    if (highlight && e.playerName === highlight.playerName && e.timeMs === highlight.timeMs) tr.className = 'is-you';
    const rating = RATINGS[e.rating];
    const badge = make('span', 'rank-badge', e.rating);
    badge.style.background = rating.color;
    badge.title = rating.label;
    const rankCell = make('td');
    rankCell.append(badge);
    const tier = make('td', 'tier', tierName(i));
    tier.style.color = ['#ff9f1c', '#ffd23f', '#5aa2ff'][i] || 'var(--text-2)';
    tr.append(make('td', 'num', String(i + 1)), make('td', '', e.playerName), rankCell,
      make('td', 'num', formatTime(e.timeMs)), make('td', 'num', `${e.curiosity}/${TOTAL_CURIOSITY}`), tier);
    tbody.append(tr);
  });
  table.append(thead, tbody);
  container.append(table);
}

function openBoard() {
  if (state === 'playing') pause();
  openSub('board');
  renderBoard(el.boardTable, loadLocal(), lastResultEntry);
  el.boardSync.textContent = 'Loading the shared leaderboard…';
  fetchBoard().then(({ entries, online }) => {
    if (state !== 'board') return;
    renderBoard(el.boardTable, entries, lastResultEntry);
    el.boardSync.textContent = online ? 'Live — shared across every Archives kiosk.' : 'Offline — showing results saved on this device.';
  });
}

// ── HUD & panel ───────────────────────────────────────────────────────────────
const hudCache = {};
function setText(node, key, text) {
  if (hudCache[key] === text) return false;
  hudCache[key] = text;
  node.textContent = text;
  return true;
}
function setClass(node, key, cls) {
  if (hudCache[key] === cls) return;
  hudCache[key] = cls;
  node.className = cls;
}

function buildCurioSlots() {
  el.curioSlots.replaceChildren();
  game.items.forEach((item) => {
    const li = make('li');
    li.style.setProperty('--slot', item.color);
    li.title = item.name;
    li.append(iconNode(item.id, 22));
    el.curioSlots.append(li);
  });
  hudCache.slots = '';
}

function updateHud(force = false) {
  if (!running || !game.player) return;
  if (force) for (const k of Object.keys(hudCache)) delete hudCache[k];
  const p = game.player;
  if (setText(el.hudLevel, 'level', `${game.level}/${MAX_LEVEL}`)) el.hudLevel.setAttribute('aria-label', `Level ${game.level} of ${MAX_LEVEL}`);
  setText(el.hudZone, 'zone', game.zone.zone);
  setText(el.hudTime, 'time', formatTime(game.runTime).slice(0, -1));
  setText(el.hudCurio, 'curio', `${game.levelCurio}/${CURIOSITY_PER_LEVEL}`);
  renderLives(el.hudLives, Math.max(0, LIVES - game.deaths));

  const gas = game.gas;
  let gasText = 'Gas dormant';
  let gasCls = 'chip';
  if (gas.active) {
    if (gas.near === 0 || (gas.near !== null && gas.near <= 4)) { gasText = 'Gas close!'; gasCls = 'chip chip--gas-close'; }
    else if (gas.near !== null && gas.near <= 9) { gasText = 'Gas nearby'; gasCls = 'chip chip--gas-near'; }
    else { gasText = 'Gas spreading'; gasCls = 'chip chip--warn'; }
  }
  setText(el.hudGasText, 'gasText', gasText);
  setClass(el.hudGas, 'gasCls', gasCls);
  el.hudGas.title = gasText;

  if (el.panel.offsetParent === null) return; // panel hidden on narrow screens
  const slots = game.items.map((it) => (it.got ? 1 : 0)).join('');
  if (hudCache.slots !== slots) {
    hudCache.slots = slots;
    [...el.curioSlots.children].forEach((li, i) => li.classList.toggle('is-got', !!game.items[i]?.got));
  }
  setText(el.curioTotal, 'curioTotal', `Run total ${game.curioTotal}/${TOTAL_CURIOSITY}`);
  const pct = Math.round((p.stamina / PLAYER.staminaMax) * 100);
  if (hudCache.stamina !== pct) { hudCache.stamina = pct; el.staminaFill.style.width = `${pct}%`; }
  setClass(el.staminaFill, 'staminaCls', `meter__fill${p.exhausted > 0 ? ' is-exhausted' : p.sprinting ? ' is-sprinting' : ''}`);
  setText(el.staminaText, 'staminaText', p.exhausted > 0 ? `Exhausted — ${p.exhausted.toFixed(1)}s`
    : p.sprinting ? 'Sprinting — guards can hear you' : pct >= 100 ? 'Ready — hold Shift to sprint' : 'Recovering…');
  const cp = game.checkpoint;
  setText(el.checkpointText, 'cp', cp ? `Saved at row ${cp.r}, column ${cp.c} with ${cp.levelCurio} point${cp.levelCurio === 1 ? '' : 's'}` : 'None saved — press C on any floor tile');
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let last = performance.now();
let hudAt = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const move = input.read(); // polls the gamepad in every state (menus need it too)
  if (state === 'playing') game.update(dt, move);
  renderer.draw(game, now);

  const showMini = running && renderer.mode === 'follow' && !game.preview;
  el.minimap.hidden = !showMini;
  if (showMini) {
    const dpr = renderer.dpr || 1;
    const w = Math.round(el.minimap.clientWidth * dpr);
    const h = Math.round(el.minimap.clientHeight * dpr);
    if (w && (el.minimap.width !== w || el.minimap.height !== h)) { el.minimap.width = w; el.minimap.height = h; }
    renderer.drawMinimap(mctx, game, el.minimap.width, el.minimap.height);
  }
  if (now - hudAt > 100) { hudAt = now; updateHud(); }
  checkIdle(now);
  requestAnimationFrame(frame);
}

// ── Idle / attract screen ─────────────────────────────────────────────────────
function checkIdle(now) {
  if (state === 'idle' || state === 'dying') return;
  const limit = (state === 'menu' ? IDLE_SECONDS.menu : IDLE_SECONDS.playing) * 1000;
  if (now - input.lastActivity < limit) return;
  if (state === 'playing') pause();
  idleReturn = state;
  setState('idle', { focus: false });
}

function dismissIdle() {
  if (state !== 'idle') return;
  ignoreActionsUntil = performance.now() + 350;
  input.lastActivity = performance.now();
  setState(idleReturn);
}

// Swallow the key that wakes the attract screen so it doesn't also press something.
window.addEventListener('keydown', (e) => {
  audio.unlock();
  if (state !== 'idle') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  dismissIdle();
}, { capture: true });
window.addEventListener('pointerdown', () => audio.unlock(), { capture: true, passive: true });
window.addEventListener('wheel', () => input.activity(), { passive: true });
window.addEventListener('pointermove', () => { input.lastActivity = performance.now(); }, { passive: true });
$('screen-idle').addEventListener('click', dismissIdle);
input.on('activity', () => { if (state === 'idle') dismissIdle(); });

// ── Input actions ─────────────────────────────────────────────────────────────
input.on('action', ({ action, source }) => {
  if (performance.now() < ignoreActionsUntil || state === 'idle') return;
  switch (action) {
    case 'mute': toggleMute(); return;
    case 'pause':
      if (state === 'playing') pause();
      else if (state === 'paused') setState('playing');
      else if (state === 'card') closeCard();
      else if (state === 'howto' || state === 'board' || state === 'levels') back();
      return;
    case 'back':
      if (state === 'paused') setState('playing');
      else if (state === 'card') closeCard();
      else if (state === 'howto' || state === 'board' || state === 'levels') back();
      return;
    case 'restart':
      if (state === 'playing' || state === 'paused') restartLevel();
      return;
    case 'checkpoint':
      saveCheckpoint();
      return;
    case 'leaderboard':
      if (['menu', 'playing', 'paused', 'win', 'dead'].includes(state)) openBoard();
      return;
    case 'confirm': {
      if (source !== 'pad' || state === 'playing' || state === 'dying') return;
      const screen = $(SCREENS[state]);
      if (!screen) return;
      const active = document.activeElement;
      if (active && screen.contains(active) && active.tagName === 'BUTTON') active.click();
      else if (active === el.nameInput) beginRun({ startLevel: 1, chaos: false });
      else {
        const target = screen.querySelector('[data-autofocus]:not([hidden])') || focusables(screen)[0];
        if (target) target.click();
      }
      return;
    }
    default:
  }
});

input.on('nav', (dir) => {
  if (state === 'playing' || state === 'dying' || state === 'idle') return;
  const screen = $(SCREENS[state]);
  if (!screen) return;
  const list = focusables(screen);
  if (!list.length) return;
  const i = list.indexOf(document.activeElement);
  const next = list[(i + dir + list.length) % list.length] || list[0];
  next.focus({ preventScroll: false });
});

input.on('padconnected', () => {
  el.padHint.replaceChildren(iconNode('gamepad', 16), document.createTextNode('Controller connected — A to select, B to go back'));
  toast('Controller connected', 'info');
});
input.on('paddisconnected', () => {
  if (state === 'playing') pause();
  toast('Controller disconnected', 'danger');
});

// Touch thumbstick visuals.
input.on('stick', (t) => {
  if (!t.active || state !== 'playing') { el.stick.hidden = true; return; }
  const rect = el.board.getBoundingClientRect();
  el.stick.hidden = false;
  el.stick.style.left = `${t.ox - rect.left}px`;
  el.stick.style.top = `${t.oy - rect.top}px`;
  el.stickKnob.style.transform = `translate(${t.vx * 32}px, ${t.vy * 32}px)`;
});
input.attachTouch(el.board, el.tSprint, 52);
el.tCheckpoint.addEventListener('pointerdown', (e) => e.stopPropagation());
el.tCheckpoint.addEventListener('click', () => saveCheckpoint());

// ── Buttons ───────────────────────────────────────────────────────────────────
function toggleMute() {
  audio.unlock();
  audio.setMuted(!audio.muted);
  if (audio.muted) audio.pauseMusic(); else if (state === 'playing') audio.playMusic(); else audio.pauseMusic();
  syncMute();
  toast(audio.muted ? 'Sound off' : 'Sound on', 'info', 1200);
}
function syncMute() {
  el.btnMute.replaceChildren(iconNode(audio.muted ? 'mute' : 'sound', 20));
  el.btnMute.setAttribute('aria-label', audio.muted ? 'Turn sound on' : 'Mute sound');
  el.btnMute.setAttribute('aria-pressed', String(audio.muted));
  setButtonLabel($('btnPauseSound'), audio.muted ? 'mute' : 'sound', audio.muted ? 'Sound off' : 'Sound on');
}

const on = (node, fn) => node.addEventListener('click', fn);
on($('btnStart'), () => beginRun({ startLevel: 1, chaos: false }));
on($('btnLevels'), () => openSub('levels'));
on($('btnChaos'), () => beginRun({ startLevel: 1, chaos: true }));
on($('btnBoard'), openBoard);
on($('btnHowto'), () => openSub('howto'));
el.nameForm.addEventListener('submit', (e) => { e.preventDefault(); beginRun({ startLevel: 1, chaos: false }); });
el.nameInput.addEventListener('input', () => {
  el.nameError.textContent = '';
  el.nameInput.removeAttribute('aria-invalid');
  nameWarned = '';
});
document.querySelectorAll('[data-back]').forEach((b) => on(b, back));
on(el.btnBegin, startPlaying);
on($('btnResume'), () => setState('playing'));
on($('btnRestart'), restartLevel);
on($('btnPauseHowto'), () => openSub('howto'));
on($('btnPauseBoard'), openBoard);
on($('btnQuit'), goMenu);
on($('btnPauseSound'), toggleMute);
on(el.btnCardClose, closeCard);
on(el.btnRetry, retry);
on(el.btnDeathNew, restartRun);
on($('btnDeathMenu'), goMenu);
on($('btnNext'), nextLevel);
on($('btnWinNew'), restartRun);
on($('btnWinMenu'), goMenu);
on(el.btnMute, () => { toggleMute(); el.btnMute.blur(); });
on(el.btnPause, () => { pause(); });

// Pause when the window loses focus or the tab is hidden (keys can't get stuck either way).
window.addEventListener('blur', () => pause());
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

// ── Boot ──────────────────────────────────────────────────────────────────────
function buildLevelGrid() {
  el.levelGrid.replaceChildren();
  LEVELS.forEach((z, i) => {
    const b = make('button', 'level-card');
    b.type = 'button';
    b.style.setProperty('--accent', z.palette.accent);
    b.append(make('span', 'level-card__num', String(i + 1)), make('span', 'level-card__zone', z.zone),
      make('span', 'level-card__meta', `${z.guards} guards · gas ${gasLabel(z.gasStep)}`));
    b.setAttribute('aria-label', `Level ${i + 1}: ${z.zone}, ${z.guards} guards`);
    on(b, () => beginRun({ startLevel: i + 1, chaos: false }));
    b.addEventListener('focus', () => { if (state === 'levels') game.loadPreview(i + 1); });
    b.addEventListener('pointerenter', () => { if (state === 'levels') game.loadPreview(i + 1); });
    el.levelGrid.append(b);
  });
}

fillIcons();
buildLevelGrid();
syncMute();
el.nameInput.value = savedName();
game.loadPreview(1);

new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  renderer.resize(width, height);
}).observe(el.board);
renderer.resize(el.board.clientWidth, el.board.clientHeight);

setState('menu');
requestAnimationFrame(frame);

// Test hook for automated browser checks: only with ?debug in the URL.
if (new URLSearchParams(location.search).has('debug')) window.ashoka = { game, input, renderer, get state() { return state; } };
