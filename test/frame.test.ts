import { describe, expect, it } from "vitest";
import { EMPTY_FRAME, NEUTRAL_LIGHT, blendFrames, frameOf } from "../src/render/frame";
import { wantedPost } from "../src/render/post";
import { SCENE_ZONE, defaultEffect, defaultState, parseState } from "../src/state";

const stateWith = (setup: (state: ReturnType<typeof defaultState>) => void) => {
  const state = defaultState();
  setup(state);
  return state;
};

describe("images de rendu", () => {
  it("ne garde que ce qui se voit, et rien en pause", () => {
    const state = stateWith((s) => {
      s.weather.push(defaultEffect("rain", SCENE_ZONE, "a"), { ...defaultEffect("snow", SCENE_ZONE, "b"), enabled: false }, defaultEffect("fog", "gone", "c"));
      s.looks[0].time.enabled = true;
    });
    const frame = frameOf(state, new Set());
    expect(frame.weather.map((effect) => effect.id)).toEqual(["a"]);
    expect(frame.looks).toHaveLength(1);
    expect(frameOf({ ...state, paused: true }, new Set())).toEqual(EMPTY_FRAME);
  });

  it("fait apparaître et disparaître les effets en fondu", () => {
    const from = frameOf(stateWith((s) => s.weather.push({ ...defaultEffect("rain", SCENE_ZONE, "old"), opacity: 0.8 })), new Set());
    const to = frameOf(stateWith((s) => s.weather.push(defaultEffect("snow", SCENE_ZONE, "new"))), new Set());
    const half = blendFrames(from, to, 0.5);
    expect(half.weather.find((effect) => effect.id === "old")!.opacity).toBeCloseTo(0.4);
    expect(half.weather.find((effect) => effect.id === "new")!.opacity).toBeCloseTo(0.5);
    expect(blendFrames(from, to, 1)).toBe(to);
  });

  it("mélange les réglages, sauf ceux qui feraient filer les particules", () => {
    const from = frameOf(stateWith((s) => s.weather.push({ ...defaultEffect("rain", SCENE_ZONE, "a"), intensity: 0.2, speed: 1 })), new Set());
    const to = frameOf(stateWith((s) => s.weather.push({ ...defaultEffect("rain", SCENE_ZONE, "a"), intensity: 0.6, speed: 2 })), new Set());
    const half = blendFrames(from, to, 0.5).weather[0];
    expect(half.intensity).toBeCloseTo(0.4);
    expect(half.speed).toBe(2);
  });

  it("passe d'une heure à l'absence d'heure par la lumière neutre, et les filtres par leur neutre", () => {
    const from = frameOf(stateWith((s) => (s.looks[0].time = { ...s.looks[0].time, enabled: true, hour: 23 })), new Set());
    const to = frameOf(
      stateWith((s) => (s.looks[0].filters = s.looks[0].filters.map((f) => (f.kind === "brightness" ? { ...f, enabled: true, amount: 1 } : f)))),
      new Set(),
    );
    const near = blendFrames(from, to, 0.999).looks[0];
    expect(near.light!.bright).toBeCloseTo(NEUTRAL_LIGHT.bright, 2);
    expect(blendFrames(from, to, 0).looks[0].filters.brightness).toBeCloseTo(0.5);
    expect(blendFrames(from, to, 1).looks[0].light).toBeNull();
  });

  it("retire la scène d'une zone au rythme où la zone prend son ambiance, en un seul effet", () => {
    const zone = { id: "z", name: "", color: "#ff0000", feather: 0, shapes: [{ t: "r", x: 0, y: 0, w: 10, h: 10 }] } as never;
    const looks = [
      { zone: SCENE_ZONE, weight: 1, light: null, filters: { sepia: 0.5 } },
      { zone: "z", weight: 0.25, light: null, filters: { grayscale: 1 } },
    ];
    const heat = frameOf(stateWith((s) => s.weather.push(defaultEffect("heat", "z", "h"))), new Set(["z"])).weather;
    const wanted = wantedPost({ weather: heat, looks }, [zone], "high", 150);
    expect(wanted).toHaveLength(1);
    const [post] = wanted;
    expect(post.sksl).toContain("l0_weight * (1.0 - max(0.0, zm0(p) * l1_weight))");
    expect(post.uniforms.find((u) => u.name === "l1_weight")!.value).toBe(0.25);
    expect(post.uniforms.find((u) => u.name === "h0_density")!.value).toBe(0.5);
    expect(wantedPost(EMPTY_FRAME, [zone], "high", 150)).toEqual([]);
  });
});

describe("transition dans l'état", () => {
  it("garde la durée et l'identifiant, bornés", () => {
    const state = parseState({ ...defaultState(), transition: 99, smooth: "abc" });
    expect(state.transition).toBe(30);
    expect(state.smooth).toBe("abc");
    expect(parseState({ v: 1 }).transition).toBe(3);
  });
});
