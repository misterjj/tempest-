// Mode « Sommets », commun aux outils de l'extension : modifier un polygone déjà tracé.
// - Glisser un sommet le déplace.
// - Glisser depuis un côté (ou son milieu, marqué d'un petit rond) y ajoute un sommet, qu'on place
//   en relâchant ; un simple clic sur un côté ajoute le sommet là.
// - Alt + clic, double-clic, ou Suppr / Retour arrière sur un sommet survolé le retire.
// Les poignées sont des éléments locaux, que seul le MJ voit.

import OBR, { buildCurve, buildShape, type Item, type ToolFilter } from "@owlbear-rodeo/sdk";
import { t } from "../i18n";
import { flash } from "./flash";
import type { Point } from "./drawing";
import { hitVertex, insertVertex, midpoints, moveVertex, removeVertex, type EditablePolygon, type VertexHit } from "./vertices";

export interface VertexSource {
  /** Polygones modifiables en ce moment */
  list(): Promise<EditablePolygon[]>;
  /** Enregistre le nouveau contour (avec annuler) ; prévient lui-même le MJ en cas d'échec */
  save(key: string, points: number[]): Promise<void>;
  undo(): void;
  redo(): void;
  /** Appelé quand les polygones ont pu changer ; renvoie de quoi se désabonner */
  watch(callback: () => void): () => void;
}

interface VertexModeOptions {
  toolId: string;
  modeId: string;
  icon: string;
  label: string;
  filter: ToolFilter;
  source: VertexSource;
  /** En plus, quand le mode s'active (la palette de l'outil, par exemple) */
  onActivate?: () => void;
}

/** Sommet en cours de glissé : `base` est le contour au départ (sommet ajouté compris). */
interface VertexDrag {
  polygon: EditablePolygon;
  index: number;
  base: number[];
  points: number[];
  update?: (change: (item: Item) => void) => void;
  stop?: () => void;
  done?: boolean;
}

/** Taille des poignées et distance de prise, en pixels à l'écran. */
const HANDLE = 11;
const MIDPOINT = 7;
const GRAB = 10;
/** Un double-clic juste après un clic qui a ajouté un sommet ne doit pas le retirer aussitôt. */
const DOUBLE_CLICK_GRACE = 600;

export function createVertexMode({ toolId, modeId, icon, label, filter, source, onActivate }: VertexModeOptions) {
  const prefix = `${modeId}/poignee/`;
  let active = false;
  let polygons: EditablePolygon[] = [];
  let shown = "";
  let handleIds: string[] = [];
  let scale = 1;
  let hovered: VertexHit | null = null;
  let lastInsert = { key: "", index: -1, at: 0 };
  let unwatch: (() => void) | undefined;
  let drag: VertexDrag | undefined;

  // Une mise à jour des poignées à la fois, dans l'ordre.
  let queue = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error) => console.error("[Tempest!]", error));
    return queue;
  };

  function handleItems() {
    const items: Item[] = [];
    let n = 0;
    for (const polygon of polygons) {
      const vertices: Point[] = [];
      for (let i = 0; i < polygon.points.length; i += 2) vertices.push({ x: polygon.points[i], y: polygon.points[i + 1] });
      for (const at of midpoints(polygon.points)) {
        items.push(
          buildShape()
            .id(`${prefix}${n++}`)
            .shapeType("CIRCLE")
            .width(MIDPOINT / scale)
            .height(MIDPOINT / scale)
            .position(at)
            .fillColor(polygon.color)
            .fillOpacity(0.55)
            .strokeWidth(0)
            .layer("CONTROL")
            .locked(true)
            .disableHit(true)
            .build(),
        );
      }
      for (const at of vertices) {
        items.push(
          buildShape()
            .id(`${prefix}${n++}`)
            .shapeType("CIRCLE")
            .width(HANDLE / scale)
            .height(HANDLE / scale)
            .position(at)
            .fillColor("#ffffff")
            .fillOpacity(1)
            .strokeColor(polygon.color)
            .strokeOpacity(1)
            .strokeWidth(2.5 / scale)
            .layer("CONTROL")
            .locked(true)
            .disableHit(true)
            .build(),
        );
      }
    }
    return items;
  }

  async function clearHandles() {
    if (!handleIds.length) return;
    const ids = handleIds;
    handleIds = [];
    shown = "";
    await OBR.scene.local.deleteItems(ids);
  }

  /** Relit les polygones et redessine les poignées si quelque chose a changé (zoom compris). */
  const refresh = () =>
    enqueue(async () => {
      if (!active || drag) return;
      [polygons, scale] = await Promise.all([source.list(), OBR.viewport.getScale()]);
      if (!active || drag) return;
      const key = JSON.stringify([polygons, Math.round(scale * 100)]);
      if (key === shown) return;
      await clearHandles();
      const items = handleItems();
      handleIds = items.map((item) => item.id);
      shown = key;
      if (items.length) await OBR.scene.local.addItems(items);
    });

  const tolerance = () => GRAB / scale;

  async function save(polygon: EditablePolygon, points: number[]) {
    await source.save(polygon.key, points);
    shown = "";
    await refresh();
  }

  async function remove(hit: VertexHit) {
    if (hit.kind !== "vertex") return;
    const points = removeVertex(hit.polygon.points, hit.index);
    if (!points) {
      flash(t("vertices.minimum"));
      return;
    }
    hovered = null;
    await save(hit.polygon, points);
  }

  function insert(hit: VertexHit & { kind: "edge" }) {
    const points = insertVertex(hit.polygon.points, hit.index, hit.at, hit.polygon.max);
    if (!points) {
      flash(t("vertices.full", { n: hit.polygon.max }));
      return null;
    }
    return points;
  }

  function outline(points: number[], color: string): Item {
    const vertices: Point[] = [];
    for (let i = 0; i < points.length; i += 2) vertices.push({ x: points[i], y: points[i + 1] });
    return buildCurve()
      .points(vertices)
      .position({ x: 0, y: 0 })
      .tension(0)
      .closed(true)
      .fillOpacity(0)
      .strokeColor(color)
      .strokeOpacity(1)
      .strokeWidth(2.5 / scale)
      .strokeDash([8 / scale, 6 / scale])
      .layer("CONTROL")
      .locked(true)
      .disableHit(true)
      .build();
  }

  /** Synchrone jusqu'à la création du geste : un glissé très court peut finir avant la suite. */
  function startDrag(point: Point) {
    if (drag) return;
    const hit = hitVertex(polygons, point, tolerance());
    if (!hit) return;
    let points = hit.polygon.points;
    let index = hit.index;
    if (hit.kind === "edge") {
      const inserted = insert(hit);
      if (!inserted) return;
      points = inserted;
      index = hit.index + 1;
    }
    const current: VertexDrag = { polygon: hit.polygon, index, base: points, points };
    drag = current;
    // Dans la file : la remise des poignées, à la fin du geste, passera forcément après.
    enqueue(clearHandles);
    OBR.interaction
      .startItemInteraction(outline(points, hit.polygon.color))
      .then(([update, stop]) => {
        if (current.done) return stop();
        current.update = update as VertexDrag["update"];
        current.stop = stop;
      })
      .catch(console.error);
  }

  function moveDrag(point: Point) {
    const current = drag;
    if (!current) return;
    current.points = moveVertex(current.base, current.index, point);
    current.update?.((item) => {
      const curve = item as Item & { points: Point[] };
      const vertices: Point[] = [];
      for (let i = 0; i < current.points.length; i += 2) vertices.push({ x: current.points[i], y: current.points[i + 1] });
      curve.points = vertices;
    });
  }

  function endDrag(point: Point | null) {
    const current = drag;
    drag = undefined;
    if (!current) return;
    current.done = true;
    current.stop?.();
    if (point) {
      const points = moveVertex(current.base, current.index, point);
      save(current.polygon, points).catch(console.error);
    } else {
      shown = "";
      refresh();
    }
  }

  function stop() {
    active = false;
    endDrag(null);
    unwatch?.();
    unwatch = undefined;
    hovered = null;
    enqueue(clearHandles);
  }

  OBR.tool.createMode({
    id: modeId,
    icons: [{ icon, label, filter }],
    cursors: [{ cursor: "pointer" }],
    onActivate() {
      active = true;
      shown = "";
      unwatch?.();
      unwatch = source.watch(() => refresh());
      refresh();
      onActivate?.();
    },
    onDeactivate() {
      stop();
    },
    onToolMove(_context, event) {
      if (drag) return;
      const hit = hitVertex(polygons, event.pointerPosition, tolerance());
      hovered = hit?.kind === "vertex" ? hit : null;
      // Le zoom a pu changer : les poignées gardent leur taille à l'écran.
      OBR.viewport.getScale().then((value) => {
        if (Math.abs(value - scale) / scale > 0.15) refresh();
      });
    },
    onToolDragStart(_context, event) {
      startDrag(event.pointerPosition);
    },
    onToolDragMove(_context, event) {
      moveDrag(event.pointerPosition);
    },
    onToolDragEnd(_context, event) {
      endDrag(event.pointerPosition);
    },
    onToolDragCancel() {
      endDrag(null);
    },
    async onToolClick(_context, event) {
      await queue;
      const hit = hitVertex(polygons, event.pointerPosition, tolerance());
      if (!hit) return false;
      if (hit.kind === "vertex") {
        if (event.altKey) await remove(hit);
        return false;
      }
      const points = insert(hit);
      if (points) {
        lastInsert = { key: hit.polygon.key, index: hit.index + 1, at: performance.now() };
        await save(hit.polygon, points);
      }
      return false;
    },
    async onToolDoubleClick(_context, event) {
      await queue;
      const hit = hitVertex(polygons, event.pointerPosition, tolerance());
      if (hit?.kind !== "vertex") return false;
      const fresh = lastInsert.key === hit.polygon.key && lastInsert.index === hit.index && performance.now() - lastInsert.at < DOUBLE_CLICK_GRACE;
      if (!fresh) await remove(hit);
      return false;
    },
    onKeyDown(_context, event) {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") (event.shiftKey ? source.redo : source.undo)();
      else if ((event.ctrlKey || event.metaKey) && key === "y") source.redo();
      else if (event.key === "Escape") endDrag(null);
      else if ((event.key === "Delete" || event.key === "Backspace") && hovered) remove(hovered).catch(console.error);
    },
  });

  OBR.tool.onToolChange((id) => {
    if (id !== toolId && active) stop();
  });
}
