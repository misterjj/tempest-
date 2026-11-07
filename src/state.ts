// État de Tempest! : un seul objet dans les métadonnées de la scène, écrit par le MJ.
// Chaque client le lit et dessine ses effets en local : seul cet état circule sur le réseau.
// Ce fichier ne dépend pas d'Owlbear : la lecture et l'écriture sont dans scene-state.ts.

export const PLUGIN_ID = "com.tempest";
export const STATE_KEY = `${PLUGIN_ID}/state`;
export const STATE_VERSION = 1;
/** Limite du cahier des charges pour les métadonnées d'une scène. */
export const MAX_STATE_BYTES = 4 * 1024;
export const MAX_EFFECTS_PER_TARGET = 4;

export const WEATHER_KINDS = ["rain", "snow", "fog", "sand", "embers"] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** Où s'applique un effet : toute la scène, ou une carte ou une forme de la scène. */
export type Target = { kind: "scene" } | { kind: "item"; id: string };

export interface WeatherEffect {
  id: string;
  kind: WeatherKind;
  target: Target;
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

export interface TempestState {
  v: typeof STATE_VERSION;
  /** « Tout couper » : rien n'est dessiné, les réglages sont gardés. */
  paused: boolean;
  weather: WeatherEffect[];
  time: TimeOfDay;
  /** Dans l'ordre d'application, après l'heure du jour */
  filters: Filter[];
}

export const DEFAULT_TIME_COLORS: Record<TimeKey, string> = {
  dawn: "#ffc89a",
  day: "#ffffff",
  dusk: "#ff9a52",
  night: "#3c4f8f",
};

export function defaultEffect(kind: WeatherKind, target: Target, id: string = crypto.randomUUID()): WeatherEffect {
  return { id, kind, target, direction: 180, wind: 3, intensity: 0.5, scale: 1, color: null, opacity: 1 };
}

export function defaultState(): TempestState {
  return {
    v: STATE_VERSION,
    paused: false,
    weather: [],
    time: { enabled: false, hour: 12, colors: { ...DEFAULT_TIME_COLORS } },
    filters: FILTER_KINDS.map((kind) => ({ kind, enabled: false, amount: 0.5 })),
  };
}

// --- Lecture prudente : la donnée vient de la scène, elle peut être ancienne ou abîmée ----------

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;
const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

function parseTarget(value: unknown): Target {
  if (isObject(value) && value.kind === "item" && typeof value.id === "string" && value.id) {
    return { kind: "item", id: value.id };
  }
  return { kind: "scene" };
}

function parseEffect(value: unknown): WeatherEffect | null {
  if (!isObject(value) || !WEATHER_KINDS.includes(value.kind as WeatherKind)) return null;
  const base = defaultEffect(value.kind as WeatherKind, parseTarget(value.target), typeof value.id === "string" ? value.id : undefined);
  return {
    ...base,
    direction: Math.round(clamp(value.direction, 0, 359, base.direction)),
    wind: clamp(value.wind, 0, 10, base.wind),
    intensity: clamp(value.intensity, 0, 1, base.intensity),
    scale: clamp(value.scale, 0.25, 4, base.scale),
    color: isColor(value.color) ? value.color.toLowerCase() : null,
    opacity: clamp(value.opacity, 0, 1, base.opacity),
  };
}

const targetKey = (target: Target) => (target.kind === "scene" ? "scene" : target.id);

/** État valide à partir de ce qui est stocké ; les valeurs inconnues prennent leur valeur par défaut. */
export function parseState(value: unknown): TempestState {
  const state = defaultState();
  if (!isObject(value) || value.v !== STATE_VERSION) return state;
  state.paused = value.paused === true;

  const perTarget = new Map<string, number>();
  for (const raw of Array.isArray(value.weather) ? value.weather : []) {
    const effect = parseEffect(raw);
    if (!effect) continue;
    const count = perTarget.get(targetKey(effect.target)) ?? 0;
    if (count >= MAX_EFFECTS_PER_TARGET) continue;
    perTarget.set(targetKey(effect.target), count + 1);
    state.weather.push(effect);
  }

  if (isObject(value.time)) {
    state.time.enabled = value.time.enabled === true;
    state.time.hour = clamp(value.time.hour, 0, 24, state.time.hour);
    const colors = isObject(value.time.colors) ? value.time.colors : {};
    for (const key of TIME_KEYS) if (isColor(colors[key])) state.time.colors[key] = (colors[key] as string).toLowerCase();
  }

  if (Array.isArray(value.filters)) {
    const stored = new Map(value.filters.filter(isObject).map((filter) => [filter.kind, filter]));
    state.filters = state.filters.map((filter) => {
      const saved = stored.get(filter.kind);
      return saved ? { kind: filter.kind, enabled: saved.enabled === true, amount: clamp(saved.amount, 0, 1, filter.amount) } : filter;
    });
  }
  return state;
}

export const stateBytes = (state: TempestState) => new TextEncoder().encode(JSON.stringify(state)).length;
