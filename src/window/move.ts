// Fenêtre déplaçable, reprise de Hidden Ink avec ses corrections. Owlbear ne sait pas déplacer
// une fenêtre ouverte : pendant le glissement, un cadre dessiné sur la carte montre où elle va,
// puis la page de fond la rouvre à sa nouvelle place.
//
// Pièges déjà rencontrés, et gérés ici :
// - la souris sort de la fenêtre : capture du pointeur, et écoute sur toute la page ;
// - le relâchement n'arrive jamais (capture perdue, bouton déjà relâché) : on pose la fenêtre
//   là où elle était suivie, ou après un délai sans mouvement ;
// - la fenêtre disparaît en plein glissement : la page de fond retire le cadre sans nouvelles.

import OBR, { buildShape, type Item, type Vector2 } from "@owlbear-rodeo/sdk";

/** Environ 30 mises à jour par seconde : fluide, sans inonder Owlbear. */
const SEND_INTERVAL_MS = 33;
/** Plus aucun mouvement reçu pendant ce délai : on pose la fenêtre. */
export const DRAG_IDLE_RELEASE_MS = 2500;
/** Signal de vie pendant un glissement, même si la souris ne bouge plus. */
export const DRAG_HEARTBEAT_MS = 400;
/** Sans nouvelle de la fenêtre pendant ce délai, la page de fond abandonne le glissement. */
export const DRAG_TIMEOUT_MS = 2000;
const MARGIN = 8;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Garde une fenêtre entièrement visible, avec la même marge qu'Owlbear à l'ouverture. */
export function clampPosition(rect: Rect, viewportWidth: number, viewportHeight: number) {
  return {
    left: Math.max(MARGIN, Math.min(rect.left, viewportWidth - rect.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(rect.top, viewportHeight - rect.height - MARGIN)),
  };
}

interface PointerHandlers {
  onMove: (dx: number, dy: number) => void;
  onEnd: (dx: number, dy: number) => void;
  onCancel: () => void;
}

/** Suit un glissement depuis `handle`, même hors de la fenêtre. Les boutons du titre restent cliquables. */
export function trackPointer(handle: HTMLElement, handlers: PointerHandlers, idleReleaseMs = DRAG_IDLE_RELEASE_MS) {
  /** Glissement resté ouvert parce que le relâchement n'a jamais été reçu. */
  let abandon: (() => void) | undefined;
  handle.addEventListener("pointerdown", (start) => {
    if ((start.target as HTMLElement).closest("button, a, input, select")) return;
    abandon?.();
    start.preventDefault();
    handle.setPointerCapture(start.pointerId);
    document.body.classList.add("dragging");
    let lastSent = 0;
    let lastEvent = performance.now();
    let done = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let latest = { dx: 0, dy: 0 };
    const isOurs = (event: PointerEvent) => event.pointerId === start.pointerId;
    const delta = (event: PointerEvent) => ({ dx: event.screenX - start.screenX, dy: event.screenY - start.screenY });

    const flush = () => {
      pending = undefined;
      lastSent = performance.now();
      handlers.onMove(latest.dx, latest.dy);
    };
    const move = (event: PointerEvent) => {
      if (!isOurs(event)) return;
      lastEvent = performance.now();
      // Bouton déjà relâché : le navigateur n'a pas transmis le relâchement.
      if (event.buttons === 0) {
        release("bouton déjà relâché");
        return;
      }
      latest = delta(event);
      if (pending !== undefined) return;
      // Le dernier mouvement part toujours, même si la souris s'arrête juste après.
      const wait = SEND_INTERVAL_MS - (performance.now() - lastSent);
      if (wait <= 0) flush();
      else pending = setTimeout(flush, wait);
    };
    const finish = () => {
      done = true;
      abandon = undefined;
      clearTimeout(pending);
      clearInterval(watchdog);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      handle.removeEventListener("lostpointercapture", lost);
      document.body.classList.remove("dragging");
    };
    const release = (reason?: string) => {
      if (done) return;
      finish();
      if (reason) console.warn(`[Tempest!] glissement terminé sans relâchement reçu : ${reason}`);
      handlers.onEnd(latest.dx, latest.dy);
    };
    const up = (event: PointerEvent) => {
      if (!isOurs(event)) return;
      latest = delta(event);
      release();
    };
    const lost = () => release("capture perdue");
    const cancel = () => {
      if (done) return;
      finish();
      handlers.onCancel();
    };
    const watchdog = setInterval(() => {
      if (!handle.hasPointerCapture(start.pointerId)) release("capture absente");
      else if (performance.now() - lastEvent > idleReleaseMs) release("plus aucun mouvement reçu");
    }, 200);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    handle.addEventListener("lostpointercapture", lost);
    abandon = cancel;
  });
}

const warn = (error: unknown) => console.warn("[Tempest!] cadre de déplacement :", error);

/** Cadre dessiné sur la carte pendant un glissement, piloté directement par la fenêtre. */
export function startFrame(id: string, origin: Rect, color: string) {
  let drawn: { item: Item; position: Vector2; scale: number; width: number; height: number } | undefined;
  let latest: { dx: number; dy: number } | undefined;

  const move = (dx: number, dy: number) => {
    latest = { dx, dy };
    if (!drawn) return;
    const placed = clampPosition({ ...origin, left: origin.left + dx, top: origin.top + dy }, drawn.width, drawn.height);
    const position = {
      x: drawn.position.x + (placed.left - origin.left) / drawn.scale,
      y: drawn.position.y + (placed.top - origin.top) / drawn.scale,
    };
    const previous = drawn.item;
    drawn.item = { ...previous, position };
    OBR.scene.local
      .updateItems([previous], (items) => {
        items[0].position = position;
      }, true)
      .catch(warn);
  };

  const ready = (async () => {
    await OBR.scene.local.deleteItems([id]).catch(warn);
    const [width, height, scale] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight(), OBR.viewport.getScale()]);
    const position = await OBR.viewport.inverseTransformPoint({ x: origin.left, y: origin.top });
    const item = buildShape()
      .id(id)
      .shapeType("RECTANGLE")
      .width(origin.width / scale)
      .height(origin.height / scale)
      .position(position)
      .fillColor(color)
      .fillOpacity(0.2)
      .strokeColor(color)
      .strokeOpacity(1)
      .strokeWidth(3 / scale)
      .layer("POPOVER")
      .locked(true)
      .disableHit(true)
      .build();
    await OBR.scene.local.addItems([item]);
    drawn = { item, position, scale, width, height };
    if (latest) move(latest.dx, latest.dy);
  })().catch(warn);

  return {
    move,
    /** Attend la fin de la création : un relâchement très rapide ne laisse rien derrière lui. */
    async remove() {
      await ready;
      drawn = undefined;
      await OBR.scene.local.deleteItems([id]).catch(warn);
    },
  };
}
