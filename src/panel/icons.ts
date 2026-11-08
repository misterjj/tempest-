// Pictogrammes au trait, dans le style de Spellcast FX : 24 × 24, simple contour, couleur du texte.

import type { WeatherKind } from "../state";

const PATHS = {
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  rain: '<path d="M16 13a4 4 0 0 0-1-7.9A5 5 0 0 0 5.2 7 3.5 3.5 0 0 0 6 13.9"/><path d="M8 16l-1 3M12 16l-1 3M16 16l-1 3"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>',
  fog: '<path d="M3 8h13M6 12h15M3 16h11M8 20h10"/>',
  sand: '<path d="M3 8h10a2.5 2.5 0 1 0-2.5-2.5"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/><circle cx="19" cy="6" r=".6"/><circle cx="21" cy="11" r=".6"/>',
  embers: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  hail: '<path d="M16 13a4 4 0 0 0-1-7.9A5 5 0 0 0 5.2 7 3.5 3.5 0 0 0 6 13.9"/><circle cx="8" cy="17.5" r="1.3"/><circle cx="12" cy="20.5" r="1.3"/><circle cx="16" cy="17.5" r="1.3"/>',
  leaves: '<path d="M5 19C5 11 10 5 20 4c-1 10-7 15-15 15z"/><path d="M5 19l8-8"/>',
  fireflies: '<circle cx="7" cy="8" r="1.5"/><circle cx="17" cy="6" r="1"/><circle cx="15" cy="15" r="2"/><circle cx="6.5" cy="18" r="1"/><path d="M15 10.5v1M15 18.5v1M10.5 15h1M18.5 15h1"/>',
  clouds: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6 1.5A4 4 0 0 0 7 19z"/>',
  sunrays: '<circle cx="6" cy="6" r="2.5"/><path d="M10 10l9 9M7.5 13l6 6M13 7.5l6 6"/>',
  wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2"/><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2"/><path d="M9.8 4.4A2 2 0 1 1 11 8H2"/>',
  heat: '<path d="M8 20c-2-3 2-5 0-8s2-5 0-8M13 20c-2-3 2-5 0-8s2-5 0-8M18 20c-2-3 2-5 0-8s2-5 0-8"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M12 20V4M6 10l6-6 6 6"/>',
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName, className = "") =>
  `<svg class="icon ${className}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;

export const weatherIcon = (kind: WeatherKind) => icon(kind);
