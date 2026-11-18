// ─── Game configuration ─────────────────────────────────────────────────────
// Every balance number lives here so the game can be tuned without touching logic.

export const COLS = 51;
export const ROWS = 37;
export const CELLS = COLS * ROWS;

// Tile codes stored in the maze grid (Uint8Array, index = row * COLS + col).
export const T = { FLOOR: 0, WALL: 1, EXIT: 2, SPIKE: 3 };

export const MAX_LEVEL = 5;
export const LIVES = 3;
export const CURIOSITY_PER_LEVEL = 5;
export const TOTAL_CURIOSITY = MAX_LEVEL * CURIOSITY_PER_LEVEL;

export const PLAYER = {
  speed: 4.0,          // tiles per second
  radius: 0.24,        // collision half-size, in tiles
  sprintMult: 1.9,     // sprint speed multiplier
  staminaMax: 5,       // seconds of sprint
  staminaRegen: 0.6,   // seconds of sprint regained per second of rest
  regenDelay: 1.0,     // rest needed before stamina starts refilling
  exhaustedTime: 3.0,  // lock-out after draining stamina completely
  respawnShield: 2.0,  // seconds of protection after a respawn
  pickupRadius: 0.7,
};

export const GUARD = {
  coneHalf: (55 * Math.PI) / 180, // half-angle of a guard's flashlight cone
  senseRadius: 1.4,               // notices you this close even outside the cone
  catchRadius: 0.6,
  turnRate: 7,                    // radians per second
  noticeTime: 0.45,               // seconds of being seen before a chase starts
  loseTime: 2.4,                  // seconds out of sight before a chase turns into a search
  searchTime: 2.2,                // seconds spent looking around the last known spot
  repathEvery: 0.35,
};

// Level progression. Zone order follows the archive's own workflow.
//   guards: count · patrol/chase: tiles per second · vision: tiles
//   hearing: sprinting within this distance alerts a guard
//   gasStep: seconds for the gas front to advance one tile in every direction
//   gasTrigger: path distance from the spawn (in tiles) that wakes the gas up
export const LEVELS = [
  {
    zone: 'Fumigation Wing', guards: 2, patrol: 1.0, chase: 2.2, vision: 4.5, hearing: 2.5,
    gasStep: 2.8, gasTrigger: 4,
    palette: { floorA: '#39403a', floorB: '#343b35', grout: '#2a302b', accent: '#3ddc84', ambient: 'rgba(40,120,70,0.10)' },
    story: "It's 11:47 PM on campus. The Archives of Contemporary India are supposed to be locked. But you noticed the side door was left ajar. You slip in, heart racing. Two night guards are doing their rounds. Somewhere inside are 5 Curiosity Points scattered across the stacks.",
  },
  {
    zone: 'Lamination Hall', guards: 3, patrol: 1.2, chase: 2.6, vision: 5.0, hearing: 2.8,
    gasStep: 2.3, gasTrigger: 4,
    palette: { floorA: '#373c47', floorB: '#323743', grout: '#282c36', accent: '#5aa2ff', ambient: 'rgba(60,100,170,0.10)' },
    story: 'You made it to Level 2. The Lamination Hall is deeper in the archive. The fumigation cycle started earlier tonight — you can smell it faintly. The guards have company now: three of them. Navigate carefully through the tight corridors between the shelving units.',
  },
  {
    zone: 'Scanning Block', guards: 3, patrol: 1.4, chase: 2.9, vision: 5.5, hearing: 3.0,
    gasStep: 1.8, gasTrigger: 10,
    palette: { floorA: '#33404a', floorB: '#2e3a44', grout: '#253039', accent: '#7fd3ff', ambient: 'rgba(80,170,230,0.10)' },
    story: 'The Scanning Block. Banks of overhead digitisation equipment cast pale blue light across the corridors. Three guards patrol in overlapping routes. The gas is spreading faster now. You need to move quickly and deliberately.',
  },
  {
    zone: 'Display Gallery', guards: 4, patrol: 1.7, chase: 3.3, vision: 6.0, hearing: 3.2,
    gasStep: 1.45, gasTrigger: 10,
    palette: { floorA: '#463a37', floorB: '#403533', grout: '#33292a', accent: '#ff7eb6', ambient: 'rgba(190,80,120,0.10)' },
    story: 'The Display Gallery — normally open to researchers by appointment only. Glass cases line the walls. Every footstep echoes. Four guards on rotation. The fumigation gas spreads faster at this depth in the building.',
  },
  {
    zone: 'Storage Vault', guards: 5, patrol: 2.0, chase: 3.7, vision: 6.5, hearing: 3.4,
    gasStep: 1.15, gasTrigger: 10,
    palette: { floorA: '#423b31', floorB: '#3c362d', grout: '#302a22', accent: '#c79bff', ambient: 'rgba(150,100,220,0.10)' },
    story: 'FINAL LEVEL — The Storage Vault. Rows of acid-free boxes stretch to the ceiling and the air is dry and climate-controlled. Five guards know this vault well, and the gas spreads fastest here. This is what you came for. Complete the run.',
  },
];

// Chaos mode: the same five mazes at maximum pressure. Never ranked.
export const CHAOS = {
  guards: 10, patrol: 2.6, chase: 4.4, vision: 7.0, hearing: 4.0, gasStep: 0.75, gasTrigger: 6,
};

export const ASSETS = {
  music: 'assets/90s_NINTENDO__Video_Game_Beat_.mp3',
  alert: 'assets/Guard_alert_audio.mp3',
  pickup: 'assets/exit-and-curious-point-audio-effect.mp3',
  poster: 'assets/IDEAL_SCREEN_POP_UP.jpeg',
};

export const STORAGE_KEYS = {
  leaderboard: 'ashoka_lb_v3',
  leaderboardText: 'ashoka_lb_txt',
  playerName: 'ashoka_playername',
  muted: 'ashoka_muted',
  pending: 'ashoka_lb_pending', // ranked runs not yet accepted by the shared board
};

// Shared Google Sheets leaderboard (Apps Script web app, source in server/leaderboard/Code.gs).
// GET ?v=2 returns { version: 2, entries }; POST { entry } adds one run and returns the new board.
export const LEADERBOARD_URL =
  'https://script.google.com/macros/s/AKfycbw-nRDxfqzGiHvNlLePtz0i1kCiIup5VlE6jwe98_r_VcuGestH2Onp6zClhWhQpvRGuQ/exec';

// Kiosk attract screen: shown after this long without any input.
export const IDLE_SECONDS = { menu: 45, playing: 60 };

export const CREDITS = {
  author: 'Lazarous Moyo',
  line: 'ASP26 · UG24 · Media Studies & CS · © 2026',
  linkedin: 'https://www.linkedin.com/in/lazarous-moyo/',
};
