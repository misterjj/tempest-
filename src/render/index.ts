// Rendu local : suit l'état et les zones de la scène, et les réglages de ce navigateur.
// Chaque client dessine lui-même : seuls l'état et les zones circulent sur le réseau.

import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { currentQuality, isMuted, onLocalChange } from "../local";
import { LAMP_KEY, parseState, STATE_KEY, type TempestState } from "../state";
import { TOOL_CHANNEL, TOOL_ID, toolSettings, type ToolMessage } from "../tool/tool";
import { parseZones, ZONES_KEY, type ZonesData } from "../zones";
import { BURST_CHANNEL, type BurstKind, type BurstMessage } from "../channels";
import { defaultEffect } from "../state";
import { EMPTY_FRAME, blendFrames, ease, frameOf, type Frame, type WeatherFrame } from "./frame";
import { NATURAL_TINTS } from "./shaders";
import { FLUIDS_KEY, parseFluids, type FluidsData } from "../fluids";
import { FLUID_CHANNEL, FLUID_TOOL_ID, fluidToolSettings, type FluidToolMessage } from "../tool/fluid-tool";
import { wantedArrows, wantedFluids } from "./fluid";
import { wantedOverlay } from "./overlay";
import { wantedPost, type Anchor } from "./post";
import { EffectSet } from "./sync";
import { wantedWeather } from "./weather";

const weather = new EffectSet();
const looks = new EffectSet();
const overlay = new EffectSet();
const fluidSet = new EffectSet();
const arrows = new EffectSet();

let fluids: FluidsData | undefined;
/** Position des objets qui portent une lumière : les lumières les suivent. */
let carriers = new Map<string, { x: number; y: number }>();
/** Objets sélectionnés par ce joueur : on suit en direct la lumière qu'il s'apprête à déplacer. */
let selection: string[] = [];
/** Porteur de lumière suivi par l'après-rendu (voir Anchor dans post.ts). */
let anchorId: string | null = null;

/** Le porteur sélectionné ; sinon celui déjà suivi, s'il porte encore une lumière ; sinon le premier. */
function pickAnchor(carried: string[]) {
  const selected = selection.find((id) => carried.includes(id));
  if (selected) anchorId = selected;
  else if (!anchorId || !carried.includes(anchorId)) anchorId = carried[0] ?? null;
  return anchorId;
}
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

// --- Effets ponctuels ------------------------------------------------------------------------

/** Durée de chaque effet, en secondes. */
const BURST_DURATION: Record<BurstKind, number> = { lightning: 0.9, gust: 3, quake: 1.6 };
let bursts: { kind: BurstKind; start: number }[] = [];

const bump = (t: number, at: number, width: number) => Math.exp(-(((t - at) / width) ** 2));

/** Éclat d'un éclair, secousse de la carte, et coup de vent à ajouter à la météo. */
function currentBursts(now: number, scene: TempestState | undefined) {
  bursts = bursts.filter((burst) => (now - burst.start) / 1000 < BURST_DURATION[burst.kind]);
  let flash = 0;
  const shake = { x: 0, y: 0 };
  const extra: WeatherFrame[] = [];
  for (const burst of bursts) {
    const t = (now - burst.start) / 1000;
    if (burst.kind === "lightning") flash = Math.max(flash, bump(t, 0.05, 0.04), 0.7 * bump(t, 0.28, 0.06), 0.35 * bump(t, 0.5, 0.08));
    else if (burst.kind === "quake") {
      const amplitude = unit * 0.12 * (1 - t / BURST_DURATION.quake) ** 2;
      const angle = Math.random() * Math.PI * 2;
      shake.x += Math.cos(angle) * amplitude;
      shake.y += Math.sin(angle) * amplitude;
    } else {
      // Le coup de vent suit la météo de la scène, s'il y en a une.
      const along = scene?.weather.find((effect) => effect.enabled && effect.zone === "scene")?.direction ?? 90;
      const fade = Math.min(1, t / 0.4) * (1 - Math.max(0, (t - 2.2) / 0.8));
      const wind = defaultEffect("wind", "scene", "rafale");
      extra.push({
        id: `rafale-${burst.start}`,
        kind: "wind",
        zone: "scene",
        direction: along,
        speed: 2.6,
        scale: 1,
        turbulence: 0.4,
        intensity: 0.85,
        opacity: Math.max(0, fade),
        tint: NATURAL_TINTS.wind,
        gusts: 0.8,
        variety: 0.5,
        patches: 0.5,
        options: { ...wind.options, debris: 0.8 },
        natural: true,
      });
    }
  }
  return { flash, shake, extra };
}

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
  const burst = currentBursts(performance.now(), state);
  if (!isMuted() && burst.extra.length) frame = { ...frame, weather: [...frame.weather, ...burst.extra] };
  const cartoon = state?.style === "cartoon";
  await weather.sync(wantedWeather(frame.weather, zoneList, currentQuality(), unit, cartoon));
  const lamps = on
    ? state!.lamps.flatMap((lamp) => {
        if (!lamp.item) return [lamp];
        const at = carriers.get(lamp.item);
        return at ? [{ ...lamp, ...at }] : [];
      })
    : [];
  const idle = { flash: 0, shake: { x: 0, y: 0 } };
  const anchorItem = pickAnchor([...new Set(lamps.flatMap((lamp) => (lamp.item ? [lamp.item] : [])))]);
  const anchorAt = anchorItem ? carriers.get(anchorItem) : undefined;
  const anchor: Anchor | null =
    anchorItem && anchorAt
      ? { item: anchorItem, ...anchorAt, screen: { x: await OBR.viewport.getWidth(), y: await OBR.viewport.getHeight() } }
      : null;
  await looks.sync(
    wantedPost(
      frame,
      zoneList,
      currentQuality(),
      unit,
      lamps,
      on && !state!.paused ? fluids?.fluids ?? [] : [],
      isMuted() ? idle : { flash: burst.flash, shake: burst.shake },
      anchor,
    ),
  );
  await overlay.sync(isGM ? wantedOverlay(zoneList, selectedZone, painting, unit) : []);
  const fluidList = fluids?.fluids ?? [];
  await fluidSet.sync(on && !state!.paused ? wantedFluids(fluidList, currentQuality(), unit, 1, cartoon) : []);
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
      // Transition ou effet ponctuel : 25 images par seconde. Heure qui avance : une par seconde.
      const clockRunning = state?.looks.some((look) => look.time.enabled && look.time.pace > 0);
      tick = transition || bursts.length ? setTimeout(render, TRANSITION_STEP_MS) : clockRunning ? setTimeout(render, 1000) : undefined;
      if (again) {
        again = false;
        render();
      }
    });
}

/** Garde la position des objets porteurs ; redessine seulement si l'un d'eux a bougé. */
function trackCarriers(items: Item[]) {
  const next = new Map<string, { x: number; y: number }>();
  for (const item of items) if (item.metadata[LAMP_KEY] !== undefined) next.set(item.id, { x: item.position.x, y: item.position.y });
  const changed = next.size !== carriers.size || [...next].some(([id, at]) => carriers.get(id)?.x !== at.x || carriers.get(id)?.y !== at.y);
  carriers = next;
  return changed;
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
    trackCarriers(await OBR.scene.items.getItems());
    unit = await OBR.scene.grid.getDpi();
    render();
  };
  OBR.scene.onReadyChange(() => load().catch(console.error));
  // Un porteur de lumière sélectionné devient celui que l'après-rendu suit, avant qu'on le déplace.
  selection = (await OBR.player.getSelection()) ?? [];
  OBR.player.onChange((player) => {
    const next = player.selection ?? [];
    if (next.join() === selection.join()) return;
    selection = next;
    if (next.some((id) => carriers.has(id) && id !== anchorId)) render();
  });
  OBR.scene.items.onChange((items) => {
    if (trackCarriers(items)) render();
  });
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
  OBR.broadcast.onMessage(BURST_CHANNEL, ({ data }) => {
    bursts.push({ kind: (data as BurstMessage).kind, start: performance.now() });
    render();
  });
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
