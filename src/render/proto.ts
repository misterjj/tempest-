// PROTOTYPE de rendu : pluie et nuit, sur toute la scène ou dans une zone peinte de test.
// Sert à mesurer, dans Owlbear, le coût d'un masque de N traits et de l'après-rendu.
// Les réglages passent par la scène : chaque client (iPad compris) dessine la même chose.

import OBR, { buildEffect, type Item } from "@owlbear-rodeo/sdk";
import { PARTICLE_FACTOR, RAIN_LAYERS, type Quality } from "../local";
import { PLUGIN_ID } from "../state";
import { maskSksl, type Stroke } from "./mask";
import { gradeSksl, maskOverlaySksl, rainSksl } from "./shaders";

export const PROTO_KEY = `${PLUGIN_ID}/prototype`;

export type ProtoTarget = "off" | "scene" | "zone";

export interface Proto {
  rain: ProtoTarget;
  night: ProtoTarget;
  /** Nombre de segments de pinceau du masque de test */
  strokes: number;
  /** Fondu au bord, en cases */
  feather: number;
  showMask: boolean;
  center: { x: number; y: number };
}

export const DEFAULT_PROTO: Proto = { rain: "off", night: "off", strokes: 60, feather: 1, showMask: false, center: { x: 0, y: 0 } };

export function parseProto(value: unknown): Proto {
  const raw = (typeof value === "object" && value ? value : {}) as Partial<Proto>;
  const target = (t: unknown): ProtoTarget => (t === "scene" || t === "zone" ? t : "off");
  return {
    rain: target(raw.rain),
    night: target(raw.night),
    strokes: Math.min(1000, Math.max(1, Number(raw.strokes) || DEFAULT_PROTO.strokes)),
    feather: Number.isFinite(Number(raw.feather)) ? Math.min(5, Math.max(0, Number(raw.feather))) : DEFAULT_PROTO.feather,
    showMask: raw.showMask === true,
    center: raw.center && Number.isFinite(raw.center.x) && Number.isFinite(raw.center.y) ? raw.center : DEFAULT_PROTO.center,
  };
}

/**
 * Masque de test : une spirale au pinceau de `count` segments, un rectangle, un cercle,
 * et un coup de gomme au centre. Comme un MJ qui aurait peint une zone tortueuse.
 */
export function testStrokes(count: number, center: { x: number; y: number }, unit: number): Stroke[] {
  const strokes: Stroke[] = [];
  let previous = { x: center.x + unit * 1.5, y: center.y };
  for (let i = 1; i <= count; i++) {
    const turn = (i / count) * Math.PI * 6;
    const radius = unit * (1.5 + (6 * i) / count);
    const next = { x: center.x + Math.cos(turn) * radius, y: center.y + Math.sin(turn) * radius };
    strokes.push({ k: "line", x1: previous.x, y1: previous.y, x2: next.x, y2: next.y, r: unit * 0.7 });
    previous = next;
  }
  strokes.push({ k: "rect", x: center.x + unit * 8, y: center.y - unit * 3, w: unit * 5, h: unit * 6 });
  strokes.push({ k: "circle", x: center.x - unit * 10, y: center.y, r: unit * 2.5 });
  strokes.push({ k: "circle", x: center.x, y: center.y, r: unit * 1.2, erase: true });
  return strokes;
}

const ID = { rain: `${PLUGIN_ID}/proto/pluie`, night: `${PLUGIN_ID}/proto/nuit`, mask: `${PLUGIN_ID}/proto/masque` };
/** Code du shader actuellement posé, par effet : on ne recompile que s'il change. */
const placed = new Map<string, string>();

const effect = (id: string, sksl: string, layer: "RULER" | "POST_PROCESS" | "CONTROL", uniforms: { name: string; value: number | { x: number; y: number; z: number } }[]) =>
  buildEffect()
    .id(id)
    .effectType("VIEWPORT")
    .sksl(sksl)
    .position({ x: 0, y: 0 })
    .uniforms(uniforms)
    .blendMode("SRC_OVER")
    .layer(layer)
    .locked(true)
    .disableHit(true)
    .build();

/** La scène a changé ou s'est rechargée : ses objets locaux ont disparu avec elle. */
export function forgetProto() {
  placed.clear();
}

export async function syncProto(proto: Proto, isGM: boolean, quality: Quality, enabled: boolean) {
  const unit = await OBR.scene.grid.getDpi();
  const zone = testStrokes(proto.strokes, proto.center, unit);
  const feather = proto.feather * unit;
  const wanted: Item[] = [];
  if (enabled && proto.rain !== "off") {
    wanted.push(
      effect(ID.rain, rainSksl(maskSksl(proto.rain === "zone" ? zone : null, feather)), "RULER", [
        { name: "unit", value: unit },
        { name: "angle", value: 180 },
        { name: "wind", value: 3 },
        { name: "density", value: 0.5 * PARTICLE_FACTOR[quality] },
        { name: "layers", value: RAIN_LAYERS[quality] },
        { name: "drops", value: 1 },
        { name: "opacity", value: 1 },
        { name: "tint", value: { x: 0.78, y: 0.85, z: 0.98 } },
      ]),
    );
  }
  if (enabled && proto.night !== "off") {
    wanted.push(
      effect(ID.night, gradeSksl(maskSksl(proto.night === "zone" ? zone : null, feather)), "POST_PROCESS", [
        { name: "tint", value: { x: 0.45, y: 0.55, z: 1 } },
        { name: "strength", value: 1 },
      ]),
    );
  }
  if (isGM && proto.showMask) {
    wanted.push(effect(ID.mask, maskOverlaySksl(maskSksl(zone, feather)), "CONTROL", [{ name: "tint", value: { x: 0.3, y: 0.6, z: 1 } }, { name: "strength", value: 0.35 }]));
  }

  // Un effet dont le shader change est retiré puis reposé ; les autres restent en place.
  const keep = new Set(wanted.filter((item) => placed.get(item.id) === (item as Item & { sksl: string }).sksl).map((item) => item.id));
  const remove = [...placed.keys()].filter((id) => !keep.has(id));
  if (remove.length) await OBR.scene.local.deleteItems(remove);
  remove.forEach((id) => placed.delete(id));
  const add = wanted.filter((item) => !keep.has(item.id));
  if (add.length) {
    const started = performance.now();
    await OBR.scene.local.addItems(add);
    console.info(`[Tempest!] ${add.map((item) => item.id.split("/").pop()).join(", ")} posé(s) en ${Math.round(performance.now() - started)} ms (masque de ${zone.length} formes)`);
  }
  add.forEach((item) => placed.set(item.id, (item as Item & { sksl: string }).sksl));
}
