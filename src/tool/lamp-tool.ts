// Outil « Lumières » du MJ : poser une lumière fixe sur la carte (clic : une torche ; glisser depuis
// le centre : choisir son rayon), et en retirer à la gomme. Tant que l'outil est actif, chaque
// lumière est montrée par son cercle (utile en plein jour, où elles ne se voient pas).

import OBR, { buildShape, type Item } from "@owlbear-rodeo/sdk";
import { t } from "../i18n";
import { readLimits, readState, updateState } from "../scene-state";
import { PLUGIN_ID, STATE_KEY, newLamp, parseState, type Lamp } from "../state";

export const LAMP_TOOL_ID = `${PLUGIN_ID}/lumieres`;
type LampMode = "place" | "erase";
const MODES: LampMode[] = ["place", "erase"];
const ICONS: Record<LampMode, string> = { place: "lumiere", erase: "gomme" };
const modeId = (mode: LampMode) => `${LAMP_TOOL_ID}/${mode}`;
const RING_PREFIX = `${PLUGIN_ID}/cercle-lumiere/`;
const PREVIEW_ID = `${PLUGIN_ID}/apercu-lumiere`;

let unit = 150;
let active = false;
/** Positions des objets porteurs, pour montrer aussi leurs lumières. */
let shown: string[] = [];

/** Cercles des lumières (rayon complet, et la zone vive au centre). */
async function drawRings(lamps: Lamp[]) {
  await OBR.scene.local.deleteItems(shown).catch(() => {});
  shown = [];
  if (!active || !lamps.length) return;
  const carriers = new Map((await OBR.scene.items.getItems()).map((item) => [item.id, item.position]));
  const items: Item[] = [];
  for (const lamp of lamps) {
    const at = lamp.item ? carriers.get(lamp.item) : { x: lamp.x, y: lamp.y };
    if (!at) continue;
    const r = lamp.radius * unit;
    for (const [suffix, size, dash] of [["", r, [unit * 0.15, unit * 0.1]], ["-vive", r * 0.5, []]] as const) {
      items.push(
        buildShape()
          .id(`${RING_PREFIX}${lamp.id}${suffix}`)
          .shapeType("CIRCLE")
          .width(size * 2)
          .height(size * 2)
          .position(at)
          .fillOpacity(0)
          .strokeColor(lamp.color)
          .strokeOpacity(suffix ? 0.5 : 0.9)
          .strokeWidth(Math.max(1.5, unit * 0.03))
          .strokeDash([...dash])
          .layer("CONTROL")
          .locked(true)
          .disableHit(true)
          .build(),
      );
    }
    // Point central : là où cliquer pour la gommer.
    items.push(
      buildShape()
        .id(`${RING_PREFIX}${lamp.id}-centre`)
        .shapeType("CIRCLE")
        .width(unit * 0.3)
        .height(unit * 0.3)
        .position(at)
        .fillColor(lamp.color)
        .fillOpacity(0.9)
        .strokeColor("#000000")
        .strokeOpacity(0.5)
        .strokeWidth(unit * 0.02)
        .layer("CONTROL")
        .locked(true)
        .disableHit(true)
        .build(),
    );
  }
  shown = items.map((item) => item.id);
  await OBR.scene.local.addItems(items).catch(() => {});
}

const refresh = async () => drawRings((await readState()).lamps);

let queue = Promise.resolve();
const enqueue = (work: () => Promise<void>) => {
  queue = queue.then(work).catch((error) => console.error("[Tempest!]", error));
};

function place(center: { x: number; y: number }, edge: { x: number; y: number } | null) {
  const dragged = edge ? Math.hypot(edge.x - center.x, edge.y - center.y) : 0;
  enqueue(async () => {
    const { lamps: limit } = await readLimits();
    await updateState((state) => {
      if (state.lamps.length >= limit) {
        OBR.notification.show(t("lamp.full", { limit }), "WARNING");
        return;
      }
      const lamp = newLamp("", "torch", crypto.randomUUID(), center);
      // Un glissement depuis le centre donne le rayon, arrondi à la demi-case.
      if (dragged > unit * 0.4) lamp.radius = Math.max(0.5, Math.round((dragged / unit) * 2) / 2);
      state.lamps.push(lamp);
    });
  });
}

/** Retire la lumière fixe la plus proche du clic (à moins d'une case de son centre). */
function erase(point: { x: number; y: number }) {
  enqueue(async () => {
    await updateState((state) => {
      let best: Lamp | undefined;
      let bestDistance = unit;
      for (const lamp of state.lamps) {
        if (lamp.item) continue;
        const distance = Math.hypot(point.x - lamp.x, point.y - lamp.y);
        if (distance < bestDistance) [best, bestDistance] = [lamp, distance];
      }
      if (best) state.lamps = state.lamps.filter((lamp) => lamp !== best);
    });
  });
}

/** Aperçu du rayon pendant le glissement. */
let preview: { from: { x: number; y: number }; update?: (change: (item: Item) => void) => void; stop?: () => void } | undefined;

export function setupLampTool() {
  const whenActive = { activeTools: [LAMP_TOOL_ID], roles: ["GM" as const] };
  OBR.tool.create({
    id: LAMP_TOOL_ID,
    icons: [{ icon: "/lumiere.svg", label: t("lamp.tool"), filter: { roles: ["GM"] } }],
    disabled: { roles: ["PLAYER"] },
    defaultMode: modeId("place"),
  });
  for (const mode of MODES) {
    OBR.tool.createMode({
      id: modeId(mode),
      icons: [{ icon: `/tool/${ICONS[mode]}.svg`, label: t(`lamp.mode.${mode}`), filter: whenActive }],
      cursors: [{ cursor: "crosshair" }],
      async onToolClick(_context, event) {
        if (mode === "place") place(event.pointerPosition, null);
        else erase(event.pointerPosition);
        return false;
      },
      async onToolDragStart(_context, event) {
        if (mode !== "place") return;
        const from = event.pointerPosition;
        const current: NonNullable<typeof preview> = { from };
        preview = current;
        const [update, stop] = await OBR.interaction.startItemInteraction(
          buildShape().id(PREVIEW_ID).shapeType("CIRCLE").width(0).height(0).position(from).fillColor("#ffb15c").fillOpacity(0.15).strokeColor("#ffb15c").strokeWidth(unit * 0.04).layer("CONTROL").locked(true).disableHit(true).build(),
        );
        if (preview !== current) return stop();
        current.update = update as typeof current.update;
        current.stop = stop;
      },
      onToolDragMove(_context, event) {
        const current = preview;
        if (!current?.update) return;
        const r = Math.hypot(event.pointerPosition.x - current.from.x, event.pointerPosition.y - current.from.y);
        current.update((item) => {
          const shape = item as Item & { width: number; height: number };
          shape.width = r * 2;
          shape.height = r * 2;
        });
      },
      onToolDragEnd(_context, event) {
        const current = preview;
        preview = undefined;
        current?.stop?.();
        if (mode === "place" && current) place(current.from, event.pointerPosition);
      },
      onToolDragCancel() {
        preview?.stop?.();
        preview = undefined;
      },
      async onActivate() {
        active = true;
        unit = await OBR.scene.grid.getDpi();
        enqueue(refresh);
      },
    });
  }
  OBR.tool.onToolChange((id) => {
    const now = id === LAMP_TOOL_ID;
    if (now === active) return;
    active = now;
    enqueue(refresh);
  });
  // Les cercles suivent les lumières (ajout, gomme, réglages) et les pions qui bougent.
  OBR.scene.onMetadataChange((metadata) => {
    if (active) enqueue(() => drawRings(parseState(metadata[STATE_KEY]).lamps));
  });
  OBR.scene.items.onChange(() => {
    if (active) enqueue(refresh);
  });
}
