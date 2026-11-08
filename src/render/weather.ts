// Météo : un effet par effet de l'image en cours, dans sa zone. Les particules sont calculées dans
// le shader à partir de l'horloge d'Owlbear : aucun objet par goutte, aucun message par image.

import { PARTICLE_FACTOR, RAIN_LAYERS, type Quality } from "../local";
import { PLUGIN_ID, SCENE_ZONE, optionsOf, type WeatherKind } from "../state";
import { zoneStrokes, type Zone } from "../zones";
import type { WeatherFrame } from "./frame";
import { maskFunction } from "./mask";
import { weatherSksl } from "./shaders";
import type { WantedEffect } from "./sync";

/** Météos de lumière : elles éclaircissent la carte au lieu de la recouvrir. */
const LIGHT_KINDS = new Set<WeatherKind>(["sunrays"]);

export function wantedWeather(weather: WeatherFrame[], zones: Zone[], quality: Quality, unit: number, cartoon = false): WantedEffect[] {
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  return weather.flatMap((effect) => {
    // La brume de chaleur déforme l'image : elle est dans l'après-rendu (voir post.ts).
    if (effect.kind === "heat") return [];
    const zone = effect.zone === SCENE_ZONE ? null : byId.get(effect.zone);
    // Zone supprimée : son effet attend d'être retiré.
    if (effect.zone !== SCENE_ZONE && !zone) return [];
    const mask = maskFunction("mask", zone ? zoneStrokes(zone) : null, (zone?.feather ?? 0) * unit);
    return [
      {
        id: `${PLUGIN_ID}/meteo/${effect.id}`,
        sksl: weatherSksl(effect.kind, mask, cartoon),
        layer: "RULER" as const,
        blend: LIGHT_KINDS.has(effect.kind) ? ("SCREEN" as const) : undefined,
        uniforms: [
          { name: "unit", value: unit },
          { name: "angle", value: effect.direction },
          { name: "speed", value: effect.speed },
          { name: "density", value: effect.intensity * PARTICLE_FACTOR[quality] },
          { name: "drops", value: effect.scale },
          { name: "opacity", value: effect.opacity },
          { name: "layers", value: RAIN_LAYERS[quality] },
          { name: "tint", value: effect.tint },
          { name: "turbulence", value: effect.turbulence },
          { name: "gusts", value: effect.gusts },
          { name: "variety", value: effect.variety },
          { name: "patches", value: effect.patches },
          ...optionsOf(effect.kind).map((key) => ({ name: `o_${key}`, value: effect.options[key] ?? 0 })),
        ],
      },
    ];
  });
}
