// Rendu local : suit l'état de la scène et les réglages de ce navigateur.

import OBR from "@owlbear-rodeo/sdk";
import { currentQuality, isMuted, onLocalChange } from "../local";
import { onStateChange, readState } from "../scene-state";
import type { TempestState } from "../state";
import { clearPost, syncPost } from "./post";
import { TOOL_CHANNEL, TOOL_ID, toolSettings, type ToolMessage } from "../tool/tool";
import { parseZones, ZONES_KEY, type ZonesData } from "../zones";
import { forgetOverlay, syncOverlay } from "./overlay";
import { PROTO_KEY, forgetProto, parseProto, syncProto, type Proto } from "./proto";
import { clearWeather, syncWeather } from "./weather";

let latest: TempestState | undefined;
let proto: Proto | undefined;
let isGM = false;
let zones: ZonesData | undefined;
/** Outil de peinture actif chez le MJ, et zone choisie : la surimpression les suit. */
let painting = false;
let selectedZone: string | null = null;
/** Les mises à jour s'enchaînent dans l'ordre, sans se chevaucher. */
let queue = Promise.resolve();

function render() {
  queue = queue.then(async () => {
    const state = latest;
    const enabled = Boolean(state && !state.paused && !isMuted());
    console.info("[Tempest!] rendu", { role: isGM ? "MJ" : "joueur", scène: Boolean(state), coupé: isMuted(), pause: state?.paused, qualité: currentQuality(), prototype: proto });
    if (proto) await syncProto(proto, isGM, currentQuality(), enabled);
    if (isGM && zones) await syncOverlay(zones.zones, selectedZone, painting);
    if (!state || !enabled) {
      await Promise.all([clearWeather(), clearPost()]);
      return;
    }
    await Promise.all([syncWeather(state.weather, currentQuality()), syncPost(state)]);
  }).catch((error) => console.error("[Tempest!] rendu impossible", error));
}

export async function startRenderer() {
  isGM = (await OBR.player.getRole()) === "GM";
  console.info(`[Tempest!] démarrage (${isGM ? "MJ" : "joueur"})`);
  const load = async () => {
    forgetProto();
    forgetOverlay();
    const ready = await OBR.scene.isReady();
    latest = ready ? await readState() : undefined;
    const metadata = ready ? await OBR.scene.getMetadata() : {};
    proto = ready ? parseProto(metadata[PROTO_KEY]) : undefined;
    zones = ready ? parseZones(metadata[ZONES_KEY]) : undefined;
    render();
  };
  OBR.scene.onMetadataChange((metadata) => {
    proto = parseProto(metadata[PROTO_KEY]);
    zones = parseZones(metadata[ZONES_KEY]);
    render();
  });
  if (isGM) {
    painting = (await OBR.tool.getActiveTool()) === TOOL_ID;
    selectedZone = (await toolSettings()).zone;
    OBR.tool.onToolChange((id) => {
      painting = id === TOOL_ID;
      render();
    });
    OBR.broadcast.onMessage(TOOL_CHANNEL, ({ data }) => {
      const message = data as ToolMessage;
      if (message.type === "selection") {
        selectedZone = message.zone;
        render();
      }
    });
  }
  OBR.scene.onReadyChange(load);
  onStateChange((state) => {
    latest = state;
    render();
  });
  onLocalChange(render);
  await load();
}
