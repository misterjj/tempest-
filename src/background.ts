// Page de fond : dessine les effets chez chaque client, et ajoute l'outil et le menu du MJ.

import OBR from "@owlbear-rodeo/sdk";
import { t } from "./i18n";
import { startRenderer } from "./render";
import { readLimits, updateState, updateZones } from "./scene-state";
import { PANEL_CHANNEL, type PanelMessage } from "./channels";
import { LAMP_KEY, PLUGIN_ID, newLamp } from "./state";
import { setupFluidTool } from "./tool/fluid-tool";
import { setupLampTool } from "./tool/lamp-tool";
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

/** Lumières : une torche sur chaque objet choisi, ou les retire. */
function setupLampMenu() {
  OBR.contextMenu.create({
    id: `${PLUGIN_ID}/ajouter-lumiere`,
    icons: [
      {
        icon: "/lumiere.svg",
        label: t("lamp.add"),
        filter: {
          roles: ["GM"],
          every: [
            { key: "layer", value: "MAP", operator: "!=" },
            { key: ["metadata", LAMP_KEY], value: undefined },
          ],
        },
      },
    ],
    async onClick(context) {
      const ids = context.items.map((item) => item.id);
      let added: string[] = [];
      const { lamps: limit } = await readLimits();
      await updateState((state) => {
        const room = limit - state.lamps.length;
        added = ids.slice(0, Math.max(0, room));
        state.lamps.push(...added.map((id) => newLamp(id)));
      });
      if (added.length < ids.length) OBR.notification.show(t("lamp.full", { limit }), "WARNING");
      if (added.length) await OBR.scene.items.updateItems(added, (items) => items.forEach((item) => (item.metadata[LAMP_KEY] = true)));
    },
  });
  OBR.contextMenu.create({
    id: `${PLUGIN_ID}/retirer-lumiere`,
    icons: [
      {
        icon: "/lumiere-off.svg",
        label: t("lamp.remove"),
        filter: { roles: ["GM"], every: [{ key: ["metadata", LAMP_KEY], value: undefined, operator: "!=" }] },
      },
    ],
    async onClick(context) {
      const ids = new Set(context.items.map((item) => item.id));
      await updateState((state) => (state.lamps = state.lamps.filter((lamp) => !ids.has(lamp.item))));
      await OBR.scene.items.updateItems([...ids], (items) => items.forEach((item) => delete item.metadata[LAMP_KEY]));
    },
  });
}

OBR.onReady(async () => {
  // L'outil se crée pour tous, mais ses icônes ne s'affichent que pour le MJ.
  setupTool();
  setupFluidTool();
  setupLampMenu();
  setupLampTool();
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
