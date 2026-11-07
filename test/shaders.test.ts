import { describe, expect, it } from "vitest";
import { maskSksl, type Stroke } from "../src/render/mask";
import { gradeSksl, maskOverlaySksl, rainSksl } from "../src/render/shaders";

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
  const shaders = {
    rain: rainSksl(maskSksl(zone, 70)),
    grade: gradeSksl(maskSksl(null, 70)),
    overlay: maskOverlaySksl(maskSksl(zone, 70)),
  };

  it.each(Object.entries(shaders))("%s ne redéclare aucun uniform d'Owlbear sous un autre type", (_, sksl) => {
    for (const [, type, name] of sksl.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)) {
      if (name in BUILT_IN) expect(`${name}: ${type}`).toBe(`${name}: ${BUILT_IN[name]}`);
    }
  });

  it("lit la scène en coordonnées écran", () => {
    expect(shaders.grade).toContain("scene.eval((vec3(coord, 1.0) * view).xy)");
  });

  it("écrit les formes du masque dans le shader, gomme comprise", () => {
    const mask = maskSksl(zone, 70);
    expect(mask).toContain("m = max(m, cover(length(p - vec2(0.0, 0.0)) - 50.0));");
    expect(mask).toContain("m = min(m, 1.0 - cover(length(p - vec2(0.0, 0.0)) - 10.0));");
    expect(maskSksl(null, 70)).toBe("float mask(vec2 p) { return 1.0; }");
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
