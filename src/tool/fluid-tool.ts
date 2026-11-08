// Outil « Fluides » du MJ : tracer une coulée dans le sens du courant, poser des rochers, régler le
// sens d'un trait en glissant le long, gommer. Pendant que l'outil est actif, des chevrons
// défilent sur chaque trait dans le sens du courant (voir render/fluid.ts).

import OBR, { buildCurve, buildShape, type Item } from "@owlbear-rodeo/sdk";
import { t } from "../i18n";
import {
  FLUID_KINDS,
  FluidFullError,
  STROKE_WIDTHS,
  TooManyFluidsError,
  addFluid,
  addRock,
  addSource,
  addStroke,
  fluidAt,
  fluidStroke,
  newFluid,
  orientStroke,
  reverseStroke,
  rockAt,
  sourceAt,
  strokeAt,
  type FluidKind,
  type FluidsData,
} from "../fluids";
import { FluidsTooLargeError, readFluids, writeFluids } from "../scene-state";
import { PLUGIN_ID } from "../state";
import { addPoint, type Point } from "./drawing";

export const FLUID_TOOL_ID = `${PLUGIN_ID}/fluides`;
export const FLUID_CHANNEL = `${PLUGIN_ID}/outil-fluides`;
export type FluidToolMessage = { type: "selection"; fluid: string | null };

type FluidMode = "trace" | "rock" | "source" | "direction" | "erase";
const MODES: FluidMode[] = ["trace", "rock", "source", "direction", "erase"];
const ICONS: Record<FluidMode, string> = { trace: "tracer", rock: "rocher", source: "source", direction: "sens", erase: "gomme" };
const modeId = (mode: FluidMode) => `${FLUID_TOOL_ID}/${mode}`;

/** Largeurs proposées, en cases : [ et ] passent de l'une à l'autre. */
const WIDTH_STEPS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12];

export interface FluidToolSettings {
  /** Coulée choisie : un nouveau trait commencé hors de toute coulée s'y ajoute */
  fluid: string | null;
  /** Largeur des traits, en cases */
  size: number;
  /** Type d'une coulée créée par l'outil */
  kind: FluidKind;
}

export const DEFAULT_FLUID_TOOL: FluidToolSettings = { fluid: null, size: STROKE_WIDTHS.default, kind: "lava" };

export function parseFluidToolSettings(value: unknown): FluidToolSettings {
  const raw = (typeof value === "object" && value ? value : {}) as Partial<FluidToolSettings>;
  const size = Number(raw.size);
  return {
    fluid: typeof raw.fluid === "string" && raw.fluid ? raw.fluid : null,
    size: Number.isFinite(size) ? Math.min(STROKE_WIDTHS.max, Math.max(STROKE_WIDTHS.min, size)) : STROKE_WIDTHS.default,
    kind: FLUID_KINDS.includes(raw.kind as FluidKind) ? (raw.kind as FluidKind) : "lava",
  };
}

export async function fluidToolSettings() {
  return parseFluidToolSettings(await OBR.tool.getMetadata(FLUID_TOOL_ID));
}

export async function setFluidToolSettings(change: Partial<FluidToolSettings>) {
  await OBR.tool.setMetadata(FLUID_TOOL_ID, change);
  if ("fluid" in change) {
    const message: FluidToolMessage = { type: "selection", fluid: change.fluid ?? null };
    await OBR.broadcast.sendMessage(FLUID_CHANNEL, message, { destination: "LOCAL" });
  }
}

/** Ouvre l'outil sur une coulée (depuis le panneau). */
export async function traceFluid(fluid: string | null, kind?: FluidKind) {
  await setFluidToolSettings({ fluid, ...(kind ? { kind } : {}) });
  await OBR.tool.activateTool(FLUID_TOOL_ID);
  await OBR.tool.activateMode(FLUID_TOOL_ID, modeId("trace"));
  // Comment tracer ce fluide-là : chaque type a sa façon.
  const shown = kind ?? (await readFluids()).fluids.find((candidate) => candidate.id === fluid)?.kind;
  if (shown) OBR.notification.show(t(`fluid.how.${shown}`), "INFO");
}

// --- Modifications, avec annuler et rétablir -------------------------------------------------

const HISTORY_LIMIT = 50;
const past: string[] = [];
const future: string[] = [];

function warn(error: unknown) {
  if (error instanceof FluidFullError) OBR.notification.show(t("fluid.full"), "WARNING");
  else if (error instanceof TooManyFluidsError) OBR.notification.show(t("fluid.tooMany"), "WARNING");
  else if (error instanceof FluidsTooLargeError) OBR.notification.show(t("fluid.tooLarge"), "ERROR");
  else console.error("[Tempest!]", error);
}

/** Une modification à la fois, gardée dans l'historique. `apply` renvoie false s'il n'a rien changé. */
let queue = Promise.resolve();
function edit(apply: (data: FluidsData) => boolean | void | Promise<boolean | void>) {
  queue = queue
    .then(async () => {
      const data = await readFluids();
      const before = JSON.stringify(data);
      if ((await apply(data)) === false || JSON.stringify(data) === before) return;
      await writeFluids(data);
      past.push(before);
      if (past.length > HISTORY_LIMIT) past.shift();
      future.length = 0;
    })
    .catch(warn);
}

function travel(from: string[], to: string[]) {
  queue = queue
    .then(async () => {
      const previous = from.pop();
      if (!previous) return;
      to.push(JSON.stringify(await readFluids()));
      await writeFluids(JSON.parse(previous));
    })
    .catch(warn);
}

// --- Aperçus -------------------------------------------------------------------------------------

const RING_ID = `${PLUGIN_ID}/anneau-fluide`;
const KIND_COLORS: Record<FluidKind, string> = {
  lava: "#ff7a2a",
  water: "#3db7e6",
  waterfall: "#7fd6f0",
  shore: "#4fd1c5",
  pool: "#5cc8e0",
  smoke: "#b7d38a",
};

let unit = 150;
let settings = DEFAULT_FLUID_TOOL;
let fluidsCache: FluidsData | undefined;

async function refresh() {
  [unit, settings, fluidsCache] = await Promise.all([OBR.scene.grid.getDpi(), fluidToolSettings(), readFluids()]);
}

/** Coulée visée en ce point : celle qui s'y trouve, sinon celle choisie. */
function targetAt(point: Point) {
  return fluidsCache && (fluidAt(fluidsCache, point) ?? fluidsCache.fluids.find((candidate) => candidate.id === settings.fluid));
}
const kindAt = (point: Point) => targetAt(point)?.kind ?? settings.kind;

/** Couleur de l'aperçu : celle de la coulée visée. */
function colorAt(point: Point) {
  return KIND_COLORS[kindAt(point)];
}

/** Anneau qui suit le pointeur : la largeur du trait, ou la taille d'un rocher. */
let ring: { item: Item; at: number } | undefined;
function showRing(point: Point, radius: number) {
  const now = performance.now();
  if (ring && now - ring.at < 30) return;
  if (ring && Math.abs((ring.item as Item & { width: number }).width - radius * 2) < 0.5) {
    ring.at = now;
    OBR.scene.local.updateItems([RING_ID], (items) => {
      for (const item of items) item.position = point;
    }, true).catch(() => {});
    return;
  }
  const item = buildShape()
    .id(RING_ID)
    .shapeType("CIRCLE")
    .width(radius * 2)
    .height(radius * 2)
    .position(point)
    .fillOpacity(0)
    .strokeColor(colorAt(point))
    .strokeOpacity(0.9)
    .strokeWidth(Math.max(1.5, unit * 0.03))
    .strokeDash([unit * 0.1, unit * 0.08])
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
  ring = { item, at: now };
  OBR.scene.local.deleteItems([RING_ID]).then(() => OBR.scene.local.addItems([item])).catch(() => {});
}
function hideRing() {
  ring = undefined;
  OBR.scene.local.deleteItems([RING_ID]).catch(() => {});
}

interface Gesture {
  mode: FluidMode;
  from: Point;
  points: Point[];
  update?: (change: (item: Item) => void) => void;
  stop?: () => void;
}
let gesture: Gesture | undefined;

function previewFor(mode: FluidMode, from: Point): Item {
  const color = mode === "erase" ? "#ffffff" : colorAt(from);
  if (mode === "rock" || mode === "source") {
    return buildShape().shapeType("CIRCLE").width(0).height(0).position(from).fillColor("#555555").fillOpacity(0.5).strokeColor(color).strokeWidth(unit * 0.04).layer("CONTROL").locked(true).disableHit(true).build();
  }
  return buildCurve()
    .points([{ x: 0, y: 0 }])
    .position(from)
    .tension(0)
    .closed(false)
    .strokeColor(color)
    .strokeOpacity(mode === "trace" ? 0.45 : 0.9)
    .strokeWidth(mode === "trace" ? (settings.size * unit) : unit * 0.06)
    .strokeDash(mode === "erase" ? [unit * 0.15, unit * 0.1] : [])
    .fillOpacity(0)
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
}

async function startGesture(mode: FluidMode, from: Point) {
  await refresh();
  const current: Gesture = { mode, from, points: [from] };
  gesture = current;
  hideRing();
  const [update, stop] = await OBR.interaction.startItemInteraction(previewFor(mode, from));
  if (gesture !== current) {
    stop();
    return;
  }
  current.update = update as Gesture["update"];
  current.stop = stop;
}

function moveGesture(point: Point) {
  const current = gesture;
  if (!current) return;
  const round = current.mode === "rock" || current.mode === "source";
  if (!round && (current.mode === "trace" || current.mode === "erase")) addPoint(current.points, point, (settings.size * unit) / 2);
  else current.points = [current.from, point];
  current.update?.((item) => {
    if (round) {
      const r = Math.hypot(point.x - current.from.x, point.y - current.from.y);
      const shape = item as Item & { width: number; height: number };
      shape.width = r * 2;
      shape.height = r * 2;
    } else {
      (item as Item & { points: Point[] }).points = current.points.map((p) => ({ x: p.x - current.from.x, y: p.y - current.from.y }));
    }
  });
}

function endGesture() {
  const current = gesture;
  gesture = undefined;
  current?.stop?.();
  return current;
}

// --- Gestes ---------------------------------------------------------------------------------------

function nextFluidName(data: FluidsData, kind: FluidKind) {
  const count = data.fluids.filter((fluid) => fluid.kind === kind).length + 1;
  return t(`fluid.name.${kind}`, { n: count });
}

/** Trait terminé : il s'ajoute à la coulée où il commence, sinon à la coulée choisie, sinon à une nouvelle. */
function commitTrace(points: Point[]) {
  if (points.length < 2) {
    OBR.notification.show(t("fluid.dragToTrace"), "INFO");
    return;
  }
  const radius = (settings.size * unit) / 2;
  const stroke = fluidStroke(points, radius);
  if (!stroke) return;
  let chosen: string | null = null;
  edit((data) => {
    // La coulée choisie d'abord : une cascade tracée en travers d'une rivière reste une cascade.
    // Sans choix, un trait commencé dans une coulée du même type en devient une branche.
    let fluid =
      data.fluids.find((candidate) => candidate.id === settings.fluid) ??
      data.fluids.find((candidate) => candidate.kind === settings.kind && candidate.id === fluidAt({ ...data, fluids: [candidate] }, points[0])?.id);
    if (!fluid) {
      fluid = newFluid(settings.kind, nextFluidName(data, settings.kind));
      addFluid(data, fluid);
    }
    addStroke(fluid, stroke);
    chosen = fluid.id;
  });
  queue = queue.then(() => (chosen && chosen !== settings.fluid ? setFluidToolSettings({ fluid: chosen }) : undefined));
}

function commitRock(center: Point, edge: Point | null) {
  const r = edge ? Math.hypot(edge.x - center.x, edge.y - center.y) : unit * 0.5;
  if (r < unit * 0.15) return;
  edit((data) => {
    // Le rocher rejoint la coulée qui l'entoure, ou la plus proche à portée.
    const fluid = pickAt(data, center, r);
    if (!fluid) {
      OBR.notification.show(t("fluid.rockOutside"), "INFO");
      return false;
    }
    addRock(fluid, { x: Math.round(center.x), y: Math.round(center.y), r: Math.round(r) });
  });
}

/** Coulée visée pour un rocher ou une source : la choisie si le point y est, sinon celle sous le point. */
function pickAt(data: FluidsData, point: Point, margin: number) {
  const chosen = data.fluids.find((candidate) => candidate.id === settings.fluid);
  if (chosen && fluidAt({ ...data, fluids: [chosen] }, point, margin)) return chosen;
  return fluidAt(data, point, margin) ?? chosen;
}

/** Source : glisser depuis le centre donne sa portée ; un clic en pose une d'une case et demie. */
function commitSource(center: Point, edge: Point | null) {
  const dragged = edge ? Math.hypot(edge.x - center.x, edge.y - center.y) : 0;
  const r = dragged > unit * 0.3 ? dragged : unit * 1.5;
  edit((data) => {
    const fluid = pickAt(data, center, unit * 0.5);
    if (!fluid) {
      OBR.notification.show(t("fluid.sourceOutside"), "INFO");
      return false;
    }
    addSource(fluid, { x: Math.round(center.x), y: Math.round(center.y), r: Math.round(r) });
  });
}

/** Glisser le long d'un trait l'oriente dans ce sens ; un simple clic l'inverse. */
function commitDirection(from: Point, to: Point | null) {
  edit((data) => {
    const hit = strokeAt(data, from, unit * 0.5);
    if (!hit) {
      OBR.notification.show(t("fluid.directionMiss"), "INFO");
      return false;
    }
    if (!to || Math.hypot(to.x - from.x, to.y - from.y) < unit * 0.2) {
      reverseStroke(hit.stroke);
      return;
    }
    return orientStroke(hit.stroke, from, to);
  });
}

/** Gomme : les rochers d'abord, puis les traits touchés. */
function commitErase(points: Point[]) {
  edit((data) => {
    let changed = false;
    for (const point of points) {
      const source = sourceAt(data, point, unit * 0.2);
      if (source) {
        source.fluid.sources = source.fluid.sources.filter((candidate) => candidate !== source.source);
        changed = true;
        continue;
      }
      const rock = rockAt(data, point);
      if (rock) {
        rock.fluid.rocks = rock.fluid.rocks.filter((candidate) => candidate !== rock.rock);
        changed = true;
        continue;
      }
      const hit = strokeAt(data, point);
      if (hit) {
        hit.fluid.strokes = hit.fluid.strokes.filter((candidate) => candidate !== hit.stroke);
        changed = true;
      }
    }
    return changed;
  });
}

async function changeWidth(direction: 1 | -1) {
  const current = (await fluidToolSettings()).size;
  const index = WIDTH_STEPS.findIndex((step) => step >= current - 0.001);
  const next = WIDTH_STEPS[Math.min(WIDTH_STEPS.length - 1, Math.max(0, (index < 0 ? WIDTH_STEPS.length - 1 : index) + direction))];
  settings = { ...settings, size: next };
  ring = undefined;
  await setFluidToolSettings({ size: next });
  OBR.notification.show(t("fluid.width", { n: next.toLocaleString() }), "DEFAULT");
}

/** Un même raccourci reçu deux fois de suite (moins de 250 ms) ne compte qu'une fois. */
let lastShortcut = { key: "", at: 0 };
function once(key: string) {
  const now = performance.now();
  if (lastShortcut.key === key && now - lastShortcut.at < 250) return false;
  lastShortcut = { key, at: now };
  return true;
}

export function setupFluidTool() {
  const gmOnly = { roles: ["GM" as const] };
  const whenActive = { activeTools: [FLUID_TOOL_ID], roles: ["GM" as const] };
  OBR.tool.create({
    id: FLUID_TOOL_ID,
    icons: [{ icon: "/tool/fluides.svg", label: t("fluid.tool"), filter: gmOnly }],
    disabled: { roles: ["PLAYER"] },
    defaultMode: modeId("trace"),
    defaultMetadata: { ...DEFAULT_FLUID_TOOL },
  });
  OBR.tool.createAction({
    id: `${FLUID_TOOL_ID}/plus-fin`,
    icons: [{ icon: "/tool/plus-fin.svg", label: t("fluid.thinner"), filter: whenActive }],
    onClick: () => changeWidth(-1).catch(console.error),
  });
  OBR.tool.createAction({
    id: `${FLUID_TOOL_ID}/plus-large`,
    icons: [{ icon: "/tool/plus-large.svg", label: t("fluid.wider"), filter: whenActive }],
    onClick: () => changeWidth(1).catch(console.error),
  });

  for (const mode of MODES) {
    OBR.tool.createMode({
      id: modeId(mode),
      icons: [{ icon: `/tool/${ICONS[mode]}.svg`, label: t(`fluid.mode.${mode}`), filter: whenActive }],
      cursors: [{ cursor: mode === "direction" ? "grab" : "crosshair" }],
      onToolMove(_context, event) {
        if (gesture) return;
        if (mode === "trace") showRing(event.pointerPosition, (settings.size * unit) / 2);
        else if (mode === "rock") showRing(event.pointerPosition, unit * 0.5);
        else if (mode === "source") showRing(event.pointerPosition, unit * 1.5);
      },
      onToolDragStart(_context, event) {
        startGesture(mode, event.pointerPosition).catch(console.error);
      },
      onToolDragMove(_context, event) {
        moveGesture(event.pointerPosition);
      },
      onToolDragEnd(_context, event) {
        const current = endGesture();
        if (!current) return;
        if (mode === "trace") commitTrace([...current.points, event.pointerPosition]);
        else if (mode === "rock") commitRock(current.from, event.pointerPosition);
        else if (mode === "source") commitSource(current.from, event.pointerPosition);
        else if (mode === "direction") commitDirection(current.from, event.pointerPosition);
        else commitErase([...current.points, event.pointerPosition]);
      },
      onToolDragCancel() {
        endGesture();
      },
      async onToolClick(_context, event) {
        await refresh();
        if (mode === "trace") commitTrace([event.pointerPosition]);
        else if (mode === "rock") commitRock(event.pointerPosition, null);
        else if (mode === "source") commitSource(event.pointerPosition, null);
        else if (mode === "direction") commitDirection(event.pointerPosition, null);
        else commitErase([event.pointerPosition]);
        return false;
      },
      onKeyDown(_context, event) {
        if (event.repeat) return;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === "z") {
          if (once("z")) travel(event.shiftKey ? future : past, event.shiftKey ? past : future);
        } else if ((event.ctrlKey || event.metaKey) && key === "y") {
          if (once("y")) travel(future, past);
        } else if (event.key === "[" || event.key === "-") changeWidth(-1).catch(console.error);
        else if (event.key === "]" || event.key === "+" || event.key === "=") changeWidth(1).catch(console.error);
        else if (event.key === "Escape") endGesture();
      },
      onActivate() {
        refresh().catch(console.error);
      },
      onDeactivate() {
        endGesture();
        hideRing();
      },
    });
  }
  OBR.tool.onToolChange((id) => {
    if (id !== FLUID_TOOL_ID) {
      endGesture();
      hideRing();
    }
  });
}
