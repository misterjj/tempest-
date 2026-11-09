// Fenêtre flottante d'un outil (palette), côté page de fond : ouverture à la dernière place
// connue, déplacement (la fenêtre envoie ses messages, voir window/move.ts), fermeture.
// Owlbear ne déplace pas une fenêtre ouverte : on la rouvre ailleurs.

import OBR from "@owlbear-rodeo/sdk";
import { DRAG_TIMEOUT_MS, clampPosition } from "./move";

/** Messages de déplacement, de la fenêtre vers la page de fond. */
export type MoveMessage =
  | { type: "drag-start"; dragId: string }
  | { type: "drag-alive"; dragId: string }
  | { type: "drag-cancel"; dragId: string }
  | { type: "move"; dragId: string; dx: number; dy: number; height: number }
  /** Fermée par son bouton : les messages brefs repassent en alertes. */
  | { type: "closed" };

interface FloatingOptions {
  id: string;
  /** Page, sans paramètres : la position s'y ajoute */
  url: string;
  width: number;
  frameId: string;
  /** Position gardée dans le navigateur */
  storageKey: string;
  /** Appelé après chaque ouverture */
  onOpened?: () => void;
}

export function floatingWindow({ id, url, width, frameId, storageKey, onOpened }: FloatingOptions) {
  let place = { left: 72, top: 72, height: 520 };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) place = { ...place, left: saved.left, top: saved.top };
  } catch {
    // Position perdue : la fenêtre s'ouvre à sa place par défaut.
  }
  let isOpen = false;
  let activeDrag: string | undefined;
  let lastDragSignal = 0;

  /** Une action à la fois : la fenêtre ne doit pas être rouverte deux fois en même temps. */
  let queue = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((error) => console.error("[Tempest!]", error));
    return queue;
  };

  async function show() {
    const [viewWidth, viewHeight] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
    const height = Math.min(place.height, viewHeight - 16);
    const placed = clampPosition({ left: place.left, top: place.top, width, height }, viewWidth, viewHeight);
    place = { ...place, ...placed };
    await OBR.popover.open({
      id,
      url: `${url}?left=${placed.left}&top=${placed.top}`,
      width,
      height,
      anchorReference: "POSITION",
      anchorPosition: placed,
      anchorOrigin: { horizontal: "LEFT", vertical: "TOP" },
      transformOrigin: { horizontal: "LEFT", vertical: "TOP" },
      disableClickAway: true,
      marginThreshold: 8,
    });
    isOpen = true;
    onOpened?.();
  }

  const removeFrame = () => OBR.scene.local.deleteItems([frameId]).catch(() => {});

  // Fenêtre disparue en plein déplacement : le cadre ne reste pas à l'écran.
  setInterval(() => {
    if (activeDrag && Date.now() - lastDragSignal > DRAG_TIMEOUT_MS) {
      activeDrag = undefined;
      enqueue(removeFrame);
    }
  }, 500);
  // Cadre laissé par une version précédente de cette page.
  OBR.scene.isReady().then((ready) => (ready ? removeFrame() : undefined)).catch(() => {});

  return {
    get isOpen() {
      return isOpen;
    },
    open: () => enqueue(show),
    close: () =>
      enqueue(async () => {
        isOpen = false;
        await OBR.popover.close(id).catch(() => {});
      }),
    /** Traite un message de déplacement ; renvoie faux si ce n'en est pas un. */
    handle(message: { type: string }) {
      const move = message as MoveMessage;
      // Traité dès la réception : la file peut être occupée par l'action précédente.
      if (move.type === "drag-start" || move.type === "drag-alive") {
        activeDrag = move.dragId;
        lastDragSignal = Date.now();
      } else if (move.type === "closed") {
        isOpen = false;
      } else if (move.type === "drag-cancel") {
        if (activeDrag === move.dragId) activeDrag = undefined;
        enqueue(removeFrame);
      } else if (move.type === "move") {
        if (activeDrag === move.dragId) activeDrag = undefined;
        enqueue(async () => {
          // Le cadre part d'abord : si la réouverture échoue, il ne reste pas à l'écran.
          const removed = removeFrame();
          place = { left: place.left + move.dx, top: place.top + move.dy, height: move.height };
          await OBR.popover.close(id);
          await show();
          await removed;
          try {
            localStorage.setItem(storageKey, JSON.stringify({ left: place.left, top: place.top }));
          } catch {
            // Sans stockage, la position ne dure que le temps de la session.
          }
        });
      } else return false;
      return true;
    },
  };
}
