import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, HARD_LIMITS, LIMIT_RANGES, limitsIn, parseLimit, raisedLimits, settingsWith } from "../src/limits";
import {
  MAX_ZONES_BYTES,
  TooManyZonesError,
  ZoneFullError,
  addShape,
  addZone,
  emptyZones,
  brushShape,
  newZone,
  parseZones,
  zoneCost,
  zoneStrokes,
  zonesBytes,
  type Zone,
} from "../src/zones";

describe("zones peintes", () => {
  it("simplifie et arrondit un coup de pinceau", () => {
    const points = Array.from({ length: 80 }, (_, i) => ({ x: i * 3.3, y: 100 + Math.sin(i / 4) * 0.4 }));
    const shape = brushShape(points, 35.4);
    expect(shape).toEqual({ t: "b", r: 35, p: [0, 100, 261, 100] });
    expect(brushShape(points, 20, true)).toMatchObject({ e: 1 });
  });

  it("transforme les formes en segments pour le shader, gomme comprise", () => {
    const zone: Zone = {
      ...newZone("Grotte", [], "z1"),
      shapes: [
        { t: "b", r: 10, p: [0, 0, 50, 0, 50, 50] },
        { t: "b", r: 10, p: [200, 200] },
        { t: "r", x: 0, y: 0, w: 20, h: 30 },
        { t: "c", x: 5, y: 5, r: 8, e: 1 },
      ],
    };
    expect(zoneCost(zone)).toBe(5);
    expect(zoneStrokes(zone)).toEqual([
      { k: "line", x1: 0, y1: 0, x2: 50, y2: 0, r: 10 },
      { k: "line", x1: 50, y1: 0, x2: 50, y2: 50, r: 10 },
      { k: "circle", x: 200, y: 200, r: 10 },
      { k: "rect", x: 0, y: 0, w: 20, h: 30 },
      { k: "circle", x: 5, y: 5, r: 8, erase: true },
    ]);
  });

  it("refuse une forme ou une zone au-delà des limites de la salle", () => {
    const limits = { ...DEFAULT_LIMITS, shapes: 20, zones: 1 };
    const zone = newZone("Pleine", [], "z1");
    zone.shapes.push({ t: "b", r: 5, p: Array.from({ length: 21 * 2 }, (_, i) => i) });
    expect(zoneCost(zone)).toBe(20);
    expect(() => addShape(zone, { t: "c", x: 0, y: 0, r: 5 }, limits)).toThrow(ZoneFullError);
    const data = emptyZones();
    addZone(data, zone, limits);
    expect(() => addZone(data, newZone("Autre", data.zones, "z2"), limits)).toThrow(TooManyZonesError);
  });

  it("donne une couleur différente à chaque nouvelle zone", () => {
    const first = newZone("A", [], "a");
    const second = newZone("B", [first], "b");
    expect(second.color).not.toBe(first.color);
  });

  it("lit prudemment ce qui est stocké", () => {
    const data = parseZones({
      v: 1,
      zones: [
        { id: "z1", name: "Grotte", feather: 12, color: "#ABCDEF", shapes: [{ t: "c", x: 1, y: 2, r: 3 }, { t: "?" }, { t: "b", r: 4, p: [1, 2, 3] }] },
        { id: "z1", name: "doublon" },
        { id: "scene", name: "réservé" },
        ...Array.from({ length: HARD_LIMITS.zones + 2 }, (_, i) => ({ id: `x${i}`, name: "x", shapes: [] })),
      ],
    });
    expect(data.zones[0]).toEqual({ id: "z1", name: "Grotte", feather: 5, color: "#abcdef", shapes: [{ t: "c", x: 1, y: 2, r: 3 }] });
    // Seule la plus haute limite réglable coupe : rien n'est perdu si le MJ baisse la sienne.
    expect(data.zones).toHaveLength(HARD_LIMITS.zones);
    expect(parseZones({ v: 2, zones: [] }).zones).toEqual([]);
  });

  it("tient dans le garde-fou avec les limites par défaut au maximum", () => {
    const zones = Array.from({ length: DEFAULT_LIMITS.zones }, (_, z) => {
      const zone = newZone(`Zone ${z}`, [], crypto.randomUUID());
      // Pinceaux de 11 points (10 segments), coordonnées de grande carte.
      for (let s = 0; s < DEFAULT_LIMITS.shapes / 10; s++) {
        zone.shapes.push({ t: "b", r: 70, p: Array.from({ length: 22 }, (_, i) => 12000 + s * 100 + i * 37) });
      }
      return zone;
    });
    const bytes = zonesBytes({ v: 1, zones });
    console.info(`zones par défaut, pleines : ${bytes} octets`);
    expect(bytes).toBeLessThan(MAX_ZONES_BYTES);
  });
});

describe("limites de la salle", () => {
  it("prend les valeurs par défaut si rien n'est réglé ou si la valeur est hors bornes", () => {
    expect(limitsIn({})).toEqual(DEFAULT_LIMITS);
    expect(limitsIn({ "com.tempest/settings": { limits: { zones: 3, shapes: 99999, effects: 2.5 } } })).toEqual({ ...DEFAULT_LIMITS, zones: 3 });
  });

  it("ramène une saisie dans les bornes, et ignore une saisie illisible", () => {
    expect(parseLimit("shapes", "5", 300)).toBe(LIMIT_RANGES.shapes[0]);
    expect(parseLimit("shapes", "1e9", 300)).toBe(LIMIT_RANGES.shapes[1]);
    expect(parseLimit("shapes", "abc", 300)).toBe(300);
    expect(parseLimit("zones", " ", 4)).toBe(4);
  });

  it("signale les limites montées au-dessus du défaut, et garde les autres réglages", () => {
    expect(raisedLimits({ ...DEFAULT_LIMITS, shapes: 800 })).toEqual(["shapes"]);
    expect(settingsWith({ "com.tempest/settings": { autre: 1 } }, { limits: DEFAULT_LIMITS })).toEqual({
      "com.tempest/settings": { autre: 1, limits: DEFAULT_LIMITS },
    });
  });
});
