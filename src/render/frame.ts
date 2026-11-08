// Ce qui est dessiné à un instant : la météo et les ambiances de l'état, réglages résolus (teinte
// naturelle, lumière de l'heure). Une transition douce mélange deux de ces images, chez chaque
// joueur et sans rien envoyer sur le réseau. Ce fichier ne dépend pas d'Owlbear.

import {
  NEUTRAL_FILTERS,
  SCENE_ZONE,
  type FilterKind,
  type TempestState,
  type WeatherKind,
} from "../state";
import { lookIsActive } from "../presets";
import { lightAt, type Light } from "./daylight";
import { NATURAL_TINTS } from "./shaders";

type Vec3 = { x: number; y: number; z: number };

/** « #rrggbb » en composantes de 0 à 1. */
export function rgb(color: string): Vec3 {
  const value = Number.parseInt(color.slice(1), 16);
  return { x: ((value >> 16) & 255) / 255, y: ((value >> 8) & 255) / 255, z: (value & 255) / 255 };
}

export interface WeatherFrame {
  id: string;
  kind: WeatherKind;
  zone: string;
  // Réglages qui font bouger les particules dans le temps : les mélanger les ferait filer à toute
  // vitesse pendant la transition, ils passent donc d'un coup à leur nouvelle valeur.
  direction: number;
  speed: number;
  scale: number;
  turbulence: number;
  // Réglages mélangés.
  intensity: number;
  opacity: number;
  tint: Vec3;
  gusts: number;
  variety: number;
  patches: number;
  options: Record<string, number>;
}

export interface LookFrame {
  zone: string;
  /** Présence de l'ambiance, 0 à 1 : elle apparaît et disparaît en fondu. */
  weight: number;
  /** Lumière de l'heure du jour, ou null sans heure */
  light: Light | null;
  /** Filtres actifs et leur valeur, dans l'ordre de FILTER_KINDS */
  filters: Partial<Record<FilterKind, number>>;
}

export interface Frame {
  weather: WeatherFrame[];
  looks: LookFrame[];
}

export const EMPTY_FRAME: Frame = { weather: [], looks: [] };

/** Lumière qui ne change rien : une ambiance sans heure, vue comme une heure. */
export const NEUTRAL_LIGHT: Light = { tint: { x: 1, y: 1, z: 1 }, bright: 1, sat: 1, contr: 1 };

/** Ce que l'état fait dessiner, dans les zones qui existent encore. */
export function frameOf(state: TempestState, zoneIds: Set<string>): Frame {
  if (state.paused) return EMPTY_FRAME;
  const exists = (zone: string) => zone === SCENE_ZONE || zoneIds.has(zone);
  return {
    weather: state.weather
      .filter((effect) => effect.enabled && effect.intensity > 0 && effect.opacity > 0 && exists(effect.zone))
      .map((effect) => ({
        id: effect.id,
        kind: effect.kind,
        zone: effect.zone,
        direction: effect.direction,
        speed: effect.speed,
        scale: effect.scale,
        turbulence: effect.turbulence,
        intensity: effect.intensity,
        opacity: effect.opacity,
        tint: effect.color ? rgb(effect.color) : NATURAL_TINTS[effect.kind],
        gusts: effect.gusts,
        variety: effect.variety,
        patches: effect.patches,
        options: { ...effect.options } as Record<string, number>,
      })),
    looks: state.looks
      .filter((look) => lookIsActive(look) && exists(look.zone))
      .map((look) => ({
        zone: look.zone,
        weight: 1,
        light: look.time.enabled ? lightAt(look.time.hour, look.time.colors) : null,
        filters: Object.fromEntries(look.filters.filter((filter) => filter.enabled).map((filter) => [filter.kind, filter.amount])),
      })),
  };
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Vec3, b: Vec3, t: number) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), z: mix(a.z, b.z, t) });

function mixWeather(a: WeatherFrame, b: WeatherFrame, t: number): WeatherFrame {
  const options: Record<string, number> = {};
  for (const key of new Set([...Object.keys(a.options), ...Object.keys(b.options)])) options[key] = mix(a.options[key] ?? 0, b.options[key] ?? 0, t);
  return {
    ...b,
    intensity: mix(a.intensity, b.intensity, t),
    opacity: mix(a.opacity, b.opacity, t),
    tint: mix3(a.tint, b.tint, t),
    gusts: mix(a.gusts, b.gusts, t),
    variety: mix(a.variety, b.variety, t),
    patches: mix(a.patches, b.patches, t),
    options,
  };
}

function mixLook(a: LookFrame, b: LookFrame, t: number): LookFrame {
  const filters: Partial<Record<FilterKind, number>> = {};
  for (const kind of new Set([...Object.keys(a.filters), ...Object.keys(b.filters)]) as Set<FilterKind>) {
    filters[kind] = mix(a.filters[kind] ?? NEUTRAL_FILTERS[kind], b.filters[kind] ?? NEUTRAL_FILTERS[kind], t);
  }
  const light =
    a.light || b.light
      ? (() => {
          const from = a.light ?? NEUTRAL_LIGHT;
          const to = b.light ?? NEUTRAL_LIGHT;
          return { tint: mix3(from.tint, to.tint, t), bright: mix(from.bright, to.bright, t), sat: mix(from.sat, to.sat, t), contr: mix(from.contr, to.contr, t) };
        })()
      : null;
  return { zone: b.zone, weight: mix(a.weight, b.weight, t), light, filters };
}

/**
 * Image entre `from` (t = 0) et `to` (t = 1). Un effet qui apparaît part de l'opacité 0, une
 * ambiance qui apparaît du poids 0 ; ceux qui disparaissent y retournent. À t = 1, c'est `to`.
 */
export function blendFrames(from: Frame, to: Frame, t: number): Frame {
  if (t >= 1) return to;
  const weatherFrom = new Map(from.weather.map((effect) => [effect.id, effect]));
  const weatherTo = new Map(to.weather.map((effect) => [effect.id, effect]));
  const weather = [
    ...from.weather.map((a) => mixWeather(a, weatherTo.get(a.id) ?? { ...a, opacity: 0 }, t)),
    ...to.weather.filter((b) => !weatherFrom.has(b.id)).map((b) => mixWeather({ ...b, opacity: 0 }, b, t)),
  ];
  const looksFrom = new Map(from.looks.map((look) => [look.zone, look]));
  const looksTo = new Map(to.looks.map((look) => [look.zone, look]));
  const looks = [
    ...from.looks.map((a) => mixLook(a, looksTo.get(a.zone) ?? { ...a, weight: 0 }, t)),
    ...to.looks.filter((b) => !looksFrom.has(b.zone)).map((b) => mixLook({ ...b, weight: 0 }, b, t)),
  ];
  // La scène d'abord : les zones s'y découpent.
  looks.sort((a, b) => Number(b.zone === SCENE_ZONE) - Number(a.zone === SCENE_ZONE));
  return { weather: weather.filter((effect) => effect.opacity > 0.001), looks: looks.filter((look) => look.weight > 0.001) };
}

/** Départ et arrivée en douceur. */
export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
