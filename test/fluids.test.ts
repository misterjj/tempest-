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
  hideStrokeAt,
  maskAt,
  polygonRock,
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

  it("fait un obstacle d'un polygone : sommets alignés retirés, centre et rayon", () => {
    // Un carré de 100 tracé à main levée, avec des points en trop sur ses côtés.
    const side = (ax: number, ay: number, bx: number, by: number) => Array.from({ length: 10 }, (_, i) => ({ x: ax + ((bx - ax) * i) / 10, y: ay + ((by - ay) * i) / 10 }));
    const rock = polygonRock([...side(0, 0, 100, 0), ...side(100, 0, 100, 100), ...side(100, 100, 0, 100), ...side(0, 100, 0, 0), { x: 0, y: 0 }], 5)!;
    expect(rock.p).toEqual([0, 0, 100, 0, 100, 100, 0, 100]);
    expect([rock.x, rock.y]).toEqual([50, 50]);
    expect(rock.r).toBeGreaterThanOrEqual(Math.hypot(50, 50));
    // Pas de nombre de sommets maximal : un grand contour garde sa forme, seuls les points en trop partent.
    const circle = polygonRock(Array.from({ length: 200 }, (_, i) => ({ x: Math.cos((i / 200) * Math.PI * 2) * 1000, y: Math.sin((i / 200) * Math.PI * 2) * 1000 })), 1)!;
    expect(circle.p!.length / 2).toBeGreaterThan(16);
    expect(circle.p!.length / 2).toBeLessThanOrEqual(200);
    // Trois points presque alignés : pas de surface.
    expect(polygonRock([{ x: 0, y: 0 }, { x: 100, y: 1 }, { x: 200, y: 0 }], 5)).toBeNull();
    expect(polygonRock([{ x: 0, y: 0 }, { x: 100, y: 0 }], 5)).toBeNull();
  });

  it("repère un obstacle en polygone d'après son contour, pas son cercle", () => {
    const data = emptyFluids();
    const fluid = river();
    // Un L : le coin vide en haut à droite est hors de l'obstacle.
    fluid.rocks = [{ x: 40, y: 60, r: 90, p: [0, 0, 40, 0, 40, 80, 120, 80, 120, 120, 0, 120] }];
    data.fluids.push(fluid);
    expect(rockAt(data, { x: 20, y: 20 })).not.toBeNull();
    expect(rockAt(data, { x: 100, y: 100 })).not.toBeNull();
    expect(rockAt(data, { x: 100, y: 20 })).toBeNull();
  });

  it("dessine un obstacle en polygone dans la coulée et pour le MJ", () => {
    const fluid = river();
    fluid.rocks.push({ x: 300, y: 50, r: 40, p: [270, 20, 330, 30, 320, 80] });
    expect(fluidSksl(fluid, 150)).toContain("float rock_poly1(vec2 p)");
    expect(arrowsSksl([fluid], null)).toContain("float obstacle_poly1(vec2 p)");
  });

  it("découpe la coulée sous un cache, sans toucher au courant", () => {
    const fluid = river();
    const plain = fluidSksl(fluid, 150)!;
    fluid.masks.push({ x: 250, y: 0, r: 120, p: [200, -100, 300, -100, 300, 100, 200, 100] });
    const hidden = fluidSksl(fluid, 150)!;
    // Le corps de la coulée est inchangé ; seul un nouveau main le découpe.
    expect(hidden).toContain(plain.replace("half4 main(float2 coord) {", "half4 fluidBody(float2 coord) {"));
    expect(hidden).toContain("float hide_poly0(vec2 p)");
    expect(hidden).toContain("return fluidBody(coord) * half(keep);");
    expect(arrowsSksl([fluid], null)).toContain("float cache0_poly0(vec2 p)");
    const data = emptyFluids();
    data.fluids.push(fluid);
    expect(maskAt(data, { x: 250, y: 50 })?.fluid.id).toBe("f1");
    expect(maskAt(data, { x: 350, y: 50 })).toBeNull();
  });

  it("cache au pinceau : les coups dans l'ordre, la gomme rend visible", () => {
    const fluid = river();
    fluid.hideStrokes.push({ r: 20, p: [100, 0, 200, 0] }, { r: 10, p: [150, 0], e: 1 });
    const sksl = fluidSksl(fluid, 150)!;
    expect(sksl).toContain("float hideCover(vec2 p)");
    expect(sksl).toContain("d = min(d, hideSegment(p, vec2(100.0, 0.0), vec2(200.0, 0.0)));");
    // Le coup de gomme vient après, et réduit la part cachée.
    expect(sksl.indexOf("h = max(h, c);")).toBeLessThan(sksl.indexOf("h *= 1.0 - c;"));
    expect(arrowsSksl([fluid], null)).toContain("float cache0Cover(vec2 p)");
    const data = emptyFluids();
    data.fluids.push(fluid);
    // Le plus récent d'abord : la gomme, au centre.
    expect(hideStrokeAt(data, { x: 150, y: 5 })?.stroke.e).toBe(1);
    expect(hideStrokeAt(data, { x: 110, y: 5 })?.stroke.r).toBe(20);
    expect(hideStrokeAt(data, { x: 110, y: 40 })).toBeNull();
    // Relu tel quel, gomme comprise.
    expect(parseFluids(JSON.parse(JSON.stringify(data))).fluids[0].hideStrokes).toEqual(fluid.hideStrokes);
  });

  it("relit un obstacle et un cache de plus de 16 sommets", () => {
    const outline = Array.from({ length: 40 }, (_, i) => [Math.round(Math.cos((i / 40) * Math.PI * 2) * 300), Math.round(Math.sin((i / 40) * Math.PI * 2) * 300)]).flat().map((v) => v + 0);
    const fluid = river();
    fluid.rocks.push({ x: 0, y: 0, r: 300, p: outline });
    fluid.masks.push({ x: 0, y: 0, r: 300, p: outline });
    const data = emptyFluids();
    data.fluids.push(fluid);
    const read = parseFluids(JSON.parse(JSON.stringify(data))).fluids[0];
    expect(read.rocks[1].p).toEqual(outline);
    expect(read.masks[0].p).toEqual(outline);
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
        { ...river(), id: "f4", rocks: [{ x: 0, y: 0, r: 5, p: [0, 0, 1, 1] }, { x: 0, y: 0, r: 5, p: [0, 0, 10, 0, 0, 10] }, { x: 0, y: 0, r: 5, p: "x" }], masks: [{ x: 0, y: 0, r: 5 }, { x: 0, y: 0, r: 5, p: [0, 0, 10, 0, 0, 10] }] },
        { ...river(), id: "f3", strokes: [{ r: -1, p: [0, 0] }, { r: 5, p: [1, 2, 3] }, { r: 5, p: [1, 2] }] },
      ],
    });
    expect(data.fluids.map((fluid) => fluid.id)).toEqual(["f1", "f4", "f3"]);
    expect(data.fluids[1].rocks).toEqual([{ x: 0, y: 0, r: 5, p: [0, 0, 10, 0, 0, 10] }]);
    // Un cache est toujours un polygone.
    expect(data.fluids[1].masks).toEqual([{ x: 0, y: 0, r: 5, p: [0, 0, 10, 0, 0, 10] }]);
    expect(data.fluids[0].masks).toEqual([]);
    expect(data.fluids[0].speed).toBe(3);
    expect(data.fluids[0].options).toEqual({ foam: 1, clarity: 0.4 });
    expect(data.fluids[0].color).toBe("#abcdef");
    expect(data.fluids[2].strokes).toEqual([{ r: 5, p: [1, 2] }]);
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
