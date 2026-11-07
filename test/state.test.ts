import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "../src/i18n";
import {
  MAX_EFFECTS_PER_TARGET,
  MAX_STATE_BYTES,
  WEATHER_KINDS,
  defaultEffect,
  defaultState,
  parseState,
  stateBytes,
} from "../src/state";

describe("état de la scène", () => {
  it("revient à l'état par défaut si rien n'est stocké, ou une autre version", () => {
    expect(parseState(undefined)).toEqual(defaultState());
    expect(parseState({ v: 99, paused: true })).toEqual(defaultState());
  });

  it("ramène les valeurs dans leurs bornes et ignore ce qui est inconnu", () => {
    const state = parseState({
      v: 1,
      weather: [
        { id: "a", kind: "rain", target: { kind: "item", id: "carte" }, direction: 720, wind: -3, intensity: 2, scale: 10, color: "#FF0000", opacity: 0.4 },
        { id: "b", kind: "laser" },
      ],
      time: { enabled: true, hour: 30, colors: { night: "#112233", dawn: "rouge" } },
      filters: [{ kind: "sepia", enabled: true, amount: 0.8 }, { kind: "inconnu", enabled: true }],
    });
    expect(state.weather).toEqual([
      { id: "a", kind: "rain", target: { kind: "item", id: "carte" }, direction: 359, wind: 0, intensity: 1, scale: 4, color: "#ff0000", opacity: 0.4 },
    ]);
    expect(state.time.hour).toBe(24);
    expect(state.time.colors.night).toBe("#112233");
    expect(state.time.colors.dawn).toBe(defaultState().time.colors.dawn);
    expect(state.filters.find((filter) => filter.kind === "sepia")).toEqual({ kind: "sepia", enabled: true, amount: 0.8 });
  });

  it(`garde au plus ${MAX_EFFECTS_PER_TARGET} effets par cible`, () => {
    const weather = Array.from({ length: 6 }, (_, index) => defaultEffect("rain", { kind: "scene" }, `e${index}`));
    expect(parseState({ v: 1, weather }).weather).toHaveLength(MAX_EFFECTS_PER_TARGET);
  });

  it("reste sous 4 Ko avec 4 effets sur 3 cibles, l'heure et tous les filtres", () => {
    const state = defaultState();
    for (const target of [{ kind: "scene" } as const, { kind: "item", id: "x".repeat(21) } as const, { kind: "item", id: "y".repeat(21) } as const]) {
      for (const kind of WEATHER_KINDS.slice(0, 4)) state.weather.push({ ...defaultEffect(kind, target), color: "#aabbcc" });
    }
    state.time.enabled = true;
    state.filters.forEach((filter) => (filter.enabled = true));
    expect(stateBytes(state)).toBeLessThan(MAX_STATE_BYTES);
  });
});

describe("traductions", () => {
  it("ont les mêmes textes en français et en anglais", () => {
    expect(Object.keys(DICTIONARIES.en).sort()).toEqual(Object.keys(DICTIONARIES.fr).sort());
  });
});
