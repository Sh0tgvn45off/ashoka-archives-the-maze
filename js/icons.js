// ─── Icons ──────────────────────────────────────────────────────────────────
// Line icons on a 24×24 grid. The same path data is drawn on the canvas (Path2D) and in
// the DOM (inline SVG), so the map, the HUD and the menus always match.
export const ICON_PATHS = {
  // Curiosity Points (archive processes)
  fumigation: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.2 4.2 0 0 0 7 18z',
  lamination: 'M12 4 3 9l9 5 9-5-9-5zM3 14l9 5 9-5',
  scanning: 'M16 10.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM14.6 14.6 20 20',
  display: 'M4 5h16v14H4zM7 16l3.5-4 3 3 2-2 2.5 3',
  storage: 'M4 8l8-4 8 4v9l-8 4-8-4zM4 8l8 4 8-4M12 12v9',
  // HUD & UI
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z',
  gas: 'M5 9h9a3 3 0 1 0-3-3M3 13h14a3 3 0 1 1-3 3M6 17h4',
  guard: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z',
  spike: 'M3 20l4-9 3 6 2-11 2 11 3-6 4 9z',
  exit: 'M14 4h5v16h-5M10 8l4 4-4 4M14 12H4',
  flag: 'M6 21V4M6 4h11l-2 4 2 4H6',
  bolt: 'M13 3 5 13h6l-1 8 8-10h-6z',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4v16l13-8z',
  sound: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4',
  gamepad: 'M7 9h10a4 4 0 0 1 4 4l.5 3a2.5 2.5 0 0 1-4.4 1.8L15.5 16h-7l-1.6 1.8A2.5 2.5 0 0 1 2.5 16L3 13a4 4 0 0 1 4-4zM8 11v4M6 13h4M16 12h.01M18 14h.01',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10',
  touch: 'M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0-1a1.5 1.5 0 0 1 3 0v1m0 0a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-.7a5 5 0 0 1-4-2l-3-4a1.6 1.6 0 0 1 2.4-2L9 13',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  external: 'M14 5h5v5M19 5l-8 8M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18.5v-9A1.5 1.5 0 0 1 6.5 8H10',
};

const pathCache = new Map();
/** Path2D for canvas drawing (cached). */
export function iconPath(name) {
  if (!pathCache.has(name)) pathCache.set(name, new Path2D(ICON_PATHS[name] || ''));
  return pathCache.get(name);
}

/** Inline SVG markup. Names come from this file only (trusted), never from user input. */
export function svgIcon(name, { size = 20, stroke = 2, label = '' } = {}) {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ${a11y}><path d="${ICON_PATHS[name] || ''}"/></svg>`;
}
