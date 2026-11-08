// Surimpression des zones pour le MJ, pendant que l'outil de peinture est actif : chaque zone
// dans sa couleur, celle qu'il peint plus marquée. Les joueurs ne la voient jamais.

import { PLUGIN_ID } from "../state";
import { zoneStrokes, type Zone } from "../zones";
import { maskFunction } from "./mask";
import { maskOverlaySksl } from "./shaders";
import { rgb } from "./frame";
import type { WantedEffect } from "./sync";

const SELECTED = 0.42;
const OTHERS = 0.16;

export function wantedOverlay(zones: Zone[], selected: string | null, visible: boolean, unit: number): WantedEffect[] {
  if (!visible) return [];
  return zones
    .filter((zone) => zone.shapes.length)
    .map((zone) => ({
      id: `${PLUGIN_ID}/surimpression/${zone.id}`,
      sksl: maskOverlaySksl(maskFunction("mask", zoneStrokes(zone), zone.feather * unit)),
      // Au-dessus de tout : le MJ voit sa zone même sous le brouillard.
      layer: "CONTROL" as const,
      uniforms: [
        { name: "tint", value: rgb(zone.color) },
        { name: "strength", value: zone.id === selected ? SELECTED : OTHERS },
      ],
    }));
}
