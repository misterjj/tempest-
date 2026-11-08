// Après-rendu : brumes de chaleur, heure du jour et filtres, en un seul effet pour toute la scène
// (voir postSksl). L'ambiance de la scène s'arrête là où une zone a la sienne : les deux ne
// s'empilent pas. Pendant une transition, la scène se retire d'une zone au rythme où l'ambiance
// de la zone y apparaît (et l'inverse).

import { PARTICLE_FACTOR, type Quality } from "../local";
import { FILTER_KINDS, PLUGIN_ID, SCENE_ZONE, type Lamp } from "../state";
import type { Fluid } from "../fluids";
import { rgb } from "./frame";
import { zoneStrokes, type Zone } from "../zones";
import { NEUTRAL_LIGHT, type Frame } from "./frame";
import { maskFunction } from "./mask";
import { HEAT_UNIFORMS, postSksl, type PostHeat, type PostLook } from "./shaders";
import type { WantedEffect } from "./sync";

export const POST_ID = `${PLUGIN_ID}/apres-rendu`;

/** Lumière placée : sa position vient de l'objet qui la porte. */
export type PlacedLamp = Lamp & { x: number; y: number };

const f = (value: number) => {
  const text = (Math.round(value * 10) / 10).toString();
  return text.includes(".") ? text : `${text}.0`;
};

/**
 * Lueur des coulées de lave : elles éclairent ce qui les entoure (réglage Lueur), et la nuit ne
 * les éteint pas. Code SkSL ajouté à lightAt ; réglages lavaGlow<i> et lavaColor<i>.
 */
function lavaGlowCode(lavas: Fluid[], unit: number) {
  return lavas
    .map((lava, i) => {
      const segments = lava.strokes.flatMap((stroke) => {
        const p = stroke.p.length >= 4 ? stroke.p : [stroke.p[0], stroke.p[1], stroke.p[0] + 1, stroke.p[1]];
        const out: string[] = [];
        for (let k = 2; k < p.length; k += 2) out.push(`d = min(d, capsule(p, vec2(${f(p[k - 2])}, ${f(p[k - 1])}), vec2(${f(p[k])}, ${f(p[k + 1])}), ${f(stroke.r)}));`);
        return out;
      });
      const xs = lava.strokes.flatMap((stroke) => stroke.p.filter((_, k) => k % 2 === 0).flatMap((x) => [x - stroke.r, x + stroke.r]));
      const ys = lava.strokes.flatMap((stroke) => stroke.p.filter((_, k) => k % 2 === 1).flatMap((y) => [y - stroke.r, y + stroke.r]));
      const reach = unit * 3;
      return `  if (lavaGlow${i} > 0.0 && p.x > ${f(Math.min(...xs) - reach)} && p.y > ${f(Math.min(...ys) - reach)} && p.x < ${f(Math.max(...xs) + reach)} && p.y < ${f(Math.max(...ys) + reach)}) {
    float d = 1e5;
    ${segments.join("\n    ")}
    float a = (1.0 - smoothstep(-unit * 0.3, unit * (0.5 + 2.5 * lavaGlow${i}), d)) * (0.55 + 0.45 * lavaGlow${i});
    col += lavaColor${i} * a;
    amount = 1.0 - (1.0 - amount) * (1.0 - a);
  }`;
    })
    .join("\n");
}

/** Effets ponctuels en cours chez ce joueur (voir render/index.ts). */
export interface Bursts {
  flash: number;
  shake: { x: number; y: number };
}

export function wantedPost(
  frame: Frame,
  zones: Zone[],
  quality: Quality,
  unit: number,
  lamps: PlacedLamp[] = [],
  fluids: Fluid[] = [],
  bursts: Bursts | null = null,
): WantedEffect[] {
  const lavas = fluids.filter((fluid) => fluid.kind === "lava" && fluid.enabled && fluid.strokes.length);
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  const exists = (zone: string) => zone === SCENE_ZONE || byId.has(zone);
  const heats = frame.weather.filter((effect) => effect.kind === "heat" && exists(effect.zone));
  const looks = frame.looks.filter((look) => exists(look.zone));
  // Sans ambiance ni chaleur, l'après-rendu n'existe que le temps d'un effet ponctuel.
  const bursting = bursts !== null && (bursts.flash > 0 || bursts.shake.x !== 0 || bursts.shake.y !== 0);
  if (!heats.length && !looks.length && !bursting) return [];

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
      sksl: postSksl(
        zoneMasks.join("\n"),
        postHeats,
        postLooks,
        lamps.length,
        lavas.map((_, i) => `uniform float lavaGlow${i};\nuniform vec3 lavaColor${i};`).join("\n"),
        lavaGlowCode(lavas, unit),
        bursts !== null,
      ),
      layer: "POST_PROCESS",
      uniforms: [
        { name: "unit", value: unit },
        ...(bursts
          ? [
              { name: "flash", value: bursts.flash },
              { name: "shakeX", value: bursts.shake.x },
              { name: "shakeY", value: bursts.shake.y },
            ]
          : []),
        ...lamps.flatMap((lamp, i) => [
          { name: `lamp${i}`, value: { x: lamp.x, y: lamp.y, z: lamp.radius * unit } },
          { name: `lampPower${i}`, value: lamp.intensity },
          { name: `lampColor${i}`, value: rgb(lamp.color) },
          { name: `lampFlicker${i}`, value: lamp.flicker },
        ]),
        ...lavas.flatMap((lava, i) => [
          { name: `lavaGlow${i}`, value: (lava.options.glow ?? 0.6) * lava.opacity },
          { name: `lavaColor${i}`, value: lava.color ? rgb(lava.color) : { x: 1, y: 0.42, z: 0.12 } },
        ]),
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
