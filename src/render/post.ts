// Heure du jour et filtres : un effet d'après-rendu par ambiance active. Celle de la scène
// s'arrête là où une zone a la sienne : les deux ne s'empilent pas.

import { PLUGIN_ID, SCENE_ZONE, type Look, type TempestState } from "../state";
import { zoneStrokes, type Zone } from "../zones";
import { lightAt } from "./daylight";
import { maskFunction } from "./mask";
import { gradeSksl } from "./shaders";
import type { WantedEffect } from "./sync";

const isActive = (look: Look) => look.time.enabled || look.filters.some((filter) => filter.enabled);

export function wantedLooks(state: TempestState, zones: Zone[], unit: number): WantedEffect[] {
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  const zoned = state.looks.filter((look) => look.zone !== SCENE_ZONE && byId.has(look.zone) && isActive(look));
  return state.looks.filter(isActive).flatMap((look) => {
    let mask: string;
    if (look.zone === SCENE_ZONE) {
      // Toute la scène, sauf les zones qui ont leur propre ambiance.
      const parts = zoned.map((other, index) => {
        const zone = byId.get(other.zone)!;
        return maskFunction(`own${index}`, zoneStrokes(zone), zone.feather * unit);
      });
      const union = zoned.map((_, index) => `own${index}(p)`).reduce((a, b) => `max(${a}, ${b})`, "0.0");
      mask = `${parts.join("\n")}\nfloat mask(vec2 p) { return 1.0 - ${union}; }`;
    } else {
      const zone = byId.get(look.zone);
      if (!zone) return [];
      mask = maskFunction("mask", zoneStrokes(zone), zone.feather * unit);
    }
    const filters = look.filters.filter((filter) => filter.enabled);
    const light = lightAt(look.time.hour, look.time.colors);
    return [
      {
        id: `${PLUGIN_ID}/ambiance/${look.zone}`,
        sksl: gradeSksl(mask, look.time.enabled, filters.map((filter) => filter.kind)),
        layer: "POST_PROCESS" as const,
        uniforms: [
          { name: "unit", value: unit },
          { name: "tint", value: light.tint },
          { name: "bright", value: light.bright },
          { name: "sat", value: light.sat },
          { name: "contr", value: light.contr },
          ...filters.map((filter) => ({ name: `f_${filter.kind}`, value: filter.amount })),
        ],
      },
    ];
  });
}
