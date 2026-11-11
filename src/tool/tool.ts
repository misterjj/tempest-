// Outil « Zones météo » du MJ : pinceau, rectangle, cercle et polygone, pour peindre ou effacer.
// Le tracé s'affiche en direct (interaction locale), puis la forme est ajoutée à la zone choisie
// dans la palette. La palette est une fenêtre déplaçable (voir window/move.ts).

import OBR, { buildCurve, buildShape, type Item, type KeyFilter } from "@owlbear-rodeo/sdk";
import { t } from "../i18n";
import { onZonesChange, readLimits, readZones, updateZones, ZonesTooLargeError } from "../scene-state";
import { PLUGIN_ID } from "../state";
import { TooManyZonesError, ZoneFullError, addShape, addZone, newZone, zoneCost, type Shape } from "../zones";
import { createVertexMode } from "./vertex-editor";
import { flash, flashInto } from "./flash";
import { floatingWindow, type MoveMessage } from "../window/floating";
import {
  DEFAULT_TOOL_SETTINGS,
  PAINT_MODES,
  addPoint,
  circleShape,
  closesPolygon,
  erasing,
  parseToolSettings,
  polygonShape,
  rectShape,
  strokeShape,
  type PaintMode,
  type Point,
  type ToolSettings,
} from "./drawing";

export const TOOL_ID = `${PLUGIN_ID}/zones`;
export const PALETTE_ID = `${PLUGIN_ID}/palette`;
export const TOOL_CHANNEL = `${PLUGIN_ID}/outil`;
export const PALETTE_FRAME_ID = `${PLUGIN_ID}/cadre-palette`;
export const PALETTE_WIDTH = 300;

/** Messages locaux entre la palette et la page de fond. */
export type ToolMessage =
  | { type: "selection"; zone: string | null }
  | { type: "settings" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear"; zone: string }
  /** De la page de fond vers la palette : nombre de gestes à annuler et à rétablir. */
  | { type: "history"; undo: number; redo: number }
  | MoveMessage;

const send = (message: ToolMessage) => OBR.broadcast.sendMessage(TOOL_CHANNEL, message, { destination: "LOCAL" });
const modeId = (mode: PaintMode) => `${TOOL_ID}/${mode}`;

export async function toolSettings(): Promise<ToolSettings> {
  return parseToolSettings(await OBR.tool.getMetadata(TOOL_ID));
}

export async function setToolSettings(change: Partial<ToolSettings>) {
  if ("erase" in change || "alt" in change) {
    const current = await toolSettings();
    const erase = change.erase ?? current.erase;
    const alt = change.alt ?? current.alt ?? false;
    change = { ...change, erasingNow: erase !== alt };
  }
  await OBR.tool.setMetadata(TOOL_ID, change);
  await send("zone" in change ? { type: "selection", zone: change.zone ?? null } : { type: "settings" });
}

function warn(error: unknown, limits?: { shapes: number; zones: number }) {
  const known = error instanceof ZoneFullError || error instanceof TooManyZonesError || error instanceof ZonesTooLargeError;
  const text =
    error instanceof ZoneFullError
      ? t("tool.zoneFull", { limit: limits?.shapes ?? "" })
      : error instanceof TooManyZonesError
        ? t("tool.tooManyZones", { limit: limits?.zones ?? "" })
        : error instanceof ZonesTooLargeError
          ? t("tool.tooLarge")
          : t("tool.saveError");
  if (!known) console.error("[Tempest!] forme non enregistrée", error);
  // Une limite atteinte en peignant : un message bref suffit. Un échec d'enregistrement reste une alerte.
  if (error instanceof ZoneFullError || error instanceof TooManyZonesError) flash(text, "warning");
  else OBR.notification.show(text, known ? "WARNING" : "ERROR");
}

// --- Annuler et rétablir ----------------------------------------------------------------------

/**
 * Un geste : la zone avant et après. Annuler remet exactement « avant », plutôt que de retirer
 * la dernière forme : si une autre annulation (celle d'Owlbear, une touche répétée) passe en
 * même temps, le résultat reste celui d'avant le geste, sans rien retirer de plus.
 */
interface Step {
  zone: string;
  before: Shape[];
  after: Shape[];
}

const HISTORY_LIMIT = 50;
const past: Step[] = [];
const future: Step[] = [];
const copy = (shapes: Shape[]) => JSON.parse(JSON.stringify(shapes)) as Shape[];

function reportHistory() {
  send({ type: "history", undo: past.length, redo: future.length }).catch(() => {});
}

function remember(step: Step) {
  past.push(step);
  if (past.length > HISTORY_LIMIT) past.shift();
  // Un nouveau geste remplace ce qui pouvait être rétabli.
  future.length = 0;
  reportHistory();
}

/** Applique un état de zone enregistré ; une zone supprimée entre-temps est ignorée. */
async function restore(zone: string, shapes: Shape[]) {
  let found = false;
  await updateZones((data) => {
    const target = data.zones.find((candidate) => candidate.id === zone);
    if (target) {
      target.shapes = copy(shapes);
      found = true;
    }
  });
  return found;
}

async function undo() {
  const step = past.pop();
  if (!step) return;
  try {
    if (await restore(step.zone, step.before)) future.push(step);
  } catch (error) {
    past.push(step);
    warn(error);
  }
  reportHistory();
}

async function redo() {
  const step = future.pop();
  if (!step) return;
  try {
    if (await restore(step.zone, step.after)) past.push(step);
  } catch (error) {
    future.push(step);
    warn(error);
  }
  reportHistory();
}

/** Ajoute la forme à la zone choisie ; sans zone, en crée une. */
async function commit(shape: Shape) {
  const [settings, limits] = await Promise.all([toolSettings(), readLimits()]);
  let created: string | null = null;
  let step: Step | undefined;
  try {
    await updateZones((data) => {
      let zone = data.zones.find((candidate) => candidate.id === settings.zone);
      if (!zone) {
        zone = newZone(t("tool.defaultName", { n: data.zones.length + 1 }), data.zones);
        addZone(data, zone, limits);
        created = zone.id;
      }
      const before = copy(zone.shapes);
      addShape(zone, shape, limits);
      step = { zone: zone.id, before, after: copy(zone.shapes) };
    });
    if (step) remember(step);
    if (created) await setToolSettings({ zone: created });
  } catch (error) {
    warn(error, limits);
  }
}

/** « Vider » une zone, en gardant de quoi l'annuler. */
async function clear(zone: string) {
  let step: Step | undefined;
  await updateZones((data) => {
    const target = data.zones.find((candidate) => candidate.id === zone);
    if (!target?.shapes.length) return;
    step = { zone, before: copy(target.shapes), after: [] };
    target.shapes = [];
  }).catch((error) => warn(error));
  if (step) remember(step);
}

// --- Mode Sommets : modifier les polygones de la zone choisie ------------------------------------

/** Sommets au plus d'un polygone de zone (chacun compte dans la limite de formes de la salle). */
const MAX_POLYGON_POINTS = 64;

const zonePolygons = {
  /** Polygones de la zone choisie ; sans zone choisie, ceux de toutes les zones. Clé : zone / rang. */
  async list() {
    const [data, settings] = await Promise.all([readZones(), toolSettings()]);
    const chosen = data.zones.some((zone) => zone.id === settings.zone) ? data.zones.filter((zone) => zone.id === settings.zone) : data.zones;
    return chosen.flatMap((zone) =>
      zone.shapes.flatMap((shape, i) =>
        shape.t === "g" ? [{ key: `${zone.id}/${i}`, points: shape.p, color: shape.e ? "#ffffff" : zone.color, max: MAX_POLYGON_POINTS }] : [],
      ),
    );
  },
  async save(key: string, points: number[]) {
    const [id, rank] = key.split("/");
    const limits = await readLimits();
    let step: Step | undefined;
    try {
      await updateZones((data) => {
        const zone = data.zones.find((candidate) => candidate.id === id);
        const shape = zone?.shapes[Number(rank)];
        if (!zone || shape?.t !== "g") return;
        const before = copy(zone.shapes);
        shape.p = points;
        if (zoneCost(zone) > limits.shapes) throw new ZoneFullError();
        step = { zone: zone.id, before, after: copy(zone.shapes) };
      });
      if (step) remember(step);
    } catch (error) {
      warn(error, limits);
    }
  },
  undo: () => shortcut("undo"),
  redo: () => shortcut("redo"),
  watch(callback: () => void) {
    const stops = [
      onZonesChange(callback),
      // Autre zone choisie dans la palette : ses polygones à elle.
      OBR.broadcast.onMessage(TOOL_CHANNEL, ({ data }) => {
        if ((data as ToolMessage).type === "selection") callback();
      }),
    ];
    return () => stops.forEach((stop) => stop());
  },
};

// --- Tracé en direct -------------------------------------------------------------------------

interface Drawing {
  mode: PaintMode;
  /** Peindre ou effacer d'après la palette, sans Alt */
  baseErase: boolean;
  /** Mode actuel, Alt compris : c'est lui qui compte quand le tracé se termine */
  erase: boolean;
  color: string;
  from: Point;
  points: Point[];
  radius: number;
  update?: (change: (draft: Item) => void) => void;
  stop?: () => void;
}

let drawing: Drawing | null = null;
/** Le prochain clic du polygone le fermerait : l'anneau du premier point s'allume. */
let closing = false;
/** Zoom au début du polygone : la distance de fermeture se mesure à l'écran. */
let polygonScale = 1;
const RING_ID = `${PLUGIN_ID}/anneau-polygone`;

/** Anneau autour du premier point du polygone, discret, puis plein quand un clic le fermerait. */
function ringItem(center: Point, lit: boolean, color: string) {
  const size = (lit ? 22 : 14) / polygonScale;
  return buildShape()
    .id(RING_ID)
    .shapeType("CIRCLE")
    .width(size)
    .height(size)
    .position(center)
    .fillColor(color)
    .fillOpacity(lit ? 0.9 : 0)
    .strokeColor(lit ? "#ffffff" : color)
    .strokeOpacity(1)
    .strokeWidth(2 / polygonScale)
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
}

let ringColor = "#4f9dff";

function showRing(center: Point | null, lit: boolean) {
  const work = center
    ? OBR.scene.local.deleteItems([RING_ID]).then(() => OBR.scene.local.addItems([ringItem(center, lit, ringColor)]))
    : OBR.scene.local.deleteItems([RING_ID]);
  work.catch(() => {});
}

/** Anneau en pointillés qui suit le pointeur au pinceau : la taille du pinceau, avant de peindre. */
const BRUSH_RING_ID = `${PLUGIN_ID}/anneau-pinceau`;
/** Réglages du pinceau gardés sous la main : le pointeur bouge trop vite pour les relire. */
let brush: { settings: ToolSettings; unit: number; color: string } | undefined;
let brushRing: { at: number; radius: number; stroke: string } | undefined;

async function refreshBrush() {
  const [settings, unit] = await Promise.all([toolSettings(), OBR.scene.grid.getDpi()]);
  brush = { settings, unit, color: await zoneColor(settings) };
}

function showBrushRing(point: Point) {
  if (!brush) return;
  const { settings, unit, color } = brush;
  const radius = (settings.size * unit) / 2;
  const erase = erasing(settings, altDown);
  const stroke = erase ? "#ffffff" : color;
  const now = performance.now();
  if (brushRing && now - brushRing.at < 30) return;
  // Même taille et même couleur : on déplace l'anneau plutôt que de le recréer.
  if (brushRing && brushRing.radius === radius && brushRing.stroke === stroke) {
    brushRing.at = now;
    OBR.scene.local
      .updateItems([BRUSH_RING_ID], (items) => {
        for (const item of items) item.position = point;
      }, true)
      .catch(() => {});
    return;
  }
  const item = buildShape()
    .id(BRUSH_RING_ID)
    .shapeType("CIRCLE")
    .width(radius * 2)
    .height(radius * 2)
    .position(point)
    .fillOpacity(0)
    .strokeColor(stroke)
    .strokeOpacity(0.9)
    .strokeWidth(Math.max(1.5, unit * 0.03))
    .strokeDash([unit * 0.1, unit * 0.08])
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
  brushRing = { at: now, radius, stroke };
  OBR.scene.local.deleteItems([BRUSH_RING_ID]).then(() => OBR.scene.local.addItems([item])).catch(() => {});
}

function hideBrushRing() {
  brushRing = undefined;
  OBR.scene.local.deleteItems([BRUSH_RING_ID]).catch(() => {});
}

function setClosing(value: boolean) {
  if (closing === value) return;
  closing = value;
  if (drawing?.mode === "polygon") showRing(drawing.points[0], value);
}

async function zoneColor(settings: ToolSettings) {
  const zones = await readZones();
  return zones.zones.find((zone) => zone.id === settings.zone)?.color ?? "#4f9dff";
}

/** Couleurs de l'aperçu : celles de la zone pour peindre, blanc en pointillés pour effacer. */
function previewStyle(mode: PaintMode, erase: boolean, color: string) {
  return {
    fillColor: erase ? "#000000" : color,
    fillOpacity: mode === "brush" ? 0 : erase ? 0.35 : 0.3,
    strokeColor: erase ? "#ffffff" : color,
    strokeOpacity: mode === "brush" ? 0.5 : 0.95,
    strokeDash: erase ? [12, 8] : [],
  };
}

function previewItem(drawn: Drawing): Item {
  const { mode, from, radius, erase, color } = drawn;
  const style = previewStyle(mode, erase, color);
  const builder =
    mode === "rect" || mode === "circle"
      ? buildShape().shapeType(mode === "rect" ? "RECTANGLE" : "CIRCLE").width(0).height(0).position(from)
      : buildCurve()
          .points([{ x: 0, y: 0 }])
          .position(from)
          .tension(0)
          .closed(false)
          .strokeWidth(mode === "brush" ? radius * 2 : 3);
  return builder
    .fillColor(style.fillColor)
    .fillOpacity(style.fillOpacity)
    .strokeColor(style.strokeColor)
    .strokeOpacity(style.strokeOpacity)
    .strokeDash(style.strokeDash)
    .layer("CONTROL")
    .locked(true)
    .disableHit(true)
    .build();
}

async function startDrawing(mode: PaintMode, from: Point, altKey: boolean) {
  const [settings, unit] = await Promise.all([toolSettings(), OBR.scene.grid.getDpi()]);
  const current: Drawing = {
    mode,
    from,
    points: [from],
    radius: (settings.size * unit) / 2,
    baseErase: settings.erase,
    erase: erasing(settings, altKey),
    color: await zoneColor(settings),
  };
  drawing = current;
  const [update, stop] = await OBR.interaction.startItemInteraction(previewItem(current));
  // Le geste a pu finir pendant l'attente : on n'affiche rien.
  if (drawing !== current) {
    stop();
    return;
  }
  current.update = update as Drawing["update"];
  current.stop = stop;
}

/** Met l'aperçu à jour ; pour le polygone, `point` est le sommet suivi par la souris. */
function updatePreview(point: Point) {
  const current = drawing;
  if (!current) return;
  const { mode, from } = current;
  current.update?.((draft) => {
    const item = draft as Item & { points?: Point[]; width?: number; height?: number; closed?: boolean };
    if (mode === "rect") {
      item.position = { x: Math.min(from.x, point.x), y: Math.min(from.y, point.y) };
      item.width = Math.abs(point.x - from.x);
      item.height = Math.abs(point.y - from.y);
    } else if (mode === "circle") {
      const diameter = Math.hypot(point.x - from.x, point.y - from.y) * 2;
      item.width = diameter;
      item.height = diameter;
    } else {
      // Près du premier point, l'aperçu montre déjà le polygone fermé.
      const points = mode === "polygon" ? (closing ? current.points : [...current.points, point]) : current.points;
      item.points = points.map((p) => ({ x: p.x - from.x, y: p.y - from.y }));
      if (mode === "polygon") item.closed = points.length >= 3;
    }
  });
}

/** Alt enfoncé ou relâché en plein tracé : le tracé change de mode, et son aperçu de style. */
function setDrawingErase(alt: boolean) {
  const current = drawing;
  if (!current) return;
  const erase = current.baseErase !== alt;
  if (erase === current.erase) return;
  current.erase = erase;
  const style = previewStyle(current.mode, erase, current.color);
  current.update?.((draft) => {
    const item = draft as Item & { style?: Record<string, unknown> };
    if (item.style) Object.assign(item.style, style);
  });
  if (current.mode === "polygon") {
    ringColor = erase ? "#ffffff" : current.color;
    showRing(current.points[0], closing);
  }
}

function stopDrawing() {
  const current = drawing;
  drawing = null;
  closing = false;
  if (current?.mode === "polygon") showRing(null, false);
  current?.stop?.();
  return current;
}

/** Le mode retenu est celui du moment où le tracé se termine, Alt compris. */
async function finishDrag(point: Point | null, altKey = false) {
  const current = stopDrawing();
  if (!current || !point) return;
  const { mode, from } = current;
  const erase = current.baseErase !== altKey;
  const shape =
    mode === "rect"
      ? rectShape(from, point, erase)
      : mode === "circle"
        ? circleShape(from, point, erase)
        : strokeShape(addPoint(current.points, point, current.radius), current.radius, erase);
  if (shape) await commit(shape);
}

async function finishPolygon(altKey = altDown) {
  const current = stopDrawing();
  if (current?.mode !== "polygon") return;
  const shape = polygonShape(current.points, current.baseErase !== altKey);
  if (shape) await commit(shape);
}

/** Distance au premier point, en pixels à l'écran, qui ferme le polygone. */
const CLOSE_DISTANCE = 12;

/** La souris bouge pendant un polygone : curseur de fermeture et aperçu. */
function polygonMove(point: Point) {
  if (drawing?.mode !== "polygon") return;
  setClosing(closesPolygon(drawing.points, point, CLOSE_DISTANCE / polygonScale));
  updatePreview(point);
}

/** Un clic du polygone : le premier le commence, un clic sur le premier point le ferme. */
async function polygonClick(point: Point, altKey: boolean) {
  if (drawing?.mode !== "polygon") {
    polygonScale = await OBR.viewport.getScale();
    const settings = await toolSettings();
    ringColor = erasing(settings, altKey) ? "#ffffff" : await zoneColor(settings);
    await startDrawing("polygon", point, altKey);
    showRing(point, false);
    return;
  }
  if (closesPolygon(drawing.points, point, CLOSE_DISTANCE / polygonScale)) await finishPolygon(altKey);
  else {
    drawing.points.push(point);
    updatePreview(point);
  }
}

// --- Palette : fenêtre flottante -----------------------------------------------------------------

/** Créée par setupTool : la palette importe ce fichier, elle ne doit pas en créer une. */
let palette: ReturnType<typeof floatingWindow>;
const createPalette = () =>
  floatingWindow({
    id: PALETTE_ID,
    url: "/palette.html",
    width: PALETTE_WIDTH,
    frameId: PALETTE_FRAME_ID,
    storageKey: "tempest/palette",
    // La palette vient de s'ouvrir : elle doit savoir ce que « Rétablir » peut remettre.
    onOpened: () => setTimeout(reportHistory, 400),
  });
const openPalette = () => palette.open();

/** Une action à la fois. */
let queue = Promise.resolve();
const enqueue = (work: () => Promise<void>) => {
  queue = queue.then(work).catch((error) => console.error("[Tempest!]", error));
};

function handleMessage(message: ToolMessage) {
  if (message.type === "settings" || message.type === "selection") refreshBrush().catch(() => {});
  if (palette.handle(message)) return;
  if (message.type === "undo") enqueue(undo);
  else if (message.type === "redo") enqueue(redo);
  else if (message.type === "clear") enqueue(() => clear(message.zone));
}

// --- Outil, modes et action « Peindre / Effacer » ------------------------------------------------

const ICONS: Record<PaintMode, string> = {
  brush: "pinceau",
  rect: "rectangle",
  circle: "cercle",
  polygon: "polygone",
};

const erasingFilter: KeyFilter[] = [{ key: "erasingNow", value: true }];
const paintingFilter: KeyFilter[] = [{ key: "erasingNow", value: true, operator: "!=" }];

/** Alt suivi au clavier, pour que le mode affiché change le temps de l'appui. */
let altDown = false;
function setAlt(value: boolean) {
  setDrawingErase(value);
  if (altDown === value) return;
  altDown = value;
  setToolSettings({ alt: value }).catch(() => {});
}

/**
 * Un même raccourci reçu deux fois de suite (moins de 250 ms) ne compte qu'une fois : sinon
 * « Rétablir » pouvait remettre deux gestes d'un seul appui.
 */
let lastShortcut = { action: "", at: 0 };
function shortcut(action: "undo" | "redo") {
  const now = performance.now();
  if (lastShortcut.action === action && now - lastShortcut.at < 250) {
    console.info(`[Tempest!] raccourci ${action} reçu deux fois, ignoré`);
    return;
  }
  lastShortcut = { action, at: now };
  enqueue(action === "undo" ? undo : redo);
}

export function setupTool() {
  palette = createPalette();
  flashInto(palette);
  const gmOnly = { roles: ["GM" as const] };
  const whenActive = { activeTools: [TOOL_ID], roles: ["GM" as const] };
  OBR.tool.create({
    id: TOOL_ID,
    icons: [{ icon: "/tool/zones.svg", label: t("tool.name"), filter: gmOnly }],
    disabled: { roles: ["PLAYER"] },
    defaultMode: modeId("brush"),
    defaultMetadata: { ...DEFAULT_TOOL_SETTINGS },
  });

  // Peindre ou effacer : l'icône montre l'état actuel, un clic l'inverse.
  OBR.tool.createAction({
    id: `${TOOL_ID}/effacer`,
    icons: [
      { icon: "/tool/peindre.svg", label: t("tool.painting"), filter: { ...whenActive, metadata: paintingFilter } },
      { icon: "/tool/effacer.svg", label: t("tool.erasing"), filter: { ...whenActive, metadata: erasingFilter } },
    ],
    async onClick() {
      const settings = await toolSettings();
      await setToolSettings({ erase: !settings.erase });
      await refreshBrush();
    },
  });

  for (const mode of PAINT_MODES) {
    OBR.tool.createMode({
      id: modeId(mode),
      // En mode Effacer, chaque forme prend un signe « moins ».
      icons: [
        { icon: `/tool/${ICONS[mode]}.svg`, label: t(`tool.${mode}`), filter: { ...whenActive, metadata: paintingFilter } },
        { icon: `/tool/${ICONS[mode]}-effacer.svg`, label: t(`tool.${mode}Erase`), filter: { ...whenActive, metadata: erasingFilter } },
      ],
      cursors: [{ cursor: "crosshair" }],
      ...(mode === "polygon"
        ? {
            async onToolClick(_context, event) {
              await polygonClick(event.pointerPosition, event.altKey);
              return false;
            },
            async onToolDoubleClick(_context, event) {
              await finishPolygon(event.altKey);
              return false;
            },
            onToolMove(_context, event) {
              if (drawing?.mode === "polygon") setAlt(event.altKey);
              polygonMove(event.pointerPosition);
            },
            onDeactivate() {
              stopDrawing();
            },
          }
        : {
            ...(mode === "brush"
              ? {
                  onToolMove(_context: unknown, event: { pointerPosition: Point }) {
                    showBrushRing(event.pointerPosition);
                  },
                  onDeactivate() {
                    hideBrushRing();
                  },
                }
              : {}),
            onToolDragStart(_context, event) {
              // Alt relâché hors de la carte : on recale l'affichage sur l'état réel.
              setAlt(event.altKey);
              startDrawing(mode, event.pointerPosition, event.altKey).catch(console.error);
            },
            onToolDragMove(_context, event) {
              // Alt peut changer en plein tracé : l'événement de la souris fait foi.
              setAlt(event.altKey);
              if (drawing && (drawing.mode === "brush")) {
                addPoint(drawing.points, event.pointerPosition, drawing.radius);
                showBrushRing(event.pointerPosition);
              }
              updatePreview(event.pointerPosition);
            },
            onToolDragEnd(_context, event) {
              finishDrag(event.pointerPosition, event.altKey).catch(console.error);
            },
            onToolDragCancel() {
              finishDrag(null).catch(console.error);
            },
            // Un simple clic au pinceau pose un rond de la taille du pinceau.
            async onToolClick(_context, event) {
              if (mode !== "brush") return false;
              const [settings, unit] = await Promise.all([toolSettings(), OBR.scene.grid.getDpi()]);
              const shape = strokeShape([event.pointerPosition], (settings.size * unit) / 2, erasing(settings, event.altKey));
              if (shape) await commit(shape);
              return false;
            },
          }),
      onKeyDown(_context, event) {
        // Une touche maintenue se répète : un seul geste annulé par appui.
        if (event.repeat) return;
        const key = event.key.toLowerCase();
        if (event.key === "Alt") setAlt(true);
        else if ((event.ctrlKey || event.metaKey) && key === "z") shortcut(event.shiftKey ? "redo" : "undo");
        else if ((event.ctrlKey || event.metaKey) && key === "y") shortcut("redo");
        else if (mode === "polygon" && drawing?.mode === "polygon") {
          if (event.key === "Enter") finishPolygon(altDown).catch(console.error);
          else if (event.key === "Escape") stopDrawing();
          else if (event.key === "Backspace" && drawing.points.length > 1) drawing.points.pop();
        }
      },
      onKeyUp(_context, event) {
        if (event.key === "Alt") setAlt(false);
      },
      onActivate() {
        if (mode === "brush") refreshBrush().catch(() => {});
        enqueue(openPalette);
      },
    });
  }

  createVertexMode({
    toolId: TOOL_ID,
    modeId: `${TOOL_ID}/sommets`,
    icon: "/tool/sommets.svg",
    label: t("vertices.mode"),
    filter: whenActive,
    source: zonePolygons,
    onActivate: () => enqueue(openPalette),
  });

  // La palette reste ouverte tant que l'outil est actif.
  OBR.tool.onToolChange((id) => {
    if (id !== TOOL_ID) {
      stopDrawing();
      hideBrushRing();
      setAlt(false);
      palette.close();
    }
  });

  OBR.broadcast.onMessage(TOOL_CHANNEL, ({ data }) => handleMessage(data as ToolMessage));
}
