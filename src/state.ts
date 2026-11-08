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

export const WEATHER_KINDS = ["rain", "snow", "hail", "fog", "sand", "wind", "embers", "leaves", "fireflies", "clouds", "sunrays", "heat"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** Options propres à certaines météos (0 à 1), en plus des réglages communs. */
export const OPTION_KEYS = ["splashes", "lightning", "veil", "nearFlakes", "wisps", "whirls", "crackle", "glow", "motes", "debris"] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

/** Options de chaque météo, dans l'ordre du panneau, avec leur valeur de départ. */
export const KIND_OPTIONS: Record<WeatherKind, Partial<Record<OptionKey, number>>> = {
  rain: { splashes: 0, lightning: 0, veil: 0 },
  snow: { nearFlakes: 0 },
  hail: { lightning: 0 },
  fog: { wisps: 0 },
  sand: { whirls: 0 },
  embers: { crackle: 0, glow: 0 },
  leaves: {},
  fireflies: { glow: 0.5 },
  clouds: {},
  sunrays: { motes: 0.4 },
  wind: { debris: 0 },
  heat: {},
};

/** Options de cette météo, dans l'ordre du panneau. */
export const optionsOf = (kind: WeatherKind) => Object.keys(KIND_OPTIONS[kind]) as OptionKey[];

/** Réglages communs sans objet pour certaines météos : la brume de chaleur déforme sans colorer. */
export const HIDDEN_FIELDS: Partial<Record<WeatherKind, "color"[]>> = { heat: ["color"] };

/** Zone de toute la scène ; les autres zones sont peintes par le MJ (voir zones.ts). */
export const SCENE_ZONE = "scene";

export interface WeatherEffect {
  id: string;
  kind: WeatherKind;
  /** SCENE_ZONE, ou l'identifiant d'une zone peinte */
  zone: string;
  /** L'œil de la carte d'effet : masqué sans être supprimé */
  enabled: boolean;
  /** Sens du déplacement, en degrés : 0 = vers le haut de l'écran, 180 = vers le bas */
  direction: number;
  /** Multiplicateur de la vitesse naturelle de l'effet, 0,25 à 3 */
  speed: number;
  /** 0 à 1 */
  intensity: number;
  /** 0,25 à 4, rapporté à la taille d'une case */
  scale: number;
  /** Couleur « #rrggbb », ou null pour la couleur naturelle de l'effet */
  color: string | null;
  /** 0 à 1 */
  opacity: number;
  /** Écarts aléatoires de trajectoire, 0 à 1 */
  turbulence: number;
  /** Vagues de vitesse et de densité, 0 à 1 */
  gusts: number;
  /** Tailles différentes d'une particule à l'autre, 0 à 1 */
  variety: number;
  /** Nappes plus denses qui avancent avec l'effet, 0 à 1 */
  patches: number;
  /** Options propres à la météo (voir KIND_OPTIONS) : seules celles de son type sont gardées. */
  options: Partial<Record<OptionKey, number>>;
}

export const TIME_KEYS = ["dawn", "day", "dusk", "night"] as const;
export type TimeKey = (typeof TIME_KEYS)[number];

export interface TimeOfDay {
  enabled: boolean;
  /**
   * L'heure avance seule : minutes réelles par heure de jeu (0 = arrêtée). L'heure affichée vaut
   * `hour` plus le temps écoulé depuis `since` (horloge en millisecondes).
   */
  pace: number;
  since: number;
  /** 0 à 24 */
  hour: number;
  /** Teinte de chaque point clé (aube 6 h, jour 12 h, crépuscule 19 h, nuit 23 h) */
  colors: Record<TimeKey, string>;
}

export const FILTER_KINDS = ["blur", "grayscale", "sepia", "vignette", "grain", "brightness", "contrast", "saturation", "hue"] as const;
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

/**
 * Lumière : accrochée à un objet de la carte (pion, décor), elle le suit quand il bouge ; sans
 * objet, elle est fixée en (x, y). Elle perce la nuit de l'heure du jour autour d'elle.
 */
export interface Lamp {
  id: string;
  /** Objet porteur, ou "" pour une lumière fixe */
  item: string;
  /** Position d'une lumière fixe, en coordonnées de la carte */
  x: number;
  y: number;
  /** Rayon, en cases */
  radius: number;
  /** Couleur « #rrggbb » */
  color: string;
  /** 0 à 1 */
  intensity: number;
  /** Vacillement d'une flamme, 0 à 1 */
  flicker: number;
}

export const LAMP_PRESETS = {
  torch: { radius: 8, color: "#ffb15c", intensity: 0.9, flicker: 0.5 },
  lantern: { radius: 12, color: "#ffd59a", intensity: 0.85, flicker: 0.15 },
  campfire: { radius: 6, color: "#ff9a3c", intensity: 1, flicker: 0.7 },
  candle: { radius: 2, color: "#ffc27a", intensity: 0.8, flicker: 0.6 },
  magic: { radius: 8, color: "#8fb8ff", intensity: 0.8, flicker: 0.1 },
} as const;
export type LampPreset = keyof typeof LAMP_PRESETS;
/** Plus haute limite de lumières réglable (voir limits.ts, qui ne peut pas être importé ici). */
export const HARD_LAMPS = 64;
/** Clé posée sur l'objet porteur : le menu contextuel sait s'il a déjà une lumière. */
export const LAMP_KEY = "com.tempest/lumiere";

export function newLamp(item: string, preset: LampPreset = "torch", id: string = crypto.randomUUID(), at = { x: 0, y: 0 }): Lamp {
  return { id, item, x: Math.round(at.x), y: Math.round(at.y), ...LAMP_PRESETS[preset] };
}

export interface TempestState {
  v: typeof STATE_VERSION;
  /** « Tout couper » : rien n'est dessiné, les réglages sont gardés. */
  paused: boolean;
  weather: WeatherEffect[];
  /** La première est celle de la scène */
  looks: Look[];
  lamps: Lamp[];
  /** Durée des transitions douces, en secondes (0 = changement immédiat) */
  transition: number;
  /**
   * Change à chaque changement à faire en douceur (ambiance, effet ajouté ou masqué…). Les curseurs
   * ne le changent pas : ils agissent tout de suite, ou suivent une transition déjà en cours.
   */
  smooth: string;
}

export const DEFAULT_TIME_COLORS: Record<TimeKey, string> = {
  dawn: "#ffc89a",
  day: "#ffffff",
  dusk: "#ff9a52",
  night: "#3c4f8f",
};

/** Sens de départ de chaque météo : la pluie et la neige tombent, la brume et le sable filent, les braises montent. */
const DEFAULT_DIRECTION: Record<WeatherKind, number> = {
  rain: 180,
  snow: 180,
  hail: 180,
  fog: 90,
  sand: 90,
  embers: 0,
  leaves: 160,
  fireflies: 0,
  clouds: 90,
  sunrays: 150,
  wind: 90,
  heat: 0,
};

/**
 * Variations naturelles de départ de chaque météo : la neige et les feuilles flottent et varient
 * beaucoup, la pluie et la grêle tombent droit, les rayons et les nuages restent calmes.
 */
const DEFAULT_VARIATIONS: Record<WeatherKind, Pick<WeatherEffect, "turbulence" | "gusts" | "variety" | "patches">> = {
  rain: { turbulence: 0.15, gusts: 0.25, variety: 0.3, patches: 0.2 },
  snow: { turbulence: 0.45, gusts: 0.2, variety: 0.6, patches: 0.25 },
  hail: { turbulence: 0.1, gusts: 0.2, variety: 0.5, patches: 0.15 },
  fog: { turbulence: 0.3, gusts: 0.1, variety: 0.5, patches: 0.35 },
  sand: { turbulence: 0.35, gusts: 0.5, variety: 0.5, patches: 0.3 },
  wind: { turbulence: 0.3, gusts: 0.5, variety: 0.4, patches: 0.3 },
  embers: { turbulence: 0.5, gusts: 0.15, variety: 0.6, patches: 0.3 },
  leaves: { turbulence: 0.5, gusts: 0.35, variety: 0.7, patches: 0.2 },
  fireflies: { turbulence: 0.5, gusts: 0, variety: 0.5, patches: 0.4 },
  clouds: { turbulence: 0.2, gusts: 0, variety: 0.5, patches: 0 },
  sunrays: { turbulence: 0, gusts: 0.3, variety: 0.3, patches: 0 },
  heat: { turbulence: 0.2, gusts: 0.2, variety: 0, patches: 0.3 },
};

export function defaultEffect(kind: WeatherKind, zone: string = SCENE_ZONE, id: string = crypto.randomUUID()): WeatherEffect {
  return {
    id,
    kind,
    zone,
    enabled: true,
    direction: DEFAULT_DIRECTION[kind],
    speed: 1,
    intensity: 0.5,
    scale: 1,
    color: null,
    opacity: 1,
    // Un peu d'irrégularité par défaut, selon la météo : un effet trop régulier paraît artificiel.
    ...DEFAULT_VARIATIONS[kind],
    options: { ...KIND_OPTIONS[kind] },
  };
}

export function defaultLook(zone: string = SCENE_ZONE): Look {
  return {
    zone,
    time: { enabled: false, hour: 12, pace: 0, since: 0, colors: { ...DEFAULT_TIME_COLORS } },
    filters: FILTER_KINDS.map((kind) => ({ kind, enabled: false, amount: 0.5 })),
  };
}

export const DEFAULT_TRANSITION = 3;
/** Durées proposées dans le panneau, en secondes. */
export const TRANSITIONS = [0, 1, 3, 6, 10] as const;
export const MAX_TRANSITION = 30;

export function defaultState(): TempestState {
  return { v: STATE_VERSION, paused: false, weather: [], looks: [defaultLook()], lamps: [], transition: DEFAULT_TRANSITION, smooth: "" };
}

/** Allures proposées : minutes réelles par heure de jeu. */
export const TIME_PACES = [0, 1, 5, 10, 60] as const;

/** Heure du moment, l'avancée automatique comprise. */
export function hourNow(time: TimeOfDay, now: number) {
  if (!time.pace || !time.since) return time.hour;
  const elapsed = Math.max(0, now - time.since) / 60000 / time.pace;
  return (((time.hour + elapsed) % 24) + 24) % 24;
}

/** Fige l'heure du moment dans `hour` (avant de la changer, ou d'en changer l'allure). */
export function settleHour(time: TimeOfDay, now: number) {
  time.hour = Math.round(hourNow(time, now) * 100) / 100;
  time.since = time.pace ? now : 0;
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

export function parseEffect(value: unknown): WeatherEffect | null {
  if (!isObject(value) || !WEATHER_KINDS.includes(value.kind as WeatherKind)) return null;
  const base = defaultEffect(value.kind as WeatherKind, zoneId(value.zone), typeof value.id === "string" ? value.id : undefined);
  return {
    ...base,
    enabled: value.enabled !== false,
    direction: Math.round(clamp(value.direction, 0, 359, base.direction)),
    speed: clamp(value.speed, 0.25, 3, base.speed),
    intensity: clamp(value.intensity, 0, 1, base.intensity),
    scale: clamp(value.scale, 0.25, 4, base.scale),
    color: isColor(value.color) ? value.color.toLowerCase() : null,
    opacity: clamp(value.opacity, 0, 1, base.opacity),
    turbulence: clamp(value.turbulence, 0, 1, base.turbulence),
    gusts: clamp(value.gusts, 0, 1, base.gusts),
    variety: clamp(value.variety, 0, 1, base.variety),
    patches: clamp(value.patches, 0, 1, base.patches),
    options: Object.fromEntries(
      optionsOf(base.kind).map((key) => [key, clamp(isObject(value.options) ? value.options[key] : undefined, 0, 1, base.options[key]!)]),
    ),
  };
}

export function parseLook(value: unknown): Look | null {
  if (!isObject(value)) return null;
  const look = defaultLook(zoneId(value.zone));
  if (isObject(value.time)) {
    look.time.enabled = value.time.enabled === true;
    look.time.hour = clamp(value.time.hour, 0, 24, look.time.hour);
    look.time.pace = clamp(value.time.pace, 0, 600, 0);
    look.time.since = clamp(value.time.since, 0, 1e15, 0);
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
  state.transition = clamp(value.transition, 0, MAX_TRANSITION, DEFAULT_TRANSITION);
  state.smooth = typeof value.smooth === "string" ? value.smooth.slice(0, 64) : "";

  const perZone = new Map<string, number>();
  for (const raw of Array.isArray(value.weather) ? value.weather : []) {
    const effect = parseEffect(raw);
    if (!effect) continue;
    const count = perZone.get(effect.zone) ?? 0;
    if (count >= HARD_EFFECTS_PER_ZONE) continue;
    perZone.set(effect.zone, count + 1);
    state.weather.push(effect);
  }

  for (const raw of Array.isArray(value.lamps) ? value.lamps : []) {
    if (state.lamps.length >= HARD_LAMPS) break;
    if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.item !== "string") continue;
    state.lamps.push({
      id: raw.id.slice(0, 64),
      item: raw.item.slice(0, 64),
      x: clamp(raw.x, -1e7, 1e7, 0),
      y: clamp(raw.y, -1e7, 1e7, 0),
      radius: clamp(raw.radius, 0.5, 40, 8),
      color: isColor(raw.color) ? raw.color.toLowerCase() : "#ffb15c",
      intensity: clamp(raw.intensity, 0, 1, 0.9),
      flicker: clamp(raw.flicker, 0, 1, 0.5),
    });
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

/** Neutres de chaque filtre : à cette valeur, il ne change pas l'image. */
export const NEUTRAL_FILTERS: Record<FilterKind, number> = {
  blur: 0,
  grayscale: 0,
  sepia: 0,
  vignette: 0,
  grain: 0,
  brightness: 0.5,
  contrast: 0.5,
  saturation: 0.5,
  hue: 0.5,
};

/** Retire ce qui vise une zone supprimée. */
export function forgetZone(state: TempestState, zone: string) {
  state.weather = state.weather.filter((effect) => effect.zone !== zone);
  state.looks = state.looks.filter((look) => look.zone !== zone);
}

export const stateBytes = (state: TempestState) => new TextEncoder().encode(JSON.stringify(state)).length;
