// Outil « Fluides » du MJ : tracer une coulée dans le sens du courant, tracer des obstacles en
// polygone (clic par sommet, ou contour à main levée), régler le
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
  HIDE_BRUSH,
  addHideStroke,
  addMask,
  addRock,
  addSource,
  addStroke,
  fluidAt,
  fluidStroke,
  hideStroke,
  hideStrokeAt,
  maskAt,
  newFluid,
  orientStroke,
  outlineRock,
  polygonRock,
  reverseStroke,
  rockAt,
  sourceAt,
  strokeAt,
  type FluidKind,
  type FluidsData,
} from "../fluids";
import { FluidsTooLargeError, onFluidsChange, readFluids, writeFluids } from "../scene-state";
import { PLUGIN_ID } from "../state";
import { addPoint, closesPolygon, type Point } from "./drawing";
import { createVertexMode } from "./vertex-editor";
import { flash, flashInto } from "./flash";
import { floatingWindow, type MoveMessage } from "../window/floating";

export const FLUID_TOOL_ID = `${PLUGIN_ID}/fluides`;
export const FLUID_CHANNEL = `${PLUGIN_ID}/outil-fluides`;
export const FLUID_PALETTE_ID = `${PLUGIN_ID}/palette-fluides`;
export const FLUID_PALETTE_FRAME_ID = `${PLUGIN_ID}/cadre-palette-fluides`;
export const FLUID_PALETTE_WIDTH = 300;
export type FluidToolMessage =
  | { type: "selection"; fluid: string | null }
  /** Largeur ou type changés (barre d'outils, raccourcis, palette) */
  | { type: "settings" }
  | { type: "undo" }
  | { type: "redo" }
  /** De la page de fond vers la palette : gestes à annuler et à rétablir */
  | { type: "history"; undo: number; redo: number }
  | MoveMessage;

type FluidMode = "trace" | "rock" | "hide" | "hideBrush" | "source" | "direction" | "erase";
const MODES: FluidMode[] = ["trace", "rock", "hide", "hideBrush", "source", "direction", "erase"];
const ICONS: Record<FluidMode, string> = { trace: "tracer", rock: "rocher", hide: "cacher", hideBrush: "cacher-pinceau", source: "source", direction: "sens", erase: "gomme" };
/** Modes qui tracent un polygone : obstacle et cache. */
type OutlineMode = "rock" | "hide";
const isOutline = (mode: FluidMode): mode is OutlineMode => mode === "rock" || mode === "hide";
const modeId = (mode: FluidMode) => `${FLUID_TOOL_ID}/${mode}`;

/** Largeurs proposées, en cases : [ et ] passent de l'une à l'autre. */
const WIDTH_STEPS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12];
/** Tailles du pinceau de cache, en cases. */
const HIDE_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
/** Rayon du pinceau de cache, en pixels de la scène. */
const hideRadius = () => (settings.hideSize * unit) / 2;

export interface FluidToolSettings {
  /** Coulée choisie : un nouveau trait commencé hors de toute coulée s'y ajoute */
  fluid: string | null;
  /** Largeur des traits, en cases */
  size: number;
  /** Type d'une coulée créée par l'outil */
  kind: FluidKind;
  /** Taille du pinceau de cache, en cases */
  hideSize: number;
}

export const DEFAULT_FLUID_TOOL: FluidToolSettings = { fluid: null, size: STROKE_WIDTHS.default, kind: "lava", hideSize: HIDE_BRUSH.default };

export function parseFluidToolSettings(value: unknown): FluidToolSettings {
  const raw = (typeof value === "object" && value ? value : {}) as Partial<FluidToolSettings>;
  const size = Number(raw.size);
  return {
    fluid: typeof raw.fluid === "string" && raw.fluid ? raw.fluid : null,
    size: Number.isFinite(size) ? Math.min(STROKE_WIDTHS.max, Math.max(STROKE_WIDTHS.min, size)) : STROKE_WIDTHS.default,
    kind: FLUID_KINDS.includes(raw.kind as FluidKind) ? (raw.kind as FluidKind) : "lava",
    hideSize: Number.isFinite(Number(raw.hideSize)) ? Math.min(HIDE_BRUSH.max, Math.max(HIDE_BRUSH.min, Number(raw.hideSize))) : HIDE_BRUSH.default,
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
  } else {
    const message: FluidToolMessage = { type: "settings" };
    await OBR.broadcast.sendMessage(FLUID_CHANNEL, message, { destination: "LOCAL" });
  }
}

/** Ouvre l'outil sur une coulée (depuis le panneau). */
export async function traceFluid(fluid: string | null, kind?: FluidKind) {
  await setFluidToolSettings({ fluid, ...(kind ? { kind } : {}) });
  await OBR.tool.activateTool(FLUID_TOOL_ID);
  await OBR.tool.activateMode(FLUID_TOOL_ID, modeId("trace"));
}

// --- Modifications, avec annuler et rétablir -------------------------------------------------

const HISTORY_LIMIT = 50;
const past: string[] = [];
const future: string[] = [];

function reportHistory() {
  const message: FluidToolMessage = { type: "history", undo: past.length, redo: future.length };
  OBR.broadcast.sendMessage(FLUID_CHANNEL, message, { destination: "LOCAL" }).catch(() => {});
}

function warn(error: unknown) {
  if (error instanceof FluidFullError) flash(t("fluid.full"), "warning");
  else if (error instanceof TooManyFluidsError) flash(t("fluid.tooMany"), "warning");
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
      reportHistory();
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
      reportHistory();
    })
    .catch(warn);
}

// --- Aperçus -------------------------------------------------------------------------------------

const RING_ID = `${PLUGIN_ID}/anneau-fluide`;
export const KIND_COLORS: Record<FluidKind, string> = {
  lava: "#ff7a2a",
  water: "#3db7e6",
  waterfall: "#7fd6f0",
  shore: "#4fd1c5",
  pool: "#5cc8e0",
  smoke: "#b7d38a",
};

let unit = 150;
let settings = DEFAULT_FLUID_TOOL;
/** Mode de l'outil en cours et dernière position du pointeur : l'anneau suit un changement de largeur. */
let activeMode: FluidMode | null = null;
let lastPointer: Point | null = null;
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
  /** Cache au pinceau : Alt enfoncé au départ, le coup efface le cache */
  erase?: boolean;
  from: Point;
  points: Point[];
  update?: (change: (item: Item) => void) => void;
  stop?: () => void;
}
let gesture: Gesture | undefined;

function previewFor(mode: FluidMode, from: Point, erase = false): Item {
  const color = mode === "erase" ? "#ffffff" : colorAt(from);
  if (mode === "hideBrush") {
    // Pinceau de cache : sombre pour cacher, blanc en pointillés pour rendre visible.
    return buildCurve()
      .points([{ x: 0, y: 0 }])
      .position(from)
      .tension(0)
      .closed(false)
      .strokeColor(erase ? "#ffffff" : "#000000")
      .strokeOpacity(erase ? 0.6 : 0.5)
      .strokeWidth(hideRadius() * 2)
      .strokeDash(erase ? [unit * 0.1, unit * 0.08] : [])
      .fillOpacity(0)
      .layer("CONTROL")
      .locked(true)
      .disableHit(true)
      .build();
  }
  if (isOutline(mode)) return outlineItem(from, color, mode);
  if (mode === "source") {
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

/** Aperçu d'un obstacle (gris) ou d'un cache (sombre, en pointillés), fermé dès le troisième sommet. */
function outlineItem(from: Point, color: string, mode: OutlineMode) {
  return buildCurve()
    .points([{ x: 0, y: 0 }])
    .position(from)
    .tension(0)
    .closed(false)
    .fillColor(mode === "hide" ? "#000000" : "#555555")
    .fillOpacity(mode === "hide" ? 0.35 : 0.45)
    .strokeColor(mode === "hide" ? "#ffffff" : color)
    .strokeOpacity(0.95)
    .strokeWidth(Math.max(1.5, unit * 0.04))
    .strokeDash(mode === "hide" ? [unit * 0.12, unit * 0.08] : [])
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
}

async function startGesture(mode: FluidMode, from: Point, erase = false) {
  const current: Gesture = { mode, from, points: [from], erase };
  gesture = current;
  await refresh();
  hideRing();
  const [update, stop] = await OBR.interaction.startItemInteraction(previewFor(mode, from, erase));
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
  const round = current.mode === "source";
  if (current.mode === "hideBrush") addPoint(current.points, point, hideRadius());
  else if (isOutline(current.mode)) addPoint(current.points, point, unit * 0.25);
  else if (current.mode === "trace" || current.mode === "erase") addPoint(current.points, point, (settings.size * unit) / 2);
  else current.points = [current.from, point];
  current.update?.((item) => {
    if (round) {
      const r = Math.hypot(point.x - current.from.x, point.y - current.from.y);
      const shape = item as Item & { width: number; height: number };
      shape.width = r * 2;
      shape.height = r * 2;
    } else {
      const curve = item as Item & { points: Point[]; closed: boolean };
      curve.points = current.points.map((p) => ({ x: p.x - current.from.x, y: p.y - current.from.y }));
      if (isOutline(current.mode)) curve.closed = current.points.length >= 3;
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
    flash(t("fluid.dragToTrace"));
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

/** Obstacle ou cache fermé : il rejoint la coulée qui l'entoure, ou la plus proche à portée. */
function commitOutline(mode: OutlineMode, points: Point[]) {
  const outline = polygonRock(points, unit * 0.05);
  if (!outline || outline.r < unit * 0.15) {
    flash(t("fluid.rockTooSmall"));
    return;
  }
  edit((data) => {
    const fluid = pickAt(data, outline, outline.r);
    if (!fluid) {
      flash(t(mode === "hide" ? "fluid.hideOutside" : "fluid.rockOutside"));
      return false;
    }
    if (mode === "hide") addMask(fluid, outline);
    else addRock(fluid, outline);
  });
}

/** Coup de pinceau de cache : il rejoint la coulée où il commence, ou la coulée choisie. */
function commitHideBrush(points: Point[], erase: boolean) {
  const stroke = hideStroke(points, hideRadius(), erase);
  if (!stroke) return;
  edit((data) => {
    const fluid = pickAt(data, points[0], hideRadius() + unit * 0.5);
    if (!fluid) {
      flash(t("fluid.hideOutside"));
      return false;
    }
    // Un coup de gomme sur une coulée sans cache ne change rien.
    if (erase && !fluid.hideStrokes.some((candidate) => !candidate.e) && !fluid.masks.length) return false;
    addHideStroke(fluid, stroke);
  });
}

// --- Obstacle en polygone, clic par clic ----------------------------------------------------------

/** Distance au premier sommet, en pixels à l'écran, qui ferme le polygone. */
const CLOSE_DISTANCE = 12;
const FIRST_VERTEX_ID = `${PLUGIN_ID}/premier-sommet`;

interface Polygon {
  mode: OutlineMode;
  points: Point[];
  /** Zoom au premier clic : la distance de fermeture se mesure à l'écran. */
  scale: number;
  closing: boolean;
  color: string;
  update?: (change: (item: Item) => void) => void;
  stop?: () => void;
}
let polygon: Polygon | undefined;

/** Anneau du premier sommet, discret, puis plein quand un clic fermerait le polygone. */
function showFirstVertex(current: Polygon) {
  const size = (current.closing ? 22 : 14) / current.scale;
  const item = buildShape()
    .id(FIRST_VERTEX_ID)
    .shapeType("CIRCLE")
    .width(size)
    .height(size)
    .position(current.points[0])
    .fillColor(current.color)
    .fillOpacity(current.closing ? 0.9 : 0)
    .strokeColor(current.closing ? "#ffffff" : current.color)
    .strokeOpacity(1)
    .strokeWidth(2 / current.scale)
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
  OBR.scene.local.deleteItems([FIRST_VERTEX_ID]).then(() => OBR.scene.local.addItems([item])).catch(() => {});
}

function polygonPreview(current: Polygon, pointer: Point | null) {
  const points = current.closing || !pointer ? current.points : [...current.points, pointer];
  const from = current.points[0];
  current.update?.((item) => {
    const curve = item as Item & { points: Point[]; closed: boolean };
    curve.points = points.map((p) => ({ x: p.x - from.x, y: p.y - from.y }));
    curve.closed = points.length >= 3;
  });
}

async function polygonClick(mode: OutlineMode, point: Point) {
  const current = polygon;
  if (!current) {
    await refresh();
    const started: Polygon = { mode, points: [point], scale: await OBR.viewport.getScale(), closing: false, color: colorAt(point) };
    polygon = started;
    hideRing();
    showFirstVertex(started);
    const [update, stop] = await OBR.interaction.startItemInteraction(outlineItem(point, started.color, mode));
    if (polygon !== started) {
      stop();
      return;
    }
    started.update = update as Polygon["update"];
    started.stop = stop;
    return;
  }
  const tolerance = CLOSE_DISTANCE / current.scale;
  if (closesPolygon(current.points, point, tolerance)) return finishPolygon();
  // Le second clic d'un double-clic tombe sur le sommet précédent : il ne compte pas.
  const last = current.points[current.points.length - 1];
  if (Math.hypot(point.x - last.x, point.y - last.y) < tolerance) return;
  current.points.push(point);
  polygonPreview(current, point);
}

function polygonMove(point: Point) {
  const current = polygon;
  if (!current) return;
  const closing = closesPolygon(current.points, point, CLOSE_DISTANCE / current.scale);
  if (closing !== current.closing) {
    current.closing = closing;
    showFirstVertex(current);
  }
  polygonPreview(current, point);
}

function cancelPolygon() {
  const current = polygon;
  polygon = undefined;
  if (!current) return;
  current.stop?.();
  OBR.scene.local.deleteItems([FIRST_VERTEX_ID]).catch(() => {});
  return current;
}

function finishPolygon() {
  const current = cancelPolygon();
  if (current && current.points.length >= 3) commitOutline(current.mode, current.points);
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
      flash(t("fluid.sourceOutside"));
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
      flash(t("fluid.directionMiss"));
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
      const brush = hideStrokeAt(data, point);
      if (brush) {
        brush.fluid.hideStrokes = brush.fluid.hideStrokes.filter((candidate) => candidate !== brush.stroke);
        changed = true;
        continue;
      }
      const mask = maskAt(data, point);
      if (mask) {
        mask.fluid.masks = mask.fluid.masks.filter((candidate) => candidate !== mask.mask);
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
  if (activeMode === "hideBrush") {
    const size = (await fluidToolSettings()).hideSize;
    const at = HIDE_STEPS.findIndex((step) => step >= size - 0.001);
    const value = HIDE_STEPS[Math.min(HIDE_STEPS.length - 1, Math.max(0, (at < 0 ? HIDE_STEPS.length - 1 : at) + direction))];
    settings = { ...settings, hideSize: value };
    ring = undefined;
    await setFluidToolSettings({ hideSize: value });
    flash(t("fluid.hideBrush", { n: value.toLocaleString() }));
    return;
  }
  const current = (await fluidToolSettings()).size;
  const index = WIDTH_STEPS.findIndex((step) => step >= current - 0.001);
  const next = WIDTH_STEPS[Math.min(WIDTH_STEPS.length - 1, Math.max(0, (index < 0 ? WIDTH_STEPS.length - 1 : index) + direction))];
  settings = { ...settings, size: next };
  ring = undefined;
  await setFluidToolSettings({ size: next });
  flash(t("fluid.width", { n: next.toLocaleString() }));
}

/** Un même raccourci reçu deux fois de suite (moins de 250 ms) ne compte qu'une fois. */
let lastShortcut = { key: "", at: 0 };
function once(key: string) {
  const now = performance.now();
  if (lastShortcut.key === key && now - lastShortcut.at < 250) return false;
  lastShortcut = { key, at: now };
  return true;
}

/** Obstacles et caches en polygone, pour le mode Sommets. Clé : coulée / rock|mask / rang. */
const fluidPolygons = {
  async list() {
    const data = await readFluids();
    return data.fluids.flatMap((fluid) => [
      ...fluid.rocks.flatMap((rock, i) => (rock.p ? [{ key: `${fluid.id}/rock/${i}`, points: rock.p, color: KIND_COLORS[fluid.kind], max: Infinity }] : [])),
      ...fluid.masks.flatMap((mask, i) => (mask.p ? [{ key: `${fluid.id}/mask/${i}`, points: mask.p, color: "#ffffff", max: Infinity }] : [])),
    ]);
  },
  async save(key: string, points: number[]) {
    const [id, list, rank] = key.split("/");
    edit((data) => {
      const fluid = data.fluids.find((candidate) => candidate.id === id);
      const shapes = fluid && (list === "mask" ? fluid.masks : fluid.rocks);
      if (!shapes?.[Number(rank)]) return false;
      shapes[Number(rank)] = outlineRock(points);
    });
    await queue;
  },
  undo: () => travel(past, future),
  redo: () => travel(future, past),
  watch: (callback: () => void) => onFluidsChange(callback),
};

/** Palette flottante de l'outil, créée par setupFluidTool (la palette importe ce fichier). */
let palette: ReturnType<typeof floatingWindow>;

export function setupFluidTool() {
  palette = floatingWindow({
    id: FLUID_PALETTE_ID,
    url: "/fluid-palette.html",
    width: FLUID_PALETTE_WIDTH,
    frameId: FLUID_PALETTE_FRAME_ID,
    storageKey: "tempest/palette-fluides",
    onOpened: () => setTimeout(reportHistory, 400),
  });
  flashInto(palette);
  OBR.broadcast.onMessage(FLUID_CHANNEL, ({ data }) => {
    const message = data as FluidToolMessage;
    if (palette.handle(message)) return;
    if (message.type === "undo") travel(past, future);
    else if (message.type === "redo") travel(future, past);
    else if (message.type === "settings" || message.type === "selection") {
      // Largeur changée depuis la palette : l'anneau prend aussitôt la nouvelle taille.
      fluidToolSettings()
        .then((value) => {
          settings = value;
          // Sans attendre : la dernière valeur du curseur ne doit pas être sautée.
          if (ring) ring.at = 0;
          if (activeMode === "trace" && lastPointer && !gesture) showRing(lastPointer, (settings.size * unit) / 2);
          else if (activeMode === "hideBrush" && lastPointer && !gesture) showRing(lastPointer, hideRadius());
        })
        .catch(console.error);
    }
  });
  const gmOnly = { roles: ["GM" as const] };
  const whenActive = { activeTools: [FLUID_TOOL_ID], roles: ["GM" as const] };
  // La largeur ne sert qu'à tracer et au pinceau de cache : ses boutons n'apparaissent que là.
  const whileTracing = { ...whenActive, activeModes: [modeId("trace"), modeId("hideBrush")] };
  OBR.tool.create({
    id: FLUID_TOOL_ID,
    icons: [{ icon: "/tool/fluides.svg", label: t("fluid.tool"), filter: gmOnly }],
    disabled: { roles: ["PLAYER"] },
    defaultMode: modeId("trace"),
    defaultMetadata: { ...DEFAULT_FLUID_TOOL },
  });
  OBR.tool.createAction({
    id: `${FLUID_TOOL_ID}/plus-fin`,
    icons: [{ icon: "/tool/plus-fin.svg", label: t("fluid.thinner"), filter: whileTracing }],
    onClick: () => changeWidth(-1).catch(console.error),
  });
  OBR.tool.createAction({
    id: `${FLUID_TOOL_ID}/plus-large`,
    icons: [{ icon: "/tool/plus-large.svg", label: t("fluid.wider"), filter: whileTracing }],
    onClick: () => changeWidth(1).catch(console.error),
  });

  for (const mode of MODES) {
    OBR.tool.createMode({
      id: modeId(mode),
      icons: [{ icon: `/tool/${ICONS[mode]}.svg`, label: t(`fluid.mode.${mode}`), filter: whenActive }],
      cursors: [{ cursor: mode === "direction" ? "grab" : "crosshair" }],
      onToolMove(_context, event) {
        lastPointer = event.pointerPosition;
        if (gesture) return;
        if (mode === "trace") showRing(event.pointerPosition, (settings.size * unit) / 2);
        else if (mode === "hideBrush") showRing(event.pointerPosition, hideRadius());
        else if (isOutline(mode)) polygonMove(event.pointerPosition);
        else if (mode === "source") showRing(event.pointerPosition, unit * 1.5);
      },
      onToolDragStart(_context, event) {
        // Un polygone est en cours : un clic un peu glissé reste un sommet.
        if (isOutline(mode) && polygon) return;
        startGesture(mode, event.pointerPosition, event.altKey).catch(console.error);
      },
      onToolDragMove(_context, event) {
        if (isOutline(mode) && polygon) polygonMove(event.pointerPosition);
        else moveGesture(event.pointerPosition);
      },
      onToolDragEnd(_context, event) {
        if (isOutline(mode) && polygon) {
          polygonClick(mode, event.pointerPosition).catch(console.error);
          return;
        }
        const current = endGesture();
        if (!current) return;
        if (mode === "trace") commitTrace([...current.points, event.pointerPosition]);
        else if (mode === "hideBrush") commitHideBrush([...current.points, event.pointerPosition], current.erase ?? false);
        else if (isOutline(mode)) commitOutline(mode, [...current.points, event.pointerPosition]);
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
        else if (isOutline(mode)) await polygonClick(mode, event.pointerPosition);
        // Pinceau de cache : un simple clic pose une touche ronde (ou la gomme, avec Alt).
        else if (mode === "hideBrush") commitHideBrush([event.pointerPosition], event.altKey);
        else if (mode === "source") commitSource(event.pointerPosition, null);
        else if (mode === "direction") commitDirection(event.pointerPosition, null);
        else commitErase([event.pointerPosition]);
        return false;
      },
      async onToolDoubleClick() {
        if (isOutline(mode)) finishPolygon();
        return false;
      },
      onKeyDown(_context, event) {
        if (event.repeat) return;
        const key = event.key.toLowerCase();
        if (isOutline(mode) && polygon) {
          if (event.key === "Enter") return finishPolygon();
          if (event.key === "Escape") return void cancelPolygon();
          if (event.key === "Backspace") {
            if (polygon.points.length > 1) polygon.points.pop();
            else cancelPolygon();
            if (polygon) polygonPreview(polygon, null);
            return;
          }
        }
        if ((event.ctrlKey || event.metaKey) && key === "z") {
          if (once("z")) travel(event.shiftKey ? future : past, event.shiftKey ? past : future);
        } else if ((event.ctrlKey || event.metaKey) && key === "y") {
          if (once("y")) travel(future, past);
        } else if (event.key === "[" || event.key === "-") changeWidth(-1).catch(console.error);
        else if (event.key === "]" || event.key === "+" || event.key === "=") changeWidth(1).catch(console.error);
        else if (event.key === "Escape") endGesture();
      },
      onActivate() {
        activeMode = mode;
        refresh().catch(console.error);
        if (!palette.isOpen) palette.open();
      },
      onDeactivate() {
        endGesture();
        cancelPolygon();
        hideRing();
      },
    });
  }
  createVertexMode({
    onActivate: () => {
      if (!palette.isOpen) palette.open();
    },
    toolId: FLUID_TOOL_ID,
    modeId: `${FLUID_TOOL_ID}/sommets`,
    icon: "/tool/sommets.svg",
    label: t("vertices.mode"),
    filter: whenActive,
    source: fluidPolygons,
  });
  OBR.tool.onToolChange((id) => {
    if (id !== FLUID_TOOL_ID) {
      palette.close();
      endGesture();
      cancelPolygon();
      hideRing();
    }
  });
}
