// Rendu local : suit l'état et les zones de la scène, et les réglages de ce navigateur.
// Chaque client dessine lui-même : seuls l'état et les zones circulent sur le réseau.

import OBR from "@owlbear-rodeo/sdk";
import { currentQuality, isMuted, onLocalChange } from "../local";
import { parseState, STATE_KEY, type TempestState } from "../state";
import { TOOL_CHANNEL, TOOL_ID, toolSettings, type ToolMessage } from "../tool/tool";
import { parseZones, ZONES_KEY, type ZonesData } from "../zones";
import { EMPTY_FRAME, blendFrames, ease, frameOf, type Frame } from "./frame";
import { FLUIDS_KEY, parseFluids, type FluidsData } from "../fluids";
import { FLUID_CHANNEL, FLUID_TOOL_ID, fluidToolSettings, type FluidToolMessage } from "../tool/fluid-tool";
import { wantedArrows, wantedFluids } from "./fluid";
import { wantedOverlay } from "./overlay";
import { wantedPost } from "./post";
import { EffectSet } from "./sync";
import { wantedWeather } from "./weather";

const weather = new EffectSet();
const looks = new EffectSet();
const overlay = new EffectSet();
const fluidSet = new EffectSet();
const arrows = new EffectSet();

let fluids: FluidsData | undefined;
/** Outil Fluides actif chez le MJ, et coulée choisie : les chevrons du courant les suivent. */
let tracing = false;
let selectedFluid: string | null = null;

let state: TempestState | undefined;
let zones: ZonesData | undefined;
let isGM = false;
/** Outil de peinture actif chez le MJ, et zone choisie : la surimpression les suit. */
let painting = false;
let selectedZone: string | null = null;
let unit = 150;

/** Une image toutes les 40 ms pendant une transition : fluide, sans charger Owlbear. */
const TRANSITION_STEP_MS = 40;

/** Image affichée en dernier : une nouvelle transition part de là, même au milieu d'une autre. */
let shown: Frame = EMPTY_FRAME;
/** Transition en cours : elle va de `from` vers l'état actuel, qui peut encore bouger en route. */
let transition: { from: Frame; start: number; end: number } | undefined;
/** Dernier changement doux vu : un nouveau lance une transition. */
let lastSmooth: string | undefined;
let tick: ReturnType<typeof setTimeout> | undefined;

/** L'état vient de changer : un changement doux part de ce qui est affiché. */
function follow(next: TempestState) {
  if (lastSmooth !== undefined && next.smooth !== lastSmooth && next.transition > 0) {
    const now = performance.now();
    transition = { from: shown, start: now, end: now + next.transition * 1000 };
  }
  lastSmooth = next.smooth;
}

/** Les mises à jour s'enchaînent dans l'ordre ; si plusieurs arrivent pendant ce temps, seule la dernière compte. */
let running: Promise<void> | null = null;
let again = false;

async function apply() {
  const on = Boolean(state && zones && !isMuted());
  const zoneList = zones?.zones ?? [];
  const target = on ? frameOf(state!, new Set(zoneList.map((zone) => zone.id))) : EMPTY_FRAME;
  let frame = target;
  if (transition) {
    const t = (performance.now() - transition.start) / (transition.end - transition.start);
    if (t >= 1) transition = undefined;
    else frame = blendFrames(transition.from, target, ease(t));
  }
  shown = frame;
  await weather.sync(wantedWeather(frame.weather, zoneList, currentQuality(), unit));
  await looks.sync(wantedPost(frame, zoneList, currentQuality(), unit));
  await overlay.sync(isGM ? wantedOverlay(zoneList, selectedZone, painting, unit) : []);
  const fluidList = fluids?.fluids ?? [];
  await fluidSet.sync(on && !state!.paused ? wantedFluids(fluidList, currentQuality(), unit) : []);
  await arrows.sync(isGM && tracing ? wantedArrows(fluidList, selectedFluid, unit) : []);
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
      clearTimeout(tick);
      tick = transition ? setTimeout(render, TRANSITION_STEP_MS) : undefined;
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
    fluidSet.forget();
    arrows.forget();
    // Scène ouverte ou rechargée : elle s'affiche telle quelle, sans transition.
    shown = EMPTY_FRAME;
    transition = undefined;
    lastSmooth = undefined;
    if (!(await OBR.scene.isReady())) {
      state = undefined;
      zones = undefined;
      return;
    }
    const metadata = await OBR.scene.getMetadata();
    state = parseState(metadata[STATE_KEY]);
    lastSmooth = state.smooth;
    zones = parseZones(metadata[ZONES_KEY]);
    fluids = parseFluids(metadata[FLUIDS_KEY]);
    unit = await OBR.scene.grid.getDpi();
    render();
  };
  OBR.scene.onReadyChange(() => load().catch(console.error));
  OBR.scene.onMetadataChange((metadata) => {
    state = parseState(metadata[STATE_KEY]);
    follow(state);
    zones = parseZones(metadata[ZONES_KEY]);
    fluids = parseFluids(metadata[FLUIDS_KEY]);
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
    tracing = (await OBR.tool.getActiveTool()) === FLUID_TOOL_ID;
    selectedFluid = (await fluidToolSettings()).fluid;
    OBR.tool.onToolChange((id) => {
      painting = id === TOOL_ID;
      tracing = id === FLUID_TOOL_ID;
      render();
    });
    OBR.broadcast.onMessage(FLUID_CHANNEL, ({ data }) => {
      const message = data as FluidToolMessage;
      if (message.type === "selection") {
        selectedFluid = message.fluid;
        render();
      }
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
