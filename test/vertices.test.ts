import { describe, expect, it } from "vitest";
import { hitVertex, insertVertex, midpoints, moveVertex, removeVertex, type EditablePolygon } from "../src/tool/vertices";
import { outlineRock } from "../src/fluids";

const square = (key = "a", x = 0): EditablePolygon => ({ key, points: [x, 0, x + 100, 0, x + 100, 100, x, 100], color: "#fff", max: 5 });

describe("modifier un polygone", () => {
  it("trouve un sommet avant un côté, et le polygone le plus proche", () => {
    const polygons = [square("a"), square("b", 105)];
    expect(hitVertex(polygons, { x: 98, y: 3 }, 10)).toMatchObject({ kind: "vertex", index: 1, polygon: { key: "a" } });
    expect(hitVertex(polygons, { x: 104, y: 50 }, 10)).toMatchObject({ kind: "edge", index: 3, polygon: { key: "b" }, at: { x: 105, y: 50 } });
    expect(hitVertex(polygons, { x: 50, y: 50 }, 10)).toBeNull();
  });

  it("déplace, ajoute et retire des sommets", () => {
    const { points } = square();
    expect(moveVertex(points, 2, { x: 120.4, y: 130.6 })).toEqual([0, 0, 100, 0, 120, 131, 0, 100]);
    // Le côté 1 va du sommet 1 au sommet 2 : le nouveau sommet se glisse entre eux.
    const five = insertVertex(points, 1, { x: 130, y: 50 }, 5)!;
    expect(five).toEqual([0, 0, 100, 0, 130, 50, 100, 100, 0, 100]);
    expect(insertVertex(five, 0, { x: 50, y: -10 }, 5)).toBeNull();
    expect(removeVertex(five, 2)).toEqual(points);
    expect(removeVertex([0, 0, 10, 0, 0, 10], 0)).toBeNull();
    expect(midpoints(points)[3]).toEqual({ x: 0, y: 50 });
  });

  it("recalcule le centre et le rayon d'un obstacle modifié", () => {
    expect(outlineRock([0, 0, 100, 0, 100, 100, 0, 100])).toEqual({ x: 50, y: 50, r: 72, p: [0, 0, 100, 0, 100, 100, 0, 100] });
    // Contour aplati : pas de division par zéro.
    expect(outlineRock([0, 0, 10, 0, 20, 0]).x).toBe(10);
  });
});

import { parseHint } from "../src/hint/messages";

describe("barre d'aide", () => {
  it("sépare les gestes de leur action, et garde les phrases", () => {
    expect(parseHint("Le courant contourne l'obstacle|Clic=poser un sommet| [ et ] = largeur |")).toEqual([
      { text: "Le courant contourne l'obstacle" },
      { gesture: "Clic", action: "poser un sommet" },
      { gesture: "[ et ]", action: "largeur" },
    ]);
  });
});
