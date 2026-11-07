// Heure du jour : teinte, luminosité, saturation et contraste à une heure donnée, interpolés entre
// les quatre moments clés (aube 6 h, jour 12 h, crépuscule 19 h, nuit 23 h). Ne dépend pas d'Owlbear.

import type { TimeKey } from "../state";

export interface Light {
  tint: { x: number; y: number; z: number };
  bright: number;
  sat: number;
  contr: number;
}

/**
 * Réglages de chaque moment, hors couleur (choisie par le MJ). `amount` : part de la couleur dans
 * la teinte finale ; la couleur est d'abord ramenée à sa pleine luminosité, pour teinter sans
 * assombrir (l'assombrissement vient de `bright`).
 */
const MOMENTS: Record<TimeKey, Omit<Light, "tint"> & { amount: number }> = {
  dawn: { bright: 0.95, sat: 0.92, contr: 1, amount: 0.45 },
  day: { bright: 1, sat: 1, contr: 1, amount: 0.2 },
  dusk: { bright: 0.88, sat: 1.05, contr: 1.04, amount: 0.5 },
  night: { bright: 0.68, sat: 0.4, contr: 1.04, amount: 0.9 },
};

/**
 * Points de passage sur 24 h. La nuit tient jusqu'au petit matin, le jour tout l'après-midi :
 * on passe vite de l'un à l'autre autour de l'aube et du crépuscule.
 */
const STOPS: [number, TimeKey][] = [
  [0, "night"],
  [4.5, "night"],
  [6, "dawn"],
  [9, "day"],
  [16.5, "day"],
  [19, "dusk"],
  [21.5, "night"],
  [24, "night"],
];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Teinte d'un moment : sa couleur à pleine luminosité, dosée par `amount`. */
function tintOf(color: string, amount: number) {
  const value = Number.parseInt(color.slice(1), 16);
  const c = [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  const top = Math.max(...c, 0.001);
  const [x, y, z] = c.map((channel) => mix(1, channel / top, amount));
  return { x, y, z };
}

export function lightAt(hour: number, colors: Record<TimeKey, string>): Light {
  const h = ((hour % 24) + 24) % 24;
  let index = STOPS.findIndex(([at], i) => h >= at && h <= STOPS[i + 1][0]);
  if (index < 0) index = 0;
  const [fromAt, fromKey] = STOPS[index];
  const [toAt, toKey] = STOPS[index + 1];
  const t = toAt === fromAt ? 0 : (h - fromAt) / (toAt - fromAt);
  // Transition douce plutôt que linéaire.
  const s = t * t * (3 - 2 * t);
  const a = tintOf(colors[fromKey], MOMENTS[fromKey].amount);
  const b = tintOf(colors[toKey], MOMENTS[toKey].amount);
  return {
    tint: { x: mix(a.x, b.x, s), y: mix(a.y, b.y, s), z: mix(a.z, b.z, s) },
    bright: mix(MOMENTS[fromKey].bright, MOMENTS[toKey].bright, s),
    sat: mix(MOMENTS[fromKey].sat, MOMENTS[toKey].sat, s),
    contr: mix(MOMENTS[fromKey].contr, MOMENTS[toKey].contr, s),
  };
}
