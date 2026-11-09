// Modifier un polygone déjà tracé : trouver le sommet ou le bord sous le pointeur, déplacer,
// ajouter ou retirer un sommet. Sert à tous les polygones de l'extension (zones, obstacles et
// caches des fluides). Points à plat [x0, y0, x1, y1, …]. Ce fichier ne dépend pas d'Owlbear.

import type { Point } from "./drawing";

/** Un polygone modifiable : une clé pour le retrouver à l'enregistrement, ses points, sa couleur. */
export interface EditablePolygon {
  key: string;
  points: number[];
  color: string;
  /** Sommets au plus (au moins 3 dans tous les cas) */
  max: number;
}

export type VertexHit =
  | { kind: "vertex"; polygon: EditablePolygon; index: number; distance: number }
  | { kind: "edge"; polygon: EditablePolygon; index: number; at: Point; distance: number };

const vertexOf = (points: number[], index: number): Point => ({ x: points[index * 2], y: points[index * 2 + 1] });
export const vertexCount = (points: number[]) => points.length / 2;

/** Milieux des côtés : là où le MJ peut glisser pour ajouter un sommet. Le côté i va du sommet i au suivant. */
export function midpoints(points: number[]): Point[] {
  const n = vertexCount(points);
  return Array.from({ length: n }, (_, i) => {
    const a = vertexOf(points, i);
    const b = vertexOf(points, (i + 1) % n);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
}

/**
 * Ce qu'il y a sous le pointeur : un sommet d'abord (à `tolerance` près), sinon un côté. Parmi
 * plusieurs polygones, le plus proche gagne.
 */
export function hitVertex(polygons: EditablePolygon[], point: Point, tolerance: number): VertexHit | null {
  let vertex: VertexHit | null = null;
  let edge: VertexHit | null = null;
  for (const polygon of polygons) {
    const n = vertexCount(polygon.points);
    for (let i = 0; i < n; i++) {
      const a = vertexOf(polygon.points, i);
      const distance = Math.hypot(point.x - a.x, point.y - a.y);
      if (distance <= tolerance && (!vertex || distance < vertex.distance)) vertex = { kind: "vertex", polygon, index: i, distance };
      const b = vertexOf(polygon.points, (i + 1) % n);
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const ux = (b.x - a.x) / length;
      const uy = (b.y - a.y) / length;
      const h = Math.max(0, Math.min(length, (point.x - a.x) * ux + (point.y - a.y) * uy));
      const at = { x: a.x + ux * h, y: a.y + uy * h };
      const away = Math.hypot(point.x - at.x, point.y - at.y);
      if (away <= tolerance && (!edge || away < edge.distance)) edge = { kind: "edge", polygon, index: i, at, distance: away };
    }
  }
  return vertex ?? edge;
}

const rounded = (point: Point) => [Math.round(point.x) || 0, Math.round(point.y) || 0];

export function moveVertex(points: number[], index: number, to: Point) {
  const out = [...points];
  [out[index * 2], out[index * 2 + 1]] = rounded(to);
  return out;
}

/** Nouveau sommet sur le côté `edge` (entre le sommet edge et le suivant). Null si le polygone est plein. */
export function insertVertex(points: number[], edge: number, at: Point, max: number) {
  if (vertexCount(points) >= max) return null;
  const out = [...points];
  out.splice((edge + 1) * 2, 0, ...rounded(at));
  return out;
}

/** Retire un sommet. Null s'il n'en resterait pas 3. */
export function removeVertex(points: number[], index: number) {
  if (vertexCount(points) <= 3) return null;
  const out = [...points];
  out.splice(index * 2, 2);
  return out;
}
