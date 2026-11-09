// Messages brefs des outils (« trace dans une coulée », « largeur : 3 cases ») : ils s'affichent
// dans la palette de l'outil plutôt qu'en alerte d'Owlbear. Palette fermée : alerte quand même,
// pour que le MJ sache pourquoi rien ne s'est passé.

import OBR from "@owlbear-rodeo/sdk";
import { HINT_CHANNEL, type FlashMessage, type HintTone } from "../hint/messages";

const windows: { readonly isOpen: boolean }[] = [];

/** Palette qui peut afficher les messages brefs. */
export function flashInto(window: { readonly isOpen: boolean }) {
  windows.push(window);
}

export function flash(text: string, tone: HintTone = "info") {
  if (!windows.some((window) => window.isOpen)) {
    OBR.notification.show(text, tone === "warning" ? "WARNING" : "INFO");
    return;
  }
  const message: FlashMessage = { type: "flash", text, tone };
  OBR.broadcast.sendMessage(HINT_CHANNEL, message, { destination: "LOCAL" }).catch(() => {});
}
