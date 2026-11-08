// Après-rendu : brumes de chaleur, heure du jour et filtres, en un seul effet pour toute la scène
// (voir postSksl). L'ambiance de la scène s'arrête là où une zone a la sienne : les deux ne
// s'empilent pas. Pendant une transition, la scène se retire d'une zone au rythme où l'ambiance
// de la zone y apparaît (et l'inverse).

import { PARTICLE_FACTOR, type Quality } from "../local";
import { FILTER_KINDS, PLUGIN_ID, SCENE_ZONE } from "../state";
import { zoneStrokes, type Zone } from "../zones";
import { NEUTRAL_LIGHT, type Frame } from "./frame";
import { maskFunction } from "./mask";
import { HEAT_UNIFORMS, postSksl, type PostHeat, type PostLook } from "./shaders";
import type { WantedEffect } from "./sync";

export const POST_ID = `${PLUGIN_ID}/apres-rendu`;

export function wantedPost(frame: Frame, zones: Zone[], quality: Quality, unit: number): WantedEffect[] {
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  const exists = (zone: string) => zone === SCENE_ZONE || byId.has(zone);
  const heats = frame.weather.filter((effect) => effect.kind === "heat" && exists(effect.zone));
  const looks = frame.looks.filter((look) => exists(look.zone));
  if (!heats.length && !looks.length) return [];

  // Un masque par zone utilisée, partagé par tout ce qui la vise.
  const used = [...new Set([...heats.map((heat) => heat.zone), ...looks.map((look) => look.zone)])].filter((zone) => zone !== SCENE_ZONE);
  const maskName = new Map(used.map((zone, index) => [zone, `zm${index}`]));
  const zoneMasks = used.map((id) => {
    const zone = byId.get(id)!;
    return maskFunction(maskName.get(id)!, zoneStrokes(zone), zone.feather * unit);
  });
  const maskOf = (zone: string) => (zone === SCENE_ZONE ? "1.0" : `${maskName.get(zone)}(coord)`);

  const lookPrefix = new Map(looks.map((look, index) => [look.zone, `l${index}_`]));
  const zoned = looks.filter((look) => look.zone !== SCENE_ZONE);
  const postLooks: PostLook[] = looks.map((look) => {
    const prefix = lookPrefix.get(look.zone)!;
    // La scène, sauf les zones qui ont leur propre ambiance, à proportion de leur présence.
    const body =
      look.zone === SCENE_ZONE
        ? `${prefix}weight * (1.0 - ${zoned.map((other) => `${maskName.get(other.zone)}(p) * ${lookPrefix.get(other.zone)}weight`).reduce((a, b) => `max(${a}, ${b})`, "0.0")})`
        : `${prefix}weight * ${maskName.get(look.zone)}(p)`;
    return {
      prefix,
      mask: `float ${prefix}mask(vec2 p) { return ${body}; }`,
      time: look.light !== null,
      filters: FILTER_KINDS.filter((kind) => kind in look.filters),
    };
  });
  const postHeats: PostHeat[] = heats.map((heat, index) => ({ prefix: `h${index}_`, mask: maskOf(heat.zone) }));

  return [
    {
      id: POST_ID,
      sksl: postSksl(zoneMasks.join("\n"), postHeats, postLooks),
      layer: "POST_PROCESS",
      uniforms: [
        { name: "unit", value: unit },
        ...heats.flatMap((heat, index) => {
          const values: Record<(typeof HEAT_UNIFORMS)[number], number> = {
            angle: heat.direction,
            speed: heat.speed,
            density: heat.intensity * PARTICLE_FACTOR[quality],
            drops: heat.scale,
            opacity: heat.opacity,
            turbulence: heat.turbulence,
            gusts: heat.gusts,
            patches: heat.patches,
          };
          return HEAT_UNIFORMS.map((name) => ({ name: `h${index}_${name}`, value: values[name] }));
        }),
        ...looks.flatMap((look, index) => {
          const prefix = postLooks[index].prefix;
          const light = look.light ?? NEUTRAL_LIGHT;
          return [
            { name: `${prefix}weight`, value: look.weight },
            { name: `${prefix}tint`, value: light.tint },
            { name: `${prefix}bright`, value: light.bright },
            { name: `${prefix}sat`, value: light.sat },
            { name: `${prefix}contr`, value: light.contr },
            ...postLooks[index].filters.map((kind) => ({ name: `${prefix}f_${kind}`, value: look.filters[kind]! })),
          ];
        }),
      ],
    },
  ];
}
