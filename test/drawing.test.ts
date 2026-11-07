import { describe, expect, it } from "vitest";
import { BRUSH_SIZES, addPoint, circleShape, parseToolSettings, rectShape, strokeShape } from "../src/tool/drawing";

describe("outil de peinture", () => {
  it("tire un rectangle dans n'importe quel sens, et ignore un rectangle plat", () => {
    expect(rectShape({ x: 100, y: 80 }, { x: 20.4, y: 10.6 })).toEqual({ t: "r", x: 20, y: 11, w: 80, h: 69 });
    expect(rectShape({ x: 0, y: 0 }, { x: 50, y: 0.4 })).toBeNull();
  });

  it("tire un cercle depuis son centre", () => {
    expect(circleShape({ x: 10, y: 10 }, { x: 13, y: 14 })).toEqual({ t: "c", x: 10, y: 10, r: 5 });
    expect(circleShape({ x: 10, y: 10 }, { x: 10.2, y: 10 })).toBeNull();
  });

  it("n'ajoute un point au tracé que s'il s'est assez éloigné", () => {
    const points = [{ x: 0, y: 0 }];
    addPoint(points, { x: 3, y: 0 }, 35);
    addPoint(points, { x: 8, y: 0 }, 35);
    expect(points).toEqual([{ x: 0, y: 0 }, { x: 8, y: 0 }]);
  });

  it("fait un coup de gomme, ou un rond pour un simple clic", () => {
    expect(strokeShape([{ x: 5, y: 5 }], 20, true)).toEqual({ t: "b", r: 20, p: [5, 5], e: 1 });
    expect(strokeShape([], 20)).toBeNull();
  });

  it("garde des réglages d'outil valides", () => {
    expect(parseToolSettings(undefined)).toEqual({ zone: null, size: BRUSH_SIZES.default, erase: false, alt: false, erasingNow: false });
    expect(parseToolSettings({ zone: "z1", size: 99, erase: true })).toMatchObject({ zone: "z1", size: BRUSH_SIZES.max, erase: true });
  });
});

describe("polygone et effacement", () => {
  it("ferme un polygone d'au moins 3 points distincts", async () => {
    const { polygonShape, closesPolygon } = await import("../src/tool/drawing");
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100.3, y: 0 }, { x: 50, y: 80 }, { x: 0.2, y: 0.1 }];
    expect(polygonShape(points, true)).toEqual({ t: "g", p: [0, 0, 100, 0, 50, 80], e: 1 });
    expect(polygonShape(points.slice(0, 2))).toBeNull();
    expect(closesPolygon(points.slice(0, 4), { x: 5, y: 3 }, 10)).toBe(true);
    expect(closesPolygon(points.slice(0, 2), { x: 0, y: 0 }, 10)).toBe(false);
  });

  it("efface avec Alt maintenu, ou peint avec Alt si l'effacement est choisi", async () => {
    const { erasing } = await import("../src/tool/drawing");
    expect(erasing({ zone: null, size: 1, erase: false }, true)).toBe(true);
    expect(erasing({ zone: null, size: 1, erase: true }, true)).toBe(false);
  });
});

describe("raccourcis affichés", () => {
  it("utilise ⌘ et ⌥ sur Mac, Ctrl et Alt ailleurs", async () => {
    const { keyNames } = await import("../src/keys");
    expect(keyNames(true)).toMatchObject({ undo: "⌘Z", redo: "⌘⇧Z", alt: "⌥ Option" });
    expect(keyNames(false)).toMatchObject({ undo: "Ctrl+Z", redo: "Ctrl+Shift+Z", alt: "Alt" });
  });
});
