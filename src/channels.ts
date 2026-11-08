// Canaux de messages entre les pages de l'extension. Fichier sans effet de bord : l'importer ne
// lance rien (importer background.ts depuis une autre page y relancerait toute la page de fond).

import { PLUGIN_ID } from "./state";

export const PANEL_CHANNEL = `${PLUGIN_ID}/panel`;
/** Message au panneau : ouvrir l'onglet Météo sur cette zone. */
export type PanelMessage = { type: "zone"; zoneId: string };

/** Effets ponctuels, envoyés par le MJ à tous les joueurs (lui compris). */
export const BURST_CHANNEL = `${PLUGIN_ID}/effet-ponctuel`;
export const BURST_KINDS = ["lightning", "gust", "quake"] as const;
export type BurstKind = (typeof BURST_KINDS)[number];
export type BurstMessage = { kind: BurstKind };
