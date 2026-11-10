// Fluides : coulées de lave et cours d'eau tracés par le MJ. Une coulée est faite de traits de
// pinceau, tracés dans le sens du courant (le premier point est l'amont), et d'obstacles (rochers,
// piliers, tracés en polygone) que le courant contourne. Stockés à part (clé FLUIDS_KEY) : ils ne changent que quand le MJ trace.
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
/** Caches : polygones où la coulée n'est pas dessinée (sous un pont, derrière un mur). */
export const MAX_MASKS = 24;
/** Cache au pinceau : segments au plus par coulée (chacun se calcule à chaque image). */
export const MAX_HIDE_SEGMENTS = 160;
/** Taille du pinceau de cache, en cases (diamètre). */
export const HIDE_BRUSH = { min: 0.1, max: 4, default: 0.5 };

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

/** Coup de pinceau du cache : rayon, points à plat, et `e: 1` pour la gomme. */
export interface HideStroke {
  r: number;
  p: number[];
  e?: 1;
}

/** Trait de courant : rayon et points à plat [x0, y0, x1, y1, …], de l'amont vers l'aval. */
export interface FluidStroke {
  r: number;
  p: number[];
}

export interface Rock {
  x: number;
  y: number;
  r: number;
  /**
   * Contour d'un obstacle tracé en polygone, points à plat [x0, y0, x1, y1, …]. Sans contour,
   * l'obstacle est un rond (rochers des premières versions). Avec, (x, y) est son centre et r le
   * rayon du cercle qui le contient.
   */
  p?: number[];
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
  /**
   * Caches : polygones où la coulée passe dessous, sans être dessinée. Contrairement aux
   * obstacles, ils ne changent ni le courant ni les rives : la coulée est seulement découpée.
   */
  masks: Rock[];
  /**
   * Cache au pinceau : coups de pinceau, dans l'ordre où ils ont été peints. Un coup marqué `e`
   * (Alt enfoncé) efface le cache déjà peint dessous et rend la coulée visible.
   */
  hideStrokes: HideStroke[];
}

export interface FluidsData {
  v: typeof FLUIDS_VERSION;
  fluids: Fluid[];
}

export const emptyFluids = (): FluidsData => ({ v: FLUIDS_VERSION, fluids: [] });

export function newFluid(kind: FluidKind, name: string, id: string = crypto.randomUUID()): Fluid {
  return { id, name, kind, enabled: true, speed: 1, opacity: 1, color: null, options: { ...FLUID_OPTIONS[kind] }, strokes: [], rocks: [], sources: [], masks: [], hideStrokes: [] };
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

// --- Obstacles en polygone ---------------------------------------------------------------------

const pointsOf = (flat: number[]) => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[i * 2], y: flat[i * 2 + 1] }));

/** Aire signée d'un polygone (positive ou négative selon le sens de tracé). */
function signedArea(points: Point[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Aire d'un obstacle, rond ou polygone. */
export const rockArea = (rock: Rock) => (rock.p ? Math.abs(signedArea(pointsOf(rock.p))) : Math.PI * rock.r * rock.r);

/**
 * Obstacle prêt à stocker, d'après les sommets cliqués ou un contour tracé à main levée : les
 * sommets presque alignés sont retirés (méthode de Visvalingam), sans nombre de sommets maximal : le
 * rendu ne calcule le polygone que près de lui, et la taille totale des fluides reste plafonnée.
 * `tolerance` : écart, en pixels, en dessous duquel un sommet ne compte pas. Null s'il ne reste
 * pas de quoi faire une surface.
 */
export function polygonRock(input: Point[], tolerance: number): Rock | null {
  const points: Point[] = [];
  for (const point of input) {
    const last = points[points.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1) points.push({ x: point.x, y: point.y });
  }
  while (points.length > 1 && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) < 1) points.pop();
  const triangle = (i: number) => {
    const a = points[(i + points.length - 1) % points.length];
    const b = points[i];
    const c = points[(i + 1) % points.length];
    return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  };
  const minimum = tolerance * tolerance;
  while (points.length > 3) {
    let smallest = 0;
    for (let i = 1; i < points.length; i++) if (triangle(i) < triangle(smallest)) smallest = i;
    if (triangle(smallest) >= minimum) break;
    points.splice(smallest, 1);
  }
  if (points.length < 3) return null;
  const area = signedArea(points);
  // Épaisseur moyenne (deux fois l'aire sur le périmètre) : un polygone presque plat n'a pas de surface.
  const perimeter = points.reduce((total, point, i) => total + Math.hypot(points[(i + 1) % points.length].x - point.x, points[(i + 1) % points.length].y - point.y), 0);
  if ((2 * Math.abs(area)) / perimeter < tolerance) return null;
  return outlineRock(points.flatMap((point) => [Math.round(point.x), Math.round(point.y)]));
}

/**
 * Obstacle ou cache d'après son contour (points à plat, déjà arrondis) : centre de gravité de la
 * surface, et rayon du cercle qui contient tous les sommets. À refaire après chaque modification.
 */
export function outlineRock(flat: number[]): Rock {
  const points = pointsOf(flat);
  const area = signedArea(points);
  let cx = 0;
  let cy = 0;
  if (Math.abs(area) > 0.5) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const cross = a.x * b.y - b.x * a.y;
      cx += (a.x + b.x) * cross;
      cy += (a.y + b.y) * cross;
    }
    cx /= 6 * area;
    cy /= 6 * area;
  } else {
    // Contour aplati : la moyenne des sommets suffit.
    cx = points.reduce((total, point) => total + point.x, 0) / points.length;
    cy = points.reduce((total, point) => total + point.y, 0) / points.length;
  }
  const r = Math.max(...points.map((point) => Math.hypot(point.x - cx, point.y - cy)));
  return { x: Math.round(cx), y: Math.round(cy), r: Math.ceil(r) + 1, p: [...flat] };
}

/** Le point est-il dans l'obstacle ? */
export function insideRock(rock: Rock, point: Point) {
  if (Math.hypot(point.x - rock.x, point.y - rock.y) > rock.r) return false;
  if (!rock.p) return true;
  const p = rock.p;
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [p[i], p[i + 1], p[j], p[j + 1]];
    if (yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function addRock(fluid: Fluid, rock: Rock) {
  if (fluid.rocks.length >= MAX_ROCKS) throw new FluidFullError();
  fluid.rocks.push(rock);
}

/** Segments de rendu du cache au pinceau : un coup de n points en compte n - 1 (au moins 1). */
export const hideCost = (fluid: Fluid) => fluid.hideStrokes.reduce((total, stroke) => total + Math.max(1, stroke.p.length / 2 - 1), 0);

/** Coup de pinceau prêt à stocker : simplifié selon sa taille, arrondi au pixel. */
export function hideStroke(points: Point[], radius: number, erase: boolean): HideStroke | null {
  if (!points.length) return null;
  // Simplification plus fine que pour un trait de courant : le cache suit un bord dessiné.
  const fine = simplifyStroke(points, Math.max(1, radius * 0.1));
  return { r: Math.max(1, Math.round(radius)), p: fine.flatMap((point) => [Math.round(point.x) || 0, Math.round(point.y) || 0]), ...(erase ? { e: 1 as const } : {}) };
}

export function addHideStroke(fluid: Fluid, stroke: HideStroke) {
  if (hideCost(fluid) + Math.max(1, stroke.p.length / 2 - 1) > MAX_HIDE_SEGMENTS) throw new FluidFullError();
  fluid.hideStrokes.push(stroke);
}

/** Coup de pinceau de cache sous le pointeur (le plus récent d'abord). */
export function hideStrokeAt(data: FluidsData, point: Point): { fluid: Fluid; stroke: HideStroke } | null {
  for (const fluid of data.fluids)
    for (let i = fluid.hideStrokes.length - 1; i >= 0; i--) {
      const stroke = fluid.hideStrokes[i];
      if (nearestOnStroke(stroke, point).distance <= stroke.r) return { fluid, stroke };
    }
  return null;
}

export function addMask(fluid: Fluid, mask: Rock) {
  if (fluid.masks.length >= MAX_MASKS) throw new FluidFullError();
  fluid.masks.push(mask);
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
    for (const rock of fluid.rocks) if (insideRock(rock, point)) return { fluid, rock };
  }
  return null;
}

export function maskAt(data: FluidsData, point: Point): { fluid: Fluid; mask: Rock } | null {
  for (const fluid of data.fluids) {
    for (const mask of fluid.masks) if (insideRock(mask, point)) return { fluid, mask };
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
      if (!isObject(rock) || !isNumber(rock.x) || !isNumber(rock.y) || !isNumber(rock.r) || rock.r <= 0) continue;
      const outline = rock.p;
      if (outline === undefined) fluid.rocks.push({ x: rock.x, y: rock.y, r: rock.r });
      else if (Array.isArray(outline) && outline.length >= 6 && !(outline.length % 2) && outline.every(isNumber))
        fluid.rocks.push({ x: rock.x, y: rock.y, r: rock.r, p: outline as number[] });
    }
    for (const mask of Array.isArray(raw.masks) ? raw.masks : []) {
      if (fluid.masks.length >= MAX_MASKS) break;
      const outline = isObject(mask) ? mask.p : undefined;
      if (!isObject(mask) || !isNumber(mask.x) || !isNumber(mask.y) || !isNumber(mask.r) || mask.r <= 0) continue;
      if (Array.isArray(outline) && outline.length >= 6 && !(outline.length % 2) && outline.every(isNumber))
        fluid.masks.push({ x: mask.x, y: mask.y, r: mask.r, p: outline as number[] });
    }
    for (const stroke of Array.isArray(raw.hideStrokes) ? raw.hideStrokes : []) {
      if (!isObject(stroke) || !isNumber(stroke.r) || stroke.r <= 0 || !Array.isArray(stroke.p) || stroke.p.length < 2 || stroke.p.length % 2 || !stroke.p.every(isNumber)) continue;
      const parsed: HideStroke = { r: stroke.r, p: stroke.p as number[], ...(stroke.e === 1 ? { e: 1 as const } : {}) };
      if (hideCost(fluid) + Math.max(1, parsed.p.length / 2 - 1) > MAX_HIDE_SEGMENTS) break;
      fluid.hideStrokes.push(parsed);
    }
    data.fluids.push(fluid);
  }
  return data;
}

export const fluidsBytes = (data: FluidsData) => new TextEncoder().encode(JSON.stringify(data)).length;
