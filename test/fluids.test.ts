import { describe, expect, it } from "vitest";
import {
  FluidFullError,
  MAX_ROCKS,
  MAX_SEGMENTS,
  addRock,
  addStroke,
  emptyFluids,
  fluidAt,
  fluidCost,
  fluidStroke,
  newFluid,
  orientStroke,
  parseFluids,
  reverseStroke,
  rockAt,
  strokeAt,
} from "../src/fluids";
import { arrowsSksl, fluidSksl } from "../src/render/fluid";

const river = () => {
  const fluid = newFluid("water", "Rivière", "f1");
  fluid.strokes.push({ r: 50, p: [0, 0, 200, 0, 400, 100] });
  fluid.rocks.push({ x: 200, y: 10, r: 20 });
  return fluid;
};

describe("coulées", () => {
  it("simplifie un trait et l'arrondit", () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i * 4.2, y: Math.sin(i / 5) * 0.5 }));
    expect(fluidStroke(points, 40.4)).toEqual({ r: 40, p: [0, 0, 206, 0] });
  });

  it("retourne un trait et l'oriente d'après un glissement", () => {
    const stroke = { r: 10, p: [0, 0, 100, 0] };
    reverseStroke(stroke);
    expect(stroke.p).toEqual([100, 0, 0, 0]);
    // Glissé vers la droite : le trait coule de nouveau vers la droite.
    expect(orientStroke(stroke, { x: 20, y: 0 }, { x: 80, y: 5 })).toBe(true);
    expect(stroke.p).toEqual([0, 0, 100, 0]);
    expect(orientStroke(stroke, { x: 20, y: 0 }, { x: 80, y: 5 })).toBe(false);
  });

  it("trouve le trait, la coulée et le rocher sous le pointeur", () => {
    const data = emptyFluids();
    data.fluids.push(river());
    expect(strokeAt(data, { x: 300, y: 40 })?.fluid.id).toBe("f1");
    expect(strokeAt(data, { x: 100, y: 200 })).toBeNull();
    expect(fluidAt(data, { x: 100, y: 70 }, 30)?.id).toBe("f1");
    expect(rockAt(data, { x: 205, y: 15 })?.rock.r).toBe(20);
  });

  it("refuse un trait ou un rocher de trop", () => {
    const fluid = newFluid("lava", "Lave", "f2");
    fluid.strokes.push({ r: 5, p: Array.from({ length: (MAX_SEGMENTS + 1) * 2 }, (_, i) => i) });
    expect(fluidCost(fluid)).toBe(MAX_SEGMENTS);
    expect(() => addStroke(fluid, { r: 5, p: [0, 0, 1, 1] })).toThrow(FluidFullError);
    for (let i = 0; i < MAX_ROCKS; i++) addRock(fluid, { x: i, y: 0, r: 5 });
    expect(() => addRock(fluid, { x: 0, y: 0, r: 5 })).toThrow(FluidFullError);
  });

  it("lit prudemment ce qui est stocké", () => {
    const data = parseFluids({
      v: 1,
      fluids: [
        { ...river(), speed: 99, options: { foam: 2, autre: 1 }, color: "#ABCDEF" },
        { id: "x", kind: "inconnu" },
        { ...river(), id: "f3", strokes: [{ r: -1, p: [0, 0] }, { r: 5, p: [1, 2, 3] }, { r: 5, p: [1, 2] }] },
      ],
    });
    expect(data.fluids.map((fluid) => fluid.id)).toEqual(["f1", "f3"]);
    expect(data.fluids[0].speed).toBe(3);
    expect(data.fluids[0].options).toEqual({ foam: 1, clarity: 0.4 });
    expect(data.fluids[0].color).toBe("#abcdef");
    expect(data.fluids[1].strokes).toEqual([{ r: 5, p: [1, 2] }]);
  });
});

describe("shaders des coulées", () => {
  it("ne génère rien sans trait, et donne à chaque type ses réglages", () => {
    expect(fluidSksl(newFluid("lava", "", "v"), 150)).toBeNull();
    const water = fluidSksl(river(), 150)!;
    expect(water).toContain("uniform float o_foam;");
    expect(water).not.toContain("o_crust");
    expect(fluidSksl({ ...river(), kind: "lava", options: { crust: 0.5, glow: 0.5 } }, 150)).toContain("uniform float o_crust;");
  });

  it("reprend la distance parcourue à la fourche d'une branche", () => {
    const fluid = river();
    fluid.strokes.push({ r: 30, p: [200, 0, 300, -100] });
    // La branche commence à 200 px du début du premier trait.
    expect(fluidSksl(fluid, 150)).toContain("ss += (200.0 + along * 1.0000) * w;");
  });

  it("dessine les flèches de toutes les coulées", () => {
    expect(arrowsSksl([], null)).toBeNull();
    expect(arrowsSksl([river()], "f1")).toContain("float sel = 1.0;");
  });
});

describe("virages des traits", () => {
  it("arrondit un coin vif et laisse une ligne presque droite", async () => {
    const { roundCorners } = await import("../src/render/fluid");
    expect(roundCorners([[0, 0], [100, 2], [200, 0]], 50)).toEqual([[0, 0], [100, 2], [200, 0]]);
    const rounded = roundCorners([[0, 0], [100, 0], [100, 100]], 50);
    // Le coin est remplacé par une courbe de 5 points, qui ne passe pas par le coin.
    expect(rounded).toHaveLength(7);
    expect(rounded).not.toContainEqual([100, 0]);
    expect(rounded[1][0]).toBeCloseTo(50);
    expect(rounded[1][1]).toBeCloseTo(0);
    expect(rounded[5][0]).toBeCloseTo(100);
    expect(rounded[5][1]).toBeCloseTo(50);
  });
});

describe("autres fluides", () => {
  it("donne à chaque type ses propres réglages et son shader", async () => {
    const { FLUID_KINDS, FLUID_OPTIONS } = await import("../src/fluids");
    for (const kind of FLUID_KINDS) {
      const fluid = { ...newFluid(kind, "", kind), strokes: [{ r: 50, p: [0, 0, 300, 20] }] };
      const sksl = fluidSksl(fluid, 150)!;
      for (const key of Object.keys(FLUID_OPTIONS[kind])) expect(sksl).toContain(`uniform float o_${key};`);
    }
  });

  it("pose les sources dans un bassin, et le rivage en garde le côté de la mer", () => {
    const pool = { ...newFluid("pool", "", "f"), strokes: [{ r: 80, p: [100, 100, 300, 120] }], sources: [{ x: 150, y: 100, r: 60 }, { x: 250, y: 110, r: 40 }] };
    expect(fluidSksl(pool, 150)!.match(/float wob = /g)).toHaveLength(2);
    expect(fluidSksl({ ...newFluid("shore", "", "s"), strokes: [{ r: 80, p: [0, 0, 500, 0] }] }, 150)).toContain("float x = -tRaw / rr;");
  });
});
