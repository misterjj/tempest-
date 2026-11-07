// Surimpression des zones pour le MJ, pendant que l'outil de peinture est actif : chaque zone
// dans sa couleur, celle qu'il peint plus marquée. Les joueurs ne la voient jamais.

import OBR, { buildEffect, isEffect } from "@owlbear-rodeo/sdk";
import { PLUGIN_ID } from "../state";
import { zoneStrokes, type Zone } from "../zones";
import { maskSksl } from "./mask";
import { maskOverlaySksl } from "./shaders";

const PREFIX = `${PLUGIN_ID}/surimpression/`;
const SELECTED = 0.42;
const OTHERS = 0.16;

/** Shader posé par zone : on ne recompile que si la zone a changé. */
const placed = new Map<string, string>();

export const forgetOverlay = () => placed.clear();

function rgb(color: string) {
  const value = Number.parseInt(color.slice(1), 16);
  return { x: ((value >> 16) & 255) / 255, y: ((value >> 8) & 255) / 255, z: (value & 255) / 255 };
}

export async function syncOverlay(zones: Zone[], selected: string | null, visible: boolean) {
  const unit = await OBR.scene.grid.getDpi();
  const wanted = visible ? zones.filter((zone) => zone.shapes.length) : [];
  const sksl = new Map(wanted.map((zone) => [PREFIX + zone.id, maskOverlaySksl(maskSksl(zoneStrokes(zone), zone.feather * unit))]));

  const changed = [...placed.keys()].filter((id) => sksl.get(id) !== placed.get(id));
  if (changed.length) await OBR.scene.local.deleteItems(changed);
  changed.forEach((id) => placed.delete(id));

  const add = wanted
    .filter((zone) => !placed.has(PREFIX + zone.id))
    .map((zone) =>
      buildEffect()
        .id(PREFIX + zone.id)
        .effectType("VIEWPORT")
        .sksl(sksl.get(PREFIX + zone.id)!)
        .position({ x: 0, y: 0 })
        .uniforms([
          { name: "tint", value: rgb(zone.color) },
          { name: "strength", value: zone.id === selected ? SELECTED : OTHERS },
        ])
        .blendMode("SRC_OVER")
        // Au-dessus de tout : le MJ voit sa zone même sous le brouillard.
        .layer("CONTROL")
        .locked(true)
        .disableHit(true)
        .build(),
    );
  if (add.length) await OBR.scene.local.addItems(add);
  add.forEach((item) => placed.set(item.id, sksl.get(item.id)!));

  // Zone choisie ou couleur changée : seuls les réglages bougent, sans recompiler.
  const kept = wanted.filter((zone) => !add.some((item) => item.id === PREFIX + zone.id));
  if (kept.length) {
    const byId = new Map(kept.map((zone) => [PREFIX + zone.id, zone]));
    await OBR.scene.local.updateItems([...byId.keys()], (items) => {
      for (const item of items) {
        const zone = byId.get(item.id);
        if (!zone || !isEffect(item)) continue;
        item.uniforms = [
          { name: "tint", value: rgb(zone.color) },
          { name: "strength", value: zone.id === selected ? SELECTED : OTHERS },
        ];
      }
    });
  }
}
