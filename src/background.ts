// Page de fond : dessine les effets chez chaque client, et ajoute l'outil et le menu du MJ.

import OBR from "@owlbear-rodeo/sdk";
import { t } from "./i18n";
import { startRenderer } from "./render";
import { readLimits, updateZones } from "./scene-state";
import { PANEL_CHANNEL, type PanelMessage } from "./channels";
import { PLUGIN_ID } from "./state";
import { setupTool } from "./tool/tool";
import { TooManyZonesError, addZone, newZone } from "./zones";

/** Zone rectangulaire de la taille d'une carte : plus simple que de la peindre. */
async function zoneFromMap(itemId: string, name: string) {
  const [bounds, limits] = await Promise.all([OBR.scene.items.getItemBounds([itemId]), readLimits()]);
  let created = "";
  await updateZones((data) => {
    const zone = newZone(name || t("tool.defaultName", { n: data.zones.length + 1 }), data.zones);
    zone.feather = 0;
    zone.shapes.push({ t: "r", x: Math.round(bounds.min.x), y: Math.round(bounds.min.y), w: Math.round(bounds.width), h: Math.round(bounds.height) });
    addZone(data, zone, limits);
    created = zone.id;
  });
  return created;
}

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
        filter: { roles: ["GM"], max: 1, every: [{ key: "layer", value: "MAP" }] },
      },
    ],
    async onClick(context) {
      const [item] = context.items;
      if (!item) return;
      try {
        const zoneId = await zoneFromMap(item.id, item.name);
        await OBR.player.deselect();
        await OBR.action.open();
        const message: PanelMessage = { type: "zone", zoneId };
        // Le panneau vient peut-être de s'ouvrir : on lui laisse le temps d'écouter.
        setTimeout(() => OBR.broadcast.sendMessage(PANEL_CHANNEL, message, { destination: "LOCAL" }), 400);
      } catch (error) {
        if (error instanceof TooManyZonesError) OBR.notification.show(t("tool.tooManyZones", { limit: (await readLimits()).zones }), "WARNING");
        else console.error("[Tempest!]", error);
      }
    },
  });
});
