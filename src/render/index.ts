// Rendu local : suit l'état et les zones de la scène, et les réglages de ce navigateur.
// Chaque client dessine lui-même : seuls l'état et les zones circulent sur le réseau.

import OBR from "@owlbear-rodeo/sdk";
import { currentQuality, isMuted, onLocalChange } from "../local";
import { parseState, STATE_KEY, type TempestState } from "../state";
import { TOOL_CHANNEL, TOOL_ID, toolSettings, type ToolMessage } from "../tool/tool";
import { parseZones, ZONES_KEY, type ZonesData } from "../zones";
import { wantedOverlay } from "./overlay";
import { wantedLooks } from "./post";
import { EffectSet } from "./sync";
import { wantedWeather } from "./weather";

const weather = new EffectSet();
const looks = new EffectSet();
const overlay = new EffectSet();

let state: TempestState | undefined;
let zones: ZonesData | undefined;
let isGM = false;
/** Outil de peinture actif chez le MJ, et zone choisie : la surimpression les suit. */
let painting = false;
let selectedZone: string | null = null;
let unit = 150;

/** Les mises à jour s'enchaînent dans l'ordre ; si plusieurs arrivent pendant ce temps, seule la dernière compte. */
let running: Promise<void> | null = null;
let again = false;

async function apply() {
  const on = Boolean(state && zones && !state.paused && !isMuted());
  const zoneList = zones?.zones ?? [];
  await weather.sync(on ? wantedWeather(state!, zoneList, currentQuality(), unit) : []);
  await looks.sync(on ? wantedLooks(state!, zoneList, unit) : []);
  await overlay.sync(isGM ? wantedOverlay(zoneList, selectedZone, painting, unit) : []);
}

function render() {
  if (running) {
    again = true;
    return;
  }
  running = apply()
    .catch((error) => console.error("[Tempest!] rendu impossible", error))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        render();
      }
    });
}

export async function startRenderer() {
  isGM = (await OBR.player.getRole()) === "GM";
  const load = async () => {
    // La scène a changé ou s'est rechargée : ses objets locaux ont disparu avec elle.
    weather.forget();
    looks.forget();
    overlay.forget();
    if (!(await OBR.scene.isReady())) {
      state = undefined;
      zones = undefined;
      return;
    }
    const metadata = await OBR.scene.getMetadata();
    state = parseState(metadata[STATE_KEY]);
    zones = parseZones(metadata[ZONES_KEY]);
    unit = await OBR.scene.grid.getDpi();
    render();
  };
  OBR.scene.onReadyChange(() => load().catch(console.error));
  OBR.scene.onMetadataChange((metadata) => {
    state = parseState(metadata[STATE_KEY]);
    zones = parseZones(metadata[ZONES_KEY]);
    render();
  });
  // Une grille changée change la taille des gouttes et des fondus.
  OBR.scene.grid.onChange(async () => {
    unit = await OBR.scene.grid.getDpi();
    render();
  });
  onLocalChange(render);
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
  await load();
}
