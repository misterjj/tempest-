// Gestes de l'outil de peinture transformés en formes de zone. Ne dépend pas d'Owlbear.

import { brushShape, type Shape } from "../zones";

export type Point = { x: number; y: number };
export type PaintMode = "brush" | "rect" | "circle" | "polygon";
export const PAINT_MODES: PaintMode[] = ["brush", "rect", "circle", "polygon"];

/** Taille du pinceau, en cases (diamètre). */
export const BRUSH_SIZES = { min: 0.25, max: 6, default: 1 };

/** Réglages de l'outil, gardés par Owlbear avec l'outil (métadonnées d'outil). */
export interface ToolSettings {
  /** Zone peinte, ou null : la première forme en crée une */
  zone: string | null;
  /** Diamètre du pinceau, en cases */
  size: number;
  /** Effacer plutôt que peindre, avec n'importe quelle forme */
  erase: boolean;
  /** Alt (⌥) est enfoncé : le mode s'inverse le temps de l'appui */
  alt?: boolean;
  /**
   * Mode réellement actif, Alt compris. Sert aux icônes de la barre d'outils : leurs filtres ne
   * savent pas combiner deux réglages.
   */
  erasingNow?: boolean;
}

export const DEFAULT_TOOL_SETTINGS: ToolSettings = { zone: null, size: BRUSH_SIZES.default, erase: false };

export function parseToolSettings(value: unknown): ToolSettings {
  const raw = (typeof value === "object" && value ? value : {}) as Partial<ToolSettings>;
  const size = Number(raw.size);
  return {
    zone: typeof raw.zone === "string" && raw.zone ? raw.zone : null,
    size: Number.isFinite(size) ? Math.min(BRUSH_SIZES.max, Math.max(BRUSH_SIZES.min, size)) : BRUSH_SIZES.default,
    erase: raw.erase === true,
    alt: raw.alt === true,
    erasingNow: raw.erasingNow === true,
  };
}

/**
 * Ajoute un point au tracé s'il s'est assez éloigné du précédent : un geste rapide ou lent
 * donne à peu près le même nombre de points, avant même la simplification.
 */
export function addPoint(points: Point[], point: Point, radius: number) {
  const last = points[points.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= Math.max(1, radius * 0.2)) points.push(point);
  return points;
}

const round = (value: number) => Math.round(value);

/** Alt maintenu inverse le réglage, comme dans les logiciels de dessin. */
export const erasing = (settings: ToolSettings, altKey: boolean) => settings.erase !== altKey;

/** Un clic aussi près du premier point du polygone le ferme. */
export const closesPolygon = (points: Point[], point: Point, tolerance: number) =>
  points.length >= 3 && Math.hypot(point.x - points[0].x, point.y - points[0].y) <= tolerance;

/** Polygone fermé : au moins 3 points distincts, sinon rien. */
export function polygonShape(points: Point[], erase = false): Shape | null {
  const distinct = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 1;
  });
  if (distinct.length >= 2 && Math.hypot(distinct[0].x - distinct[distinct.length - 1].x, distinct[0].y - distinct[distinct.length - 1].y) < 1) distinct.pop();
  if (distinct.length < 3) return null;
  return { t: "g", p: distinct.flatMap((point) => [round(point.x), round(point.y)]), ...(erase ? { e: 1 as const } : {}) };
}

/** Rectangle tiré d'un coin à l'autre, dans n'importe quel sens. */
export function rectShape(from: Point, to: Point, erase = false): Shape | null {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const w = Math.abs(to.x - from.x);
  const h = Math.abs(to.y - from.y);
  if (w < 1 || h < 1) return null;
  return { t: "r", x: round(x), y: round(y), w: round(w), h: round(h), ...(erase ? { e: 1 as const } : {}) };
}

/** Cercle tiré depuis son centre. */
export function circleShape(center: Point, edge: Point, erase = false): Shape | null {
  const r = Math.hypot(edge.x - center.x, edge.y - center.y);
  if (r < 1) return null;
  return { t: "c", x: round(center.x), y: round(center.y), r: round(r), ...(erase ? { e: 1 as const } : {}) };
}

/** Coup de pinceau : simplifié, arrondi. Un simple clic fait un rond. */
export const strokeShape = (points: Point[], radius: number, erase = false): Shape | null =>
  points.length ? brushShape(points, radius, erase) : null;
