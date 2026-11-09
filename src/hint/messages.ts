// Aide des outils, affichée dans leur palette : gestes du mode actif, et messages brefs envoyés
// par la page de fond (« trace dans une coulée », « largeur : 3 cases ») à la place des alertes
// d'Owlbear. Ce fichier ne dépend pas d'Owlbear.

import { t } from "../i18n";
import { keyNames } from "../keys";
import { PLUGIN_ID } from "../state";

export const HINT_CHANNEL = `${PLUGIN_ID}/aide`;

export type HintTone = "info" | "warning";
export type FlashMessage = { type: "flash"; text: string; tone: HintTone };

export type HintItem = { gesture: string; action: string } | { text: string };

/**
 * Texte d'aide → éléments. Les éléments sont séparés par « | » ; « geste = action » met le geste
 * en valeur, sinon c'est une phrase.
 */
export function parseHint(hint: string): HintItem[] {
  return hint
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return at > 0 ? { gesture: part.slice(0, at).trim(), action: part.slice(at + 1).trim() } : { text: part };
    });
}

const ZONES = `${PLUGIN_ID}/zones/`;
const FLUIDS = `${PLUGIN_ID}/fluides/`;
const FLUID_HINTS = ["trace", "rock", "hide", "hideBrush", "source", "direction", "erase"] as const;

/** Gestes d'un mode d'outil, d'après son identifiant ; null s'il n'y a rien à rappeler. */
export function modeHint(modeId: string | undefined): string | null {
  if (!modeId) return null;
  if (modeId.endsWith("/sommets")) return t("vertices.hint", keyNames());
  if (modeId === `${ZONES}polygon`) return t("tool.hint.polygon", keyNames());
  const fluidMode = FLUID_HINTS.find((mode) => modeId === `${FLUIDS}${mode}`);
  return fluidMode ? t(`fluid.hint.${fluidMode}`, keyNames()) : null;
}
