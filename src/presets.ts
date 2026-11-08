// Ambiances : météo, heure du jour et filtres d'une zone, appliqués d'un clic. Les ambiances
// fournies sont décrites ici ; celles du MJ sont gardées dans son navigateur (voir panel.ts).
// Appliquer une ambiance remplace la météo, l'heure et les filtres de la zone. Ce fichier ne
// dépend pas d'Owlbear.

import {
  SCENE_ZONE,
  defaultEffect,
  defaultLook,
  parseEffect,
  parseLook,
  type FilterKind,
  type Look,
  type TempestState,
  type WeatherEffect,
  type WeatherKind,
} from "./state";

export interface Preset {
  id: string;
  /** Nom donné par le MJ ; les ambiances fournies ont une clé de traduction `preset.<id>`. */
  name?: string;
  /** Effets météo, sans zone (ils prennent celle où l'ambiance est appliquée) */
  weather: WeatherEffect[];
  look: Look;
}

/** Une heure ou un filtre est actif : l'ambiance touche à l'image. */
export const lookIsActive = (look: Look) => look.time.enabled || look.filters.some((filter) => filter.enabled);

// --- Ambiances fournies -----------------------------------------------------------------------

const effect = (kind: WeatherKind, settings: Partial<Omit<WeatherEffect, "options">> & { options?: WeatherEffect["options"] } = {}) => {
  const base = defaultEffect(kind, SCENE_ZONE, kind);
  return { ...base, ...settings, options: { ...base.options, ...settings.options } };
};

const look = (hour: number | null, filters: Partial<Record<FilterKind, number>> = {}): Look => {
  const result = defaultLook();
  if (hour !== null) {
    result.time.enabled = true;
    result.time.hour = hour;
  }
  result.filters = result.filters.map((filter) =>
    filter.kind in filters ? { ...filter, enabled: true, amount: filters[filter.kind]! } : filter,
  );
  return result;
};

/** Ambiances fournies, dans l'ordre de la grille. Filtres centrés : 0,5 = neutre. */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: "sunny",
    weather: [effect("sunrays", { intensity: 0.45, options: { motes: 0.4 } })],
    look: look(12, { saturation: 0.6, brightness: 0.54 }),
  },
  {
    id: "dusk",
    weather: [effect("sunrays", { direction: 120, intensity: 0.35, color: "#ffb070" })],
    look: look(19, { vignette: 0.35 }),
  },
  {
    id: "clearNight",
    weather: [effect("clouds", { intensity: 0.25, opacity: 0.6 })],
    look: look(23, { vignette: 0.4 }),
  },
  {
    id: "stormNight",
    weather: [
      effect("rain", { intensity: 0.8, direction: 165, speed: 1.3, options: { splashes: 0.5, lightning: 0.5, veil: 0.4 } }),
      effect("wind", { intensity: 0.45, direction: 165, speed: 1.4 }),
      effect("clouds", { intensity: 0.6 }),
    ],
    look: look(23, { contrast: 0.56, saturation: 0.4 }),
  },
  {
    id: "blizzard",
    weather: [
      effect("snow", { intensity: 0.9, direction: 120, speed: 1.8, options: { nearFlakes: 0.5 } }),
      effect("wind", { intensity: 0.6, direction: 115, speed: 1.6 }),
      effect("fog", { intensity: 0.35, direction: 115, color: "#ffffff" }),
    ],
    look: look(null, { brightness: 0.56, saturation: 0.35 }),
  },
  {
    id: "toxicMist",
    weather: [
      effect("fog", { intensity: 0.6, color: "#7cff6b", options: { wisps: 0.5 } }),
      effect("fireflies", { intensity: 0.3, color: "#a6ff4d", options: { glow: 0.3 } }),
    ],
    look: look(null, { saturation: 0.6, vignette: 0.4 }),
  },
  {
    id: "sandstorm",
    weather: [
      effect("sand", { intensity: 0.8, speed: 1.6, options: { whirls: 0.5 } }),
      effect("wind", { intensity: 0.5, speed: 1.5, color: "#f3dcae", options: { debris: 0.4 } }),
    ],
    look: look(null, { sepia: 0.35, contrast: 0.55 }),
  },
  {
    id: "memory",
    weather: [],
    look: look(null, { blur: 0.25, sepia: 0.7, vignette: 0.6, grain: 0.4 }),
  },
  {
    id: "autumnForest",
    weather: [
      effect("leaves", { intensity: 0.5 }),
      effect("sunrays", { intensity: 0.35, options: { motes: 0.5 } }),
    ],
    look: look(16.5, { saturation: 0.6 }),
  },
  {
    id: "enchantedGlade",
    weather: [
      effect("fireflies", { intensity: 0.6, options: { glow: 0.8 } }),
      effect("sunrays", { intensity: 0.2, color: "#bcd4ff", options: { motes: 0.6 } }),
    ],
    look: look(21, { saturation: 0.6, vignette: 0.3 }),
  },
  {
    id: "scorchingDesert",
    weather: [effect("heat", { intensity: 0.6 }), effect("sand", { intensity: 0.3, speed: 0.6 })],
    look: look(13, { saturation: 0.6, contrast: 0.55, brightness: 0.55 }),
  },
  {
    id: "forge",
    weather: [
      effect("heat", { intensity: 0.5 }),
      effect("embers", { intensity: 0.5, options: { crackle: 0.5, glow: 0.6 } }),
    ],
    look: look(null, { sepia: 0.2, saturation: 0.62, vignette: 0.5 }),
  },
];

// --- Appliquer, capturer, annuler --------------------------------------------------------------

/** Ce qu'une zone avait avant une ambiance : de quoi annuler. */
export interface ZoneSnapshot {
  zone: string;
  weather: WeatherEffect[];
  /** Absent : la zone suivait la scène. */
  look?: Look;
}

export function snapshotZone(state: TempestState, zone: string): ZoneSnapshot {
  return {
    zone,
    weather: structuredClone(state.weather.filter((candidate) => candidate.zone === zone)),
    look: structuredClone(state.looks.find((candidate) => candidate.zone === zone)),
  };
}

/** Remet une zone dans l'état d'un instantané (ou y pose une ambiance, qui en est un). */
export function restoreZone(state: TempestState, snapshot: ZoneSnapshot) {
  const { zone } = snapshot;
  state.weather = [...state.weather.filter((candidate) => candidate.zone !== zone), ...snapshot.weather];
  if (zone === SCENE_ZONE) {
    state.looks[0] = snapshot.look ? { ...snapshot.look, zone } : { ...defaultLook(), zone };
    return;
  }
  state.looks = state.looks.filter((candidate) => candidate.zone !== zone);
  if (snapshot.look) state.looks.push({ ...snapshot.look, zone });
}

/**
 * Applique une ambiance à une zone : sa météo, son heure et ses filtres sont remplacés. Au plus
 * `limit` effets. Dans une zone peinte, une ambiance sans heure ni filtre laisse la zone suivre
 * la scène (la nuit de la scène continue d'y tomber).
 * Renvoie le nombre d'effets laissés de côté par la limite.
 */
export function applyPreset(state: TempestState, zone: string, preset: Preset, limit: number) {
  const weather = preset.weather.slice(0, limit).map((candidate) => ({ ...structuredClone(candidate), id: crypto.randomUUID(), zone }));
  const keepLook = zone === SCENE_ZONE || lookIsActive(preset.look);
  restoreZone(state, { zone, weather, look: keepLook ? structuredClone(preset.look) : undefined });
  return Math.max(0, preset.weather.length - limit);
}

/** L'ambiance actuelle d'une zone, pour l'enregistrer. Sans réglages propres, elle reprend ceux de la scène. */
export function capturePreset(state: TempestState, zone: string, name: string): Preset {
  const own = state.looks.find((candidate) => candidate.zone === zone) ?? state.looks[0];
  return {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 40) || "?",
    weather: structuredClone(state.weather.filter((candidate) => candidate.zone === zone)).map((candidate) => ({ ...candidate, zone: SCENE_ZONE })),
    look: { ...structuredClone(own), zone: SCENE_ZONE },
  };
}

// --- Ambiances du MJ ---------------------------------------------------------------------------

export const MAX_CUSTOM_PRESETS = 50;

/** Ambiances enregistrées, lues prudemment : elles viennent du navigateur et peuvent être abîmées. */
export function parseCustomPresets(raw: string | null): Preset[] {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.slice(0, MAX_CUSTOM_PRESETS).flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string") return [];
    const weather = (Array.isArray(item.weather) ? item.weather : []).map(parseEffect).filter((candidate): candidate is WeatherEffect => candidate !== null);
    const parsedLook = parseLook(item.look) ?? defaultLook();
    return [{ id: item.id, name: item.name.slice(0, 40), weather: weather.map((candidate) => ({ ...candidate, zone: SCENE_ZONE })), look: { ...parsedLook, zone: SCENE_ZONE } }];
  });
}
