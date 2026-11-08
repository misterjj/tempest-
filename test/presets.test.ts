import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, applyPreset, capturePreset, parseCustomPresets, restoreZone, snapshotZone } from "../src/presets";
import { DICTIONARIES } from "../src/i18n";
import { SCENE_ZONE, defaultEffect, defaultLook, defaultState, parseState } from "../src/state";

const preset = (id: string) => BUILTIN_PRESETS.find((candidate) => candidate.id === id)!;

describe("ambiances", () => {
  it("ont toutes un nom dans chaque langue, et des données valides", () => {
    for (const candidate of BUILTIN_PRESETS) {
      for (const dictionary of Object.values(DICTIONARIES)) expect((dictionary as Record<string, string>)[`preset.${candidate.id}`]).toBeTruthy();
      // Relues comme un état de scène, elles ne perdent rien.
      const state = defaultState();
      applyPreset(state, SCENE_ZONE, candidate, 12);
      expect(parseState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    }
  });

  it("remplacent la météo, l'heure et les filtres de la zone, et seulement d'elle", () => {
    const state = defaultState();
    state.weather.push(defaultEffect("snow", SCENE_ZONE), defaultEffect("fog", "z1"));
    applyPreset(state, SCENE_ZONE, preset("stormNight"), 6);
    expect(state.weather.filter((effect) => effect.zone === SCENE_ZONE).map((effect) => effect.kind)).toEqual(["rain", "wind", "clouds"]);
    expect(state.weather.filter((effect) => effect.zone === "z1").map((effect) => effect.kind)).toEqual(["fog"]);
    expect(state.looks[0]).toMatchObject({ zone: SCENE_ZONE, time: { enabled: true, hour: 23 } });
    // Chaque application crée de nouveaux effets.
    const ids = state.weather.map((effect) => effect.id);
    applyPreset(state, SCENE_ZONE, preset("stormNight"), 6);
    expect(state.weather.some((effect) => effect.zone === SCENE_ZONE && ids.includes(effect.id))).toBe(false);
  });

  it("laissent une zone suivre la scène quand elles ne touchent ni à l'heure ni aux filtres", () => {
    const state = defaultState();
    state.looks.push({ ...defaultLook("z1"), time: { ...defaultLook().time, enabled: true } });
    applyPreset(state, "z1", { id: "x", weather: [defaultEffect("rain")], look: defaultLook() }, 6);
    expect(state.looks.map((look) => look.zone)).toEqual([SCENE_ZONE]);
    applyPreset(state, "z1", preset("memory"), 6);
    expect(state.looks.map((look) => look.zone)).toEqual([SCENE_ZONE, "z1"]);
  });

  it("respectent la limite d'effets par zone", () => {
    const state = defaultState();
    expect(applyPreset(state, SCENE_ZONE, preset("blizzard"), 2)).toBe(1);
    expect(state.weather).toHaveLength(2);
  });

  it("s'annulent : la zone retrouve exactement son état", () => {
    const state = defaultState();
    state.weather.push(defaultEffect("snow", "z1"));
    const before = structuredClone(state);
    const snapshot = snapshotZone(state, "z1");
    applyPreset(state, "z1", preset("forge"), 6);
    restoreZone(state, snapshot);
    expect(state).toEqual(before);
  });

  it("du MJ : capturées puis relues depuis le navigateur", () => {
    const state = defaultState();
    state.weather.push(defaultEffect("leaves", "z1"));
    const saved = capturePreset(state, "z1", "  Ma forêt  ");
    expect(saved.name).toBe("Ma forêt");
    expect(saved.weather[0].zone).toBe(SCENE_ZONE);
    expect(parseCustomPresets(JSON.stringify([saved, { id: 3 }, "x"]))).toEqual([saved]);
    expect(parseCustomPresets("pas du json")).toEqual([]);
    expect(parseCustomPresets(null)).toEqual([]);
  });
});
