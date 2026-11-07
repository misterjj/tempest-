import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "../src/i18n";
import {
  HARD_EFFECTS_PER_ZONE,
  MAX_STATE_BYTES,
  TooManyEffectsError,
  addEffect,
  SCENE_ZONE,
  WEATHER_KINDS,
  defaultEffect,
  defaultLook,
  defaultState,
  forgetZone,
  lookOf,
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
        { id: "a", kind: "rain", zone: "z1", enabled: false, direction: 720, speed: 9, intensity: 2, scale: 10, color: "#FF0000", opacity: 0.4 },
        { id: "b", kind: "laser" },
      ],
      looks: [
        { zone: "z1", time: { enabled: true, hour: 30 }, filters: [{ kind: "sepia", enabled: true, amount: 0.8 }, { kind: "inconnu" }] },
      ],
    });
    expect(state.weather).toEqual([
      {
        id: "a", kind: "rain", zone: "z1", enabled: false, direction: 359, speed: 3, intensity: 1, scale: 4, color: "#ff0000", opacity: 0.4,
        turbulence: 0.15, gusts: 0.25, variety: 0.3, patches: 0.2, options: { splashes: 0, lightning: 0, veil: 0 },
      },
    ]);
    // L'ambiance de la scène est toujours là, en premier.
    expect(state.looks.map((look) => look.zone)).toEqual([SCENE_ZONE, "z1"]);
    expect(state.looks[1].time.hour).toBe(24);
    expect(state.looks[1].filters.find((filter) => filter.kind === "sepia")).toEqual({ kind: "sepia", enabled: true, amount: 0.8 });
  });

  it("ne coupe à la lecture qu'au-delà de la plus haute limite réglable", () => {
    const weather = Array.from({ length: HARD_EFFECTS_PER_ZONE + 3 }, (_, index) => defaultEffect("rain", SCENE_ZONE, `e${index}`));
    expect(parseState({ v: 1, weather }).weather).toHaveLength(HARD_EFFECTS_PER_ZONE);
  });

  it("refuse un effet de plus que la limite de la salle dans une zone", () => {
    const state = defaultState();
    addEffect(state, defaultEffect("rain"), 2);
    addEffect(state, defaultEffect("fog"), 2);
    addEffect(state, defaultEffect("snow", "z1"), 2);
    expect(() => addEffect(state, defaultEffect("sand"), 2)).toThrow(TooManyEffectsError);
  });

  it("prend les réglages de la scène pour une zone qui n'a pas les siens", () => {
    const state = defaultState();
    state.looks.push({ ...defaultLook("z1"), time: { ...defaultLook().time, hour: 22 } });
    expect(lookOf(state, "z1").time.hour).toBe(22);
    expect(lookOf(state, "z2")).toBe(state.looks[0]);
  });

  it("oublie les effets et réglages d'une zone supprimée", () => {
    const state = defaultState();
    state.weather.push(defaultEffect("rain", "z1"), defaultEffect("fog"));
    state.looks.push(defaultLook("z1"));
    forgetZone(state, "z1");
    expect(state.weather.map((effect) => effect.zone)).toEqual([SCENE_ZONE]);
    expect(state.looks.map((look) => look.zone)).toEqual([SCENE_ZONE]);
  });

  it("reste sous le garde-fou avec les limites au maximum (40 zones de 12 effets)", () => {
    const state = defaultState();
    for (let z = 0; z <= 40; z++) {
      const zone = z ? crypto.randomUUID() : SCENE_ZONE;
      for (let e = 0; e < HARD_EFFECTS_PER_ZONE; e++) state.weather.push({ ...defaultEffect(WEATHER_KINDS[e % WEATHER_KINDS.length], zone), color: "#aabbcc" });
      if (z) state.looks.push(defaultLook(zone));
    }
    console.info(`réglages au maximum : ${stateBytes(state)} octets`);
    expect(stateBytes(state)).toBeLessThan(MAX_STATE_BYTES);
  });
});

describe("traductions", () => {
  it("ont les mêmes textes en français et en anglais", () => {
    expect(Object.keys(DICTIONARIES.en).sort()).toEqual(Object.keys(DICTIONARIES.fr).sort());
  });
});

describe("options des météos", () => {
  it("ne garde que les options du type, bornées", () => {
    const state = parseState({
      v: 1,
      weather: [
        { id: "a", kind: "embers", options: { crackle: 2, glow: 0.3, splashes: 1 } },
        { id: "b", kind: "sunrays" },
      ],
    });
    expect(state.weather[0].options).toEqual({ crackle: 1, glow: 0.3 });
    expect(state.weather[1].options).toEqual({ motes: 0.4 });
  });
});
