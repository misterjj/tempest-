// Raccourcis clavier affichés : ⌘ et ⌥ sur Mac, Ctrl et Alt ailleurs.

import { currentLanguage } from "./i18n";

export function isMac() {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform) || /Mac OS X/.test(navigator.userAgent);
}

export function keyNames(mac = isMac()) {
  const fr = currentLanguage() === "fr";
  return mac
    ? {
        undo: "⌘Z",
        redo: "⌘⇧Z",
        alt: "⌥ Option",
        enter: fr ? "↩ Retour" : "↩ Return",
        escape: fr ? "Échap" : "Esc",
        backspace: fr ? "⌫ Supprimer" : "⌫ Delete",
      }
    : {
        undo: "Ctrl+Z",
        redo: "Ctrl+Shift+Z",
        alt: "Alt",
        enter: fr ? "Entrée" : "Enter",
        escape: fr ? "Échap" : "Esc",
        backspace: fr ? "Retour arrière" : "Backspace",
      };
}
