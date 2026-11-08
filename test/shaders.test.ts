import { describe, expect, it } from "vitest";
import { maskFunction, maskSksl, type Stroke } from "../src/render/mask";
import { maskOverlaySksl, postSksl, weatherSksl } from "../src/render/shaders";
import { FILTER_KINDS, WEATHER_KINDS } from "../src/state";

/** Uniforms fournis par Owlbear, avec leur type : les redéclarer autrement casse le shader. */
const BUILT_IN: Record<string, string> = {
  size: "vec2",
  position: "vec2",
  scale: "vec2",
  rotation: "float",
  model: "mat3",
  view: "mat3",
  modelView: "mat3",
  time: "float",
};

const zone: Stroke[] = [
  { k: "circle", x: 0, y: 0, r: 50 },
  { k: "rect", x: 100, y: 0, w: 80, h: 40 },
  { k: "line", x1: 0, y1: 0, x2: 200, y2: 100, r: 20 },
  { k: "circle", x: 0, y: 0, r: 10, erase: true },
];

describe("shaders", () => {
  const shaders: Record<string, string> = {
    ...Object.fromEntries(WEATHER_KINDS.filter((kind) => kind !== "heat").map((kind) => [kind, weatherSksl(kind, maskFunction("mask", zone, 70))])),
    grade: postSksl(
      maskFunction("zm0", zone, 70),
      [{ prefix: "h0_", mask: "zm0(coord)" }],
      [
        { prefix: "l0_", mask: "float l0_mask(vec2 p) { return l0_weight; }", time: true, filters: [...FILTER_KINDS] },
        { prefix: "l1_", mask: "float l1_mask(vec2 p) { return l1_weight * zm0(p); }", time: false, filters: ["blur", "sepia"] },
      ],
    ),
    overlay: maskOverlaySksl(maskFunction("mask", zone, 70)),
  };

  it.each(Object.entries(shaders))("%s ne redéclare aucun uniform d'Owlbear sous un autre type", (_, sksl) => {
    for (const [, type, name] of sksl.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)) {
      if (name in BUILT_IN) expect(`${name}: ${type}`).toBe(`${name}: ${BUILT_IN[name]}`);
    }
  });

  /**
   * Mots réservés de GLSL ES. La version de Skia d'Owlbear les transmet tels quels à la carte
   * graphique, qui refuse alors le shader (« patch » a cassé toute la météo une fois).
   */
  const RESERVED = new Set(
    ("attribute varying coherent volatile restrict readonly writeonly resource atomic_uint noperspective patch sample " +
      "subroutine common partition active asm class union enum typedef template this goto inline noinline public static " +
      "extern external interface long short double fixed unsigned superp input output filter image sizeof cast namespace " +
      "using centroid flat smooth layout precise buffer shared invariant lowp mediump highp precision texture sampler").split(" "),
  );

  it.each(Object.entries(shaders))("%s n'utilise aucun mot réservé de GLSL comme nom", (_, sksl) => {
    const names = [...sksl.matchAll(/\b(?:float|int|bool|vec[234]|half[234]?|mat[234])\s+([A-Za-z_]\w*)/g)].map((match) => match[1]);
    expect(names.filter((name) => RESERVED.has(name))).toEqual([]);
  });

  it("lit la scène en coordonnées écran", () => {
    expect(shaders.grade).toContain("vec2 screen = (vec3(at, 1.0) * view).xy;");
    expect(shaders.grade).toContain("scene.eval(screen)");
  });

  it("écrit les formes du masque dans le shader, gomme comprise", () => {
    const mask = maskSksl(zone, 70);
    expect(mask).toContain("m = max(m, mask_cover(length(p - vec2(0.0, 0.0)) - 50.0));");
    expect(mask).toContain("m = min(m, 1.0 - mask_cover(length(p - vec2(0.0, 0.0)) - 10.0));");
    expect(maskSksl(null, 70)).toContain("float mask(vec2 p) { return 1.0; }");
  });
});

describe("simplification d'un coup de pinceau", () => {
  it("garde les virages et retire les points presque alignés", async () => {
    const { simplifyStroke } = await import("../src/render/mask");
    const wobbly = Array.from({ length: 100 }, (_, index) => ({ x: index * 5, y: Math.sin(index / 3) * 0.5 }));
    expect(simplifyStroke(wobbly, 2)).toEqual([wobbly[0], wobbly[99]]);
    const corner = [...Array.from({ length: 50 }, (_, i) => ({ x: i * 4, y: 0 })), ...Array.from({ length: 50 }, (_, i) => ({ x: 196, y: (i + 1) * 4 }))];
    expect(simplifyStroke(corner, 2)).toEqual([corner[0], corner[49], corner[99]]);
  });
});

describe("filtre flou", () => {
  it("ne relit la scène autour du point que s'il est activé", () => {
    const look = (filters: ("blur" | "sepia")[]) => [{ prefix: "l0_", mask: "float l0_mask(vec2 p) { return 1.0; }", time: false, filters }];
    expect(postSksl("", [], look(["sepia"]))).not.toContain("f_blur");
    expect(postSksl("", [], look(["blur", "sepia"]))).toContain("sum += scene.eval");
    expect(postSksl("", [], look(["sepia"]))).toContain("0.0, 1.0), l0_f_sepia);");
  });
});
