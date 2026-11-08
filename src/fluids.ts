// Fluides : coulées de lave et cours d'eau tracés par le MJ. Une coulée est faite de traits de
// pinceau, tracés dans le sens du courant (le premier point est l'amont), et de rochers que le
// courant contourne. Stockés à part (clé FLUIDS_KEY) : ils ne changent que quand le MJ trace.
// Ce fichier ne dépend pas d'Owlbear.

import { simplifyStroke } from "./render/mask";
import { PLUGIN_ID } from "./state";

export const FLUIDS_KEY = `${PLUGIN_ID}/fluides`;
export const FLUIDS_VERSION = 1;
export const MAX_FLUIDS_BYTES = 256 * 1024;

export const FLUID_KINDS = ["water", "pool", "waterfall", "shore", "lava", "smoke"] as const;
export type FluidKind = (typeof FLUID_KINDS)[number];

/**
 * Limites par coulée. Le coût du rendu grandit avec les segments et les rochers, à chaque image et
 * chez chaque joueur : au-delà, une machine modeste ne suivrait plus.
 */
export const MAX_FLUIDS = 12;
export const MAX_SEGMENTS = 80;
export const MAX_ROCKS = 24;
export const MAX_SOURCES = 16;

/** Largeur d'un trait, en cases (diamètre). */
export const STROKE_WIDTHS = { min: 0.5, max: 12, default: 3 };

/** Réglages propres à chaque type, de 0 à 1, avec leur valeur de départ. */
export const FLUID_OPTIONS: Record<FluidKind, Record<string, number>> = {
  lava: { crust: 0.5, glow: 0.6 },
  water: { foam: 0.5, clarity: 0.4 },
  pool: { foam: 0.5, clarity: 0.5 },
  waterfall: { boil: 0.6, foam: 0.6, mist: 0.6 },
  shore: { waves: 0.5, foam: 0.6 },
  smoke: { density: 0.6, billow: 0.5 },
};

/**
 * Comment se trace chaque fluide. Coulée : traits dans le sens du courant. Étendue : une zone
 * peinte, sans courant (bassin, nappe de fumée). Ligne : un trait en travers du courant, qui va de
 * la gauche du tracé vers sa droite (rivage : la mer à gauche ; cascade : le trait suit la lèvre,
 * l'amont à gauche).
 */
export const FLUID_SHAPES: Record<FluidKind, "flow" | "area" | "line"> = {
  lava: "flow",
  water: "flow",
  pool: "area",
  smoke: "area",
  waterfall: "line",
  shore: "line",
};

/** Trait de courant : rayon et points à plat [x0, y0, x1, y1, …], de l'amont vers l'aval. */
export interface FluidStroke {
  r: number;
  p: number[];
}

export interface Rock {
  x: number;
  y: number;
  r: number;
}

export interface Fluid {
  id: string;
  name: string;
  kind: FluidKind;
  enabled: boolean;
  /** Multiplicateur de la vitesse naturelle, 0,25 à 3 */
  speed: number;
  /** 0 à 1 */
  opacity: number;
  /** Couleur « #rrggbb », ou null pour la couleur naturelle */
  color: string | null;
  options: Record<string, number>;
  strokes: FluidStroke[];
  rocks: Rock[];
  /** Sources : jets, chutes d'eau et bouillons ponctuels, qui font rider et mousser l'eau autour */
  sources: Rock[];
}

export interface FluidsData {
  v: typeof FLUIDS_VERSION;
  fluids: Fluid[];
}

export const emptyFluids = (): FluidsData => ({ v: FLUIDS_VERSION, fluids: [] });

export function newFluid(kind: FluidKind, name: string, id: string = crypto.randomUUID()): Fluid {
  return { id, name, kind, enabled: true, speed: 1, opacity: 1, color: null, options: { ...FLUID_OPTIONS[kind] }, strokes: [], rocks: [], sources: [] };
}

/** Segments de rendu d'une coulée : un trait de n points en compte n - 1 (au moins 1). */
export const fluidCost = (fluid: Fluid) => fluid.strokes.reduce((total, stroke) => total + Math.max(1, stroke.p.length / 2 - 1), 0);

export class FluidFullError extends Error {}
export class TooManyFluidsError extends Error {}

type Point = { x: number; y: number };

/** Trait prêt à stocker : simplifié selon sa largeur et arrondi au pixel. */
export function fluidStroke(points: Point[], radius: number): FluidStroke | null {
  if (!points.length) return null;
  const simple = simplifyStroke(points, Math.max(2, radius * 0.2));
  return { r: Math.max(2, Math.round(radius)), p: simple.flatMap((point) => [Math.round(point.x) || 0, Math.round(point.y) || 0]) };
}

export function addStroke(fluid: Fluid, stroke: FluidStroke) {
  if (fluidCost(fluid) + Math.max(1, stroke.p.length / 2 - 1) > MAX_SEGMENTS) throw new FluidFullError();
  fluid.strokes.push(stroke);
}

export function addRock(fluid: Fluid, rock: Rock) {
  if (fluid.rocks.length >= MAX_ROCKS) throw new FluidFullError();
  fluid.rocks.push(rock);
}

export function addSource(fluid: Fluid, source: Rock) {
  if (fluid.sources.length >= MAX_SOURCES) throw new FluidFullError();
  fluid.sources.push(source);
}

export function addFluid(data: FluidsData, fluid: Fluid) {
  if (data.fluids.length >= MAX_FLUIDS) throw new TooManyFluidsError();
  data.fluids.push(fluid);
}

/** Le trait coule dans l'autre sens. */
export function reverseStroke(stroke: FluidStroke) {
  const points: number[] = [];
  for (let i = stroke.p.length - 2; i >= 0; i -= 2) points.push(stroke.p[i], stroke.p[i + 1]);
  stroke.p = points;
}

// --- Repérage sous le pointeur ---------------------------------------------------------------

export interface StrokeHit {
  fluid: Fluid;
  stroke: FluidStroke;
  /** Distance à l'axe du trait */
  distance: number;
  /** Sens du courant au point le plus proche (vecteur unitaire) */
  tangent: Point;
}

/** Point le plus proche sur l'axe d'un trait, et sens du courant à cet endroit. */
export function nearestOnStroke(stroke: FluidStroke, point: Point) {
  const p = stroke.p;
  if (p.length < 4) return { distance: Math.hypot(point.x - p[0], point.y - p[1]), tangent: { x: 1, y: 0 }, along: 0 };
  let best = { distance: Infinity, tangent: { x: 1, y: 0 }, along: 0 };
  let walked = 0;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], ay = p[i - 1], bx = p[i], by = p[i + 1];
    const length = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / length, uy = (by - ay) / length;
    const h = Math.max(0, Math.min(length, (point.x - ax) * ux + (point.y - ay) * uy));
    const distance = Math.hypot(point.x - ax - ux * h, point.y - ay - uy * h);
    if (distance < best.distance) best = { distance, tangent: { x: ux, y: uy }, along: walked + h };
    walked += length;
  }
  return best;
}

/** Trait touché au point donné (dans sa largeur, plus une marge), le plus proche d'abord. */
export function strokeAt(data: FluidsData, point: Point, margin = 0): StrokeHit | null {
  let best: StrokeHit | null = null;
  for (const fluid of data.fluids) {
    for (const stroke of fluid.strokes) {
      const near = nearestOnStroke(stroke, point);
      if (near.distance > stroke.r + margin) continue;
      if (!best || near.distance - stroke.r < best.distance - best.stroke.r) best = { fluid, stroke, distance: near.distance, tangent: near.tangent };
    }
  }
  return best;
}

export function rockAt(data: FluidsData, point: Point): { fluid: Fluid; rock: Rock } | null {
  for (const fluid of data.fluids) {
    for (const rock of fluid.rocks) if (Math.hypot(point.x - rock.x, point.y - rock.y) <= rock.r) return { fluid, rock };
  }
  return null;
}

/** Source sous le pointeur (dans son petit cercle central, ou à `margin` près). */
export function sourceAt(data: FluidsData, point: Point, margin = 0): { fluid: Fluid; source: Rock } | null {
  for (const fluid of data.fluids) {
    for (const source of fluid.sources) if (Math.hypot(point.x - source.x, point.y - source.y) <= source.r * 0.35 + margin) return { fluid, source };
  }
  return null;
}

/** Coulée la plus proche d'un point, s'il est dans l'un de ses traits (ou à `margin` près). */
export const fluidAt = (data: FluidsData, point: Point, margin = 0) => strokeAt(data, point, margin)?.fluid ?? null;

/**
 * Oriente un trait d'après un glissement du MJ : s'il a glissé à contre-courant, le trait est
 * retourné. Renvoie vrai si le sens a changé.
 */
export function orientStroke(stroke: FluidStroke, from: Point, to: Point) {
  const near = nearestOnStroke(stroke, from);
  const dot = (to.x - from.x) * near.tangent.x + (to.y - from.y) * near.tangent.y;
  if (dot >= 0) return false;
  reverseStroke(stroke);
  return true;
}

// --- Lecture prudente -------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const clamp = (value: unknown, min: number, max: number, fallback: number) => (isNumber(value) ? Math.min(max, Math.max(min, value)) : fallback);

export function parseFluids(value: unknown): FluidsData {
  const data = emptyFluids();
  if (!isObject(value) || value.v !== FLUIDS_VERSION || !Array.isArray(value.fluids)) return data;
  const ids = new Set<string>();
  for (const raw of value.fluids) {
    if (data.fluids.length >= MAX_FLUIDS) break;
    if (!isObject(raw) || typeof raw.id !== "string" || !raw.id || ids.has(raw.id) || !FLUID_KINDS.includes(raw.kind as FluidKind)) continue;
    ids.add(raw.id);
    const base = newFluid(raw.kind as FluidKind, typeof raw.name === "string" ? raw.name.slice(0, 40) : "", raw.id.slice(0, 64));
    const options = isObject(raw.options) ? raw.options : {};
    const fluid: Fluid = {
      ...base,
      enabled: raw.enabled !== false,
      speed: clamp(raw.speed, 0.25, 3, 1),
      opacity: clamp(raw.opacity, 0, 1, 1),
      color: isColor(raw.color) ? raw.color.toLowerCase() : null,
      options: Object.fromEntries(Object.entries(base.options).map(([key, fallback]) => [key, clamp(options[key], 0, 1, fallback)])),
    };
    for (const stroke of Array.isArray(raw.strokes) ? raw.strokes : []) {
      if (!isObject(stroke) || !isNumber(stroke.r) || stroke.r <= 0 || !Array.isArray(stroke.p) || stroke.p.length < 2 || stroke.p.length % 2 || !stroke.p.every(isNumber)) continue;
      const parsed = { r: stroke.r, p: stroke.p as number[] };
      if (fluidCost(fluid) + Math.max(1, parsed.p.length / 2 - 1) > MAX_SEGMENTS) continue;
      fluid.strokes.push(parsed);
    }
    for (const source of Array.isArray(raw.sources) ? raw.sources : []) {
      if (fluid.sources.length >= MAX_SOURCES) break;
      if (isObject(source) && isNumber(source.x) && isNumber(source.y) && isNumber(source.r) && source.r > 0) fluid.sources.push({ x: source.x, y: source.y, r: source.r });
    }
    for (const rock of Array.isArray(raw.rocks) ? raw.rocks : []) {
      if (fluid.rocks.length >= MAX_ROCKS) break;
      if (isObject(rock) && isNumber(rock.x) && isNumber(rock.y) && isNumber(rock.r) && rock.r > 0) fluid.rocks.push({ x: rock.x, y: rock.y, r: rock.r });
    }
    data.fluids.push(fluid);
  }
  return data;
}

export const fluidsBytes = (data: FluidsData) => new TextEncoder().encode(JSON.stringify(data)).length;
