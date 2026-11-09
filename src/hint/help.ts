// Bloc d'aide des palettes : gestes du mode actif et message bref du moment.

import OBR from "@owlbear-rodeo/sdk";
import { HINT_CHANNEL, parseHint, type FlashMessage } from "./messages";

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Durée d'un message bref, en ms. */
const FLASH_MS = 4000;

/** Gestes, un par ligne ; une phrase occupe toute la ligne. */
export function helpHtml(hint: string | null) {
  if (!hint) return "";
  const rows = parseHint(hint)
    .map((item) => ("text" in item ? `<li class="help-text">${escape(item.text)}</li>` : `<li><kbd>${escape(item.gesture)}</kbd><span>${escape(item.action)}</span></li>`))
    .join("");
  return `<ul class="help">${rows}</ul>`;
}

export function flashHtml(flash: FlashMessage | null) {
  return flash ? `<p class="flash ${flash.tone}" role="status">${escape(flash.text)}</p>` : "";
}

/** Écoute les messages brefs ; `render` est rappelé à l'arrivée et à la disparition de chacun. */
export function watchFlash(render: () => void) {
  let current: FlashMessage | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  OBR.broadcast.onMessage(HINT_CHANNEL, ({ data }) => {
    const message = data as FlashMessage;
    if (message.type !== "flash") return;
    current = message;
    clearTimeout(timer);
    timer = setTimeout(() => {
      current = null;
      render();
    }, FLASH_MS);
    render();
  });
  return () => current;
}
