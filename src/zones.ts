// Zones peintes par le MJ : un nom, un fondu et des formes (pinceau, rectangle, cercle, gomme).
// Stockées à part de l'état des réglages (clé ZONES_KEY) : elles ne changent que quand le MJ
// peint, alors que les réglages changent à chaque mouvement de curseur.
// Ce fichier ne dépend pas d'Owlbear.

import { HARD_LIMITS, type Limits } from "./limits";
import { simplifyStroke, type Stroke } from "./render/mask";
import { PLUGIN_ID } from "./state";

export const ZONES_KEY = `${PLUGIN_ID}/zones`;
export const ZONES_VERSION = 1;
/**
 * Garde-fou de taille, loin des limites réglables : Owlbear a accepté 512 Ko dans une scène
 * sans refus lors de nos tests. Le nombre de zones et de formes se règle dans limits.ts.
 */
export const MAX_ZONES_BYTES = 256 * 1024;
export const MAX_FEATHER = 5;

/** Couleurs de surimpression, attribuées aux zones dans l'ordre. */
export const ZONE_COLORS = ["#4f9dff", "#ff8a3d", "#3ddc97", "#d36bff", "#ffd23d", "#ff5f7e", "#3dd6ff", "#a3e635"];

/**
 * Formes au format stocké, en coordonnées entières de la carte. `e: 1` : coup de gomme.
 * Pinceau : rayon et liste de points à plat [x0, y0, x1, y1, …].
 */
export type Shape =
  | { t: "b"; r: number; p: number[]; e?: 1 }
  | { t: "r"; x: number; y: number; w: number; h: number; e?: 1 }
  | { t: "c"; x: number; y: number; r: number; e?: 1 }
  /** Polygone fermé : au moins 3 points à plat [x0, y0, x1, y1, …] */
  | { t: "g"; p: number[]; e?: 1 };

export interface Zone {
  id: string;
  name: string;
  /** Fondu au bord, en cases */
  feather: number;
  color: string;
  shapes: Shape[];
}

export interface ZonesData {
  v: typeof ZONES_VERSION;
  zones: Zone[];
}

export const emptyZones = (): ZonesData => ({ v: ZONES_VERSION, zones: [] });

/**
 * Segments de rendu d'une forme : un pinceau de n points en compte n - 1 (un seul point : 1),
 * un polygone de n points en compte n (une arête par côté).
 */
export const shapeCost = (shape: Shape) =>
  shape.t === "b" ? Math.max(1, shape.p.length / 2 - 1) : shape.t === "g" ? shape.p.length / 2 : 1;
export const zoneCost = (zone: Zone) => zone.shapes.reduce((total, shape) => total + shapeCost(shape), 0);

/** Formes prêtes pour le shader. */
export function zoneStrokes(zone: Zone): Stroke[] {
  const strokes: Stroke[] = [];
  for (const shape of zone.shapes) {
    const erase = shape.e === 1 ? { erase: true } : {};
    if (shape.t === "r") strokes.push({ k: "rect", x: shape.x, y: shape.y, w: shape.w, h: shape.h, ...erase });
    else if (shape.t === "c") strokes.push({ k: "circle", x: shape.x, y: shape.y, r: shape.r, ...erase });
    else if (shape.t === "g") strokes.push({ k: "poly", p: shape.p, ...erase });
    else if (shape.p.length <= 2) strokes.push({ k: "circle", x: shape.p[0], y: shape.p[1], r: shape.r, ...erase });
    else {
      for (let i = 2; i < shape.p.length; i += 2) {
        strokes.push({ k: "line", x1: shape.p[i - 2], y1: shape.p[i - 1], x2: shape.p[i], y2: shape.p[i + 1], r: shape.r, ...erase });
      }
    }
  }
  return strokes;
}

/**
 * Coup de pinceau prêt à stocker : simplifié (les points presque alignés disparaissent, avec une
 * tolérance proportionnelle à la taille du pinceau) et arrondi au pixel.
 */
export function brushShape(points: { x: number; y: number }[], radius: number, erase = false): Shape {
  const simple = simplifyStroke(points, Math.max(1, radius * 0.25));
  return {
    t: "b",
    r: Math.max(1, Math.round(radius)),
    p: simple.flatMap((point) => [Math.round(point.x), Math.round(point.y)]),
    ...(erase ? { e: 1 as const } : {}),
  };
}

export class ZoneFullError extends Error {}
export class TooManyZonesError extends Error {}

/** Ajoute une forme si la zone a encore la place dans la limite de la salle ; sinon ZoneFullError. */
export function addShape(zone: Zone, shape: Shape, limits: Limits) {
  if (zoneCost(zone) + shapeCost(shape) > limits.shapes) throw new ZoneFullError();
  zone.shapes.push(shape);
}

/** Ajoute une zone si la scène en a encore la place ; sinon TooManyZonesError. */
export function addZone(data: ZonesData, zone: Zone, limits: Limits) {
  if (data.zones.length >= limits.zones) throw new TooManyZonesError();
  data.zones.push(zone);
}

export function newZone(name: string, existing: Zone[], id: string = crypto.randomUUID()): Zone {
  const used = new Set(existing.map((zone) => zone.color));
  const color = ZONE_COLORS.find((candidate) => !used.has(candidate)) ?? ZONE_COLORS[existing.length % ZONE_COLORS.length];
  return { id, name, feather: 1, color, shapes: [] };
}

// --- Lecture prudente -------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

function parseShape(value: unknown): Shape | null {
  if (!isObject(value)) return null;
  const erase = value.e === 1 ? { e: 1 as const } : {};
  if (value.t === "b" && isNumber(value.r) && value.r > 0 && Array.isArray(value.p) && value.p.length >= 2 && value.p.length % 2 === 0 && value.p.every(isNumber)) {
    return { t: "b", r: value.r, p: value.p as number[], ...erase };
  }
  if (value.t === "r" && [value.x, value.y, value.w, value.h].every(isNumber)) {
    return { t: "r", x: value.x as number, y: value.y as number, w: value.w as number, h: value.h as number, ...erase };
  }
  if (value.t === "g" && Array.isArray(value.p) && value.p.length >= 6 && value.p.length % 2 === 0 && value.p.every(isNumber)) {
    return { t: "g", p: value.p as number[], ...erase };
  }
  if (value.t === "c" && [value.x, value.y, value.r].every(isNumber) && (value.r as number) > 0) {
    return { t: "c", x: value.x as number, y: value.y as number, r: value.r as number, ...erase };
  }
  return null;
}

/**
 * Zones valides : formes inconnues ignorées. Seules les bornes maximales des réglages coupent :
 * des zones faites avec une limite plus haute restent lisibles si le MJ la baisse ensuite.
 */
export function parseZones(value: unknown): ZonesData {
  const data = emptyZones();
  if (!isObject(value) || value.v !== ZONES_VERSION || !Array.isArray(value.zones)) return data;
  const ids = new Set<string>();
  for (const raw of value.zones) {
    if (data.zones.length >= HARD_LIMITS.zones) break;
    if (!isObject(raw) || typeof raw.id !== "string" || !raw.id || raw.id === "scene" || ids.has(raw.id)) continue;
    ids.add(raw.id);
    const zone: Zone = {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name.slice(0, 40) : "",
      feather: isNumber(raw.feather) ? Math.min(MAX_FEATHER, Math.max(0, raw.feather)) : 1,
      color: isColor(raw.color) ? raw.color.toLowerCase() : ZONE_COLORS[data.zones.length % ZONE_COLORS.length],
      shapes: [],
    };
    for (const shape of Array.isArray(raw.shapes) ? raw.shapes : []) {
      const parsed = parseShape(shape);
      if (!parsed || zoneCost(zone) + shapeCost(parsed) > HARD_LIMITS.shapes) continue;
      zone.shapes.push(parsed);
    }
    data.zones.push(zone);
  }
  return data;
}

export const zonesBytes = (data: ZonesData) => new TextEncoder().encode(JSON.stringify(data)).length;
