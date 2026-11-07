// État de Tempest! : un seul objet dans les métadonnées de la scène, écrit par le MJ.
// Chaque client le lit et dessine ses effets en local : seul cet état circule sur le réseau.
// Ce fichier ne dépend pas d'Owlbear : la lecture et l'écriture sont dans scene-state.ts.

export const PLUGIN_ID = "com.tempest";
export const STATE_KEY = `${PLUGIN_ID}/state`;
export const STATE_VERSION = 1;
/**
 * Garde-fou de taille, loin de ce qu'atteint un usage normal (quelques Ko) : Owlbear a accepté
 * 512 Ko dans une scène sans refus. Le nombre d'effets par zone se règle dans limits.ts.
 */
export const MAX_STATE_BYTES = 256 * 1024;
/** Plus haute limite d'effets par zone réglable (voir limits.ts, qui ne peut pas être importé ici). */
export const HARD_EFFECTS_PER_ZONE = 12;

export const WEATHER_KINDS = ["rain", "snow", "fog", "sand", "embers"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** Zone de toute la scène ; les autres zones sont peintes par le MJ (voir zones.ts). */
export const SCENE_ZONE = "scene";

export interface WeatherEffect {
  id: string;
  kind: WeatherKind;
  /** SCENE_ZONE, ou l'identifiant d'une zone peinte */
  zone: string;
  /** L'œil de la carte d'effet : masqué sans être supprimé */
  enabled: boolean;
  /** Degrés, 0 à 359 ; 180 = vers le bas de l'écran */
  direction: number;
  /** 0 à 10 */
  wind: number;
  /** 0 à 1 */
  intensity: number;
  /** 0,25 à 4, rapporté à la taille d'une case */
  scale: number;
  /** Couleur « #rrggbb », ou null pour la couleur naturelle de l'effet */
  color: string | null;
  /** 0 à 1 */
  opacity: number;
}

export const TIME_KEYS = ["dawn", "day", "dusk", "night"] as const;
export type TimeKey = (typeof TIME_KEYS)[number];

export interface TimeOfDay {
  enabled: boolean;
  /** 0 à 24 */
  hour: number;
  /** Teinte de chaque point clé (aube 6 h, jour 12 h, crépuscule 19 h, nuit 23 h) */
  colors: Record<TimeKey, string>;
}

export const FILTER_KINDS = ["grayscale", "sepia", "vignette", "grain", "brightness", "contrast", "saturation", "hue"] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

export interface Filter {
  kind: FilterKind;
  enabled: boolean;
  /** 0 à 1 */
  amount: number;
}

/**
 * Heure du jour et filtres d'une zone. Celle de la scène existe toujours ; dans une zone peinte
 * qui a les siens, ils remplacent ceux de la scène.
 */
export interface Look {
  zone: string;
  time: TimeOfDay;
  /** Dans l'ordre d'application, après l'heure du jour */
  filters: Filter[];
}

export interface TempestState {
  v: typeof STATE_VERSION;
  /** « Tout couper » : rien n'est dessiné, les réglages sont gardés. */
  paused: boolean;
  weather: WeatherEffect[];
  /** La première est celle de la scène */
  looks: Look[];
}

export const DEFAULT_TIME_COLORS: Record<TimeKey, string> = {
  dawn: "#ffc89a",
  day: "#ffffff",
  dusk: "#ff9a52",
  night: "#3c4f8f",
};

export function defaultEffect(kind: WeatherKind, zone: string = SCENE_ZONE, id: string = crypto.randomUUID()): WeatherEffect {
  return { id, kind, zone, enabled: true, direction: 180, wind: 3, intensity: 0.5, scale: 1, color: null, opacity: 1 };
}

export function defaultLook(zone: string = SCENE_ZONE): Look {
  return {
    zone,
    time: { enabled: false, hour: 12, colors: { ...DEFAULT_TIME_COLORS } },
    filters: FILTER_KINDS.map((kind) => ({ kind, enabled: false, amount: 0.5 })),
  };
}

export function defaultState(): TempestState {
  return { v: STATE_VERSION, paused: false, weather: [], looks: [defaultLook()] };
}

/** Réglages de la zone, ou ceux de la scène si elle n'en a pas. */
export const lookOf = (state: TempestState, zone: string) =>
  state.looks.find((look) => look.zone === zone) ?? state.looks[0];

// --- Lecture prudente : la donnée vient de la scène, elle peut être ancienne ou abîmée ----------

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

const zoneId = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 64) : SCENE_ZONE);

function parseEffect(value: unknown): WeatherEffect | null {
  if (!isObject(value) || !WEATHER_KINDS.includes(value.kind as WeatherKind)) return null;
  const base = defaultEffect(value.kind as WeatherKind, zoneId(value.zone), typeof value.id === "string" ? value.id : undefined);
  return {
    ...base,
    enabled: value.enabled !== false,
    direction: Math.round(clamp(value.direction, 0, 359, base.direction)),
    wind: clamp(value.wind, 0, 10, base.wind),
    intensity: clamp(value.intensity, 0, 1, base.intensity),
    scale: clamp(value.scale, 0.25, 4, base.scale),
    color: isColor(value.color) ? value.color.toLowerCase() : null,
    opacity: clamp(value.opacity, 0, 1, base.opacity),
  };
}

function parseLook(value: unknown): Look | null {
  if (!isObject(value)) return null;
  const look = defaultLook(zoneId(value.zone));
  if (isObject(value.time)) {
    look.time.enabled = value.time.enabled === true;
    look.time.hour = clamp(value.time.hour, 0, 24, look.time.hour);
    const colors = isObject(value.time.colors) ? value.time.colors : {};
    for (const key of TIME_KEYS) if (isColor(colors[key])) look.time.colors[key] = (colors[key] as string).toLowerCase();
  }
  if (Array.isArray(value.filters)) {
    const stored = new Map(value.filters.filter(isObject).map((filter) => [filter.kind, filter]));
    look.filters = look.filters.map((filter) => {
      const saved = stored.get(filter.kind);
      return saved ? { kind: filter.kind, enabled: saved.enabled === true, amount: clamp(saved.amount, 0, 1, filter.amount) } : filter;
    });
  }
  return look;
}

/**
 * État valide à partir de ce qui est stocké ; les valeurs inconnues prennent leur valeur par défaut.
 * Au plus HARD_EFFECTS_PER_ZONE effets par zone (la limite réglable ne coupe pas à la lecture),
 * un seul réglage d'ambiance par zone, et celui de la scène toujours en premier.
 */
export function parseState(value: unknown): TempestState {
  const state = defaultState();
  if (!isObject(value) || value.v !== STATE_VERSION) return state;
  state.paused = value.paused === true;

  const perZone = new Map<string, number>();
  for (const raw of Array.isArray(value.weather) ? value.weather : []) {
    const effect = parseEffect(raw);
    if (!effect) continue;
    const count = perZone.get(effect.zone) ?? 0;
    if (count >= HARD_EFFECTS_PER_ZONE) continue;
    perZone.set(effect.zone, count + 1);
    state.weather.push(effect);
  }

  const looks = new Map<string, Look>();
  for (const raw of Array.isArray(value.looks) ? value.looks : []) {
    const look = parseLook(raw);
    if (look && !looks.has(look.zone)) looks.set(look.zone, look);
  }
  state.looks = [looks.get(SCENE_ZONE) ?? defaultLook(), ...[...looks.values()].filter((look) => look.zone !== SCENE_ZONE)];
  return state;
}

export class TooManyEffectsError extends Error {}

/** Ajoute un effet si la zone en a encore la place dans la limite de la salle. */
export function addEffect(state: TempestState, effect: WeatherEffect, limit: number) {
  if (state.weather.filter((other) => other.zone === effect.zone).length >= limit) throw new TooManyEffectsError();
  state.weather.push(effect);
}

/** Retire ce qui vise une zone supprimée. */
export function forgetZone(state: TempestState, zone: string) {
  state.weather = state.weather.filter((effect) => effect.zone !== zone);
  state.looks = state.looks.filter((look) => look.zone !== zone);
}

export const stateBytes = (state: TempestState) => new TextEncoder().encode(JSON.stringify(state)).length;
