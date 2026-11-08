// Limites de la salle, réglables par le MJ comme dans Spellcast FX : chaque forme et chaque effet
// est recalculé en permanence chez tous les joueurs, c'est au MJ de choisir selon le matériel de
// sa table. Ce qui existe déjà au-delà d'une nouvelle limite reste en place, mais on ne peut plus
// en ajouter. Ce fichier ne dépend pas d'Owlbear.

import { HARD_EFFECTS_PER_ZONE, HARD_LAMPS, PLUGIN_ID } from "./state";

/** Réglages de la salle (métadonnées de la salle, pas de la scène). */
export const SETTINGS_KEY = `${PLUGIN_ID}/settings`;

export interface Limits {
  /** Zones peintes par scène */
  zones: number;
  /**
   * Segments par zone. Le coût du rendu en dépend directement : mesuré à environ 0,015 ms par
   * segment et par image sur un M4 Pro, zone en plein écran.
   */
  shapes: number;
  /** Effets météo par zone */
  effects: number;
  /** Lumières par scène : chacune est calculée sur tout l'écran, à chaque image et chez chaque joueur. */
  lamps: number;
}

export const DEFAULT_LIMITS: Limits = { zones: 10, shapes: 300, effects: 6, lamps: 16 };

/** Bornes des réglages : au-delà, même une table puissante ne suivrait plus. */
export const LIMIT_RANGES: Record<keyof Limits, [number, number]> = {
  zones: [1, 40],
  shapes: [10, 2000],
  effects: [1, HARD_EFFECTS_PER_ZONE],
  lamps: [1, HARD_LAMPS],
};

/** Plus haute valeur possible : la lecture des données ne coupe jamais en dessous. */
export const HARD_LIMITS: Limits = {
  zones: LIMIT_RANGES.zones[1],
  shapes: LIMIT_RANGES.shapes[1],
  effects: LIMIT_RANGES.effects[1],
  lamps: LIMIT_RANGES.lamps[1],
};

const readLimit = (key: keyof Limits, value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= LIMIT_RANGES[key][0] && value <= LIMIT_RANGES[key][1]
    ? value
    : DEFAULT_LIMITS[key];

export function limitsIn(metadata: Record<string, unknown>): Limits {
  const settings = metadata[SETTINGS_KEY] as { limits?: Partial<Record<keyof Limits, unknown>> } | undefined;
  return {
    zones: readLimit("zones", settings?.limits?.zones),
    shapes: readLimit("shapes", settings?.limits?.shapes),
    effects: readLimit("effects", settings?.limits?.effects),
    lamps: readLimit("lamps", settings?.limits?.lamps),
  };
}

/** Une saisie hors bornes revient à la valeur permise la plus proche ; illisible, elle ne change rien. */
export function parseLimit(key: keyof Limits, raw: string, current: number) {
  const value = Math.round(Number(raw));
  if (raw.trim() === "" || !Number.isFinite(value)) return current;
  return Math.min(LIMIT_RANGES[key][1], Math.max(LIMIT_RANGES[key][0], value));
}

/** Limites au-dessus de leur valeur par défaut : le panneau en avertit le MJ. */
export const raisedLimits = (limits: Limits) => (Object.keys(limits) as (keyof Limits)[]).filter((key) => limits[key] > DEFAULT_LIMITS[key]);

/** Réglages de la salle après modification : ce qui n'est pas changé est conservé. */
export function settingsWith(metadata: Record<string, unknown>, change: { limits: Limits }) {
  const current = (metadata[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
  return { [SETTINGS_KEY]: { ...current, ...change } };
}
