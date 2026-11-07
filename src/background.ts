// Page de fond : dessine les effets chez chaque client et ajoute le menu contextuel du MJ.

import OBR from "@owlbear-rodeo/sdk";
import { t } from "./i18n";
import { startRenderer } from "./render";
import { PLUGIN_ID } from "./state";
import { setupTool } from "./tool/tool";

export const PANEL_CHANNEL = `${PLUGIN_ID}/panel`;
/** Message au panneau : ouvrir l'onglet Météo avec cette cible. */
export type PanelMessage = { type: "target"; itemId: string };

OBR.onReady(async () => {
  // L'outil se crée pour tous, mais ses icônes ne s'affichent que pour le MJ.
  setupTool();
  await startRenderer();
  OBR.contextMenu.create({
    id: `${PLUGIN_ID}/ajouter-meteo`,
    icons: [
      {
        icon: "/icon.svg",
        label: t("menu.addWeather"),
        filter: {
          roles: ["GM"],
          max: 1,
          every: [{ key: "layer", value: "MAP", coordinator: "||" }, { key: "type", value: "SHAPE" }],
        },
      },
    ],
    async onClick(context) {
      const [item] = context.items;
      if (!item) return;
      await OBR.player.deselect();
      await OBR.action.open();
      const message: PanelMessage = { type: "target", itemId: item.id };
      // Le panneau vient peut-être de s'ouvrir : on lui laisse le temps d'écouter.
      setTimeout(() => OBR.broadcast.sendMessage(PANEL_CHANNEL, message, { destination: "LOCAL" }), 300);
    },
  });
});
