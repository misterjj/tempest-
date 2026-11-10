// Palette de l'outil « Zones météo » : peindre ou effacer, taille du pinceau, et les zones de la
// scène. La zone choisie se déplie avec son nom, son fondu, sa jauge et ses actions.
// La palette se déplace par sa barre de titre (voir window/move.ts).

import OBR from "@owlbear-rodeo/sdk";
import { currentLanguage, onLanguageChange, t } from "../i18n";
import type { Limits } from "../limits";
import "../panel/panel.css";
import { deleteZone, onLimitsChange, onZonesChange, readLimits, readZones, updateZones } from "../scene-state";
import { wireWindowMove } from "../window/move";
import { MAX_FEATHER, TooManyZonesError, addZone, newZone, zoneCost, type Zone, type ZonesData } from "../zones";
import { keyNames } from "../keys";
import { BRUSH_SIZES, PAINT_MODES, type PaintMode, type ToolSettings } from "./drawing";
import { PALETTE_FRAME_ID, PALETTE_ID, PALETTE_WIDTH, TOOL_CHANNEL, TOOL_ID, setToolSettings, toolSettings, type ToolMessage } from "./tool";
import "./palette.css";
import { flashHtml, helpHtml, watchFlash } from "../hint/help";
import { modeHint } from "../hint/messages";

const app = document.querySelector<HTMLDivElement>("#app")!;
/** Partie redessinée ; la barre de titre, elle, reste en place pour pouvoir être glissée. */
let content: HTMLElement;
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const send = (message: ToolMessage) => OBR.broadcast.sendMessage(TOOL_CHANNEL, message, { destination: "LOCAL" });

let zones: ZonesData = { v: 1, zones: [] };
let limits: Limits;
let settings: ToolSettings;
let history = { undo: 0, redo: 0 };
/** Forme choisie dans la barre d'outils : la taille ne sert qu'au pinceau. */
let mode: PaintMode | "vertices" = "brush";
/** Mode actif, pour l'aide */
let modeId: string | undefined;
let currentFlash: () => ReturnType<ReturnType<typeof watchFlash>> = () => null;
/** Suppression en attente de confirmation : un second clic la valide. */
let confirmDelete = false;
/** Zone tout juste créée : son nom s'ouvre à la saisie. */
let justCreated: string | null = null;
/** Une mise à jour arrivée pendant la saisie du nom attend qu'elle finisse. */
let pendingRender = false;

const ICON = {
  paint: '<path d="M12 6v12M6 12h12"/>',
  erase: '<path d="M6 12h12"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  clear: '<path d="M4 20h16"/><path d="M7 16l9-9 3 3-6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
};
const icon = (name: keyof typeof ICON) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/** « 1 case », « 1,5 case », « 2 cases » ; « 1 cell », « 1.5 cells » en anglais. */
const cells = (value: number) => {
  const n = String(value).replace(".", currentLanguage() === "fr" ? "," : ".");
  const plural = currentLanguage() === "fr" ? value >= 2 : value !== 1;
  return t(plural ? "palette.cellsMany" : "palette.cellsOne", { n });
};

function zoneRow(zone: Zone) {
  const selected = zone.id === settings.zone;
  const used = zoneCost(zone);
  const head = `
    <button type="button" class="zone-pick" data-zone="${zone.id}" aria-expanded="${selected}">
      <span class="dot" style="background:${zone.color}"></span>
      <span class="zone-name">${escape(zone.name || t("palette.unnamed"))}</span>
      <span class="zone-count">${used}/${limits.shapes}</span>
    </button>`;
  if (!selected) return `<div class="zone">${head}</div>`;
  const full = used >= limits.shapes;
  return `
    <div class="zone open" style="--zone:${zone.color}">
      ${head}
      <div class="zone-body">
        <label class="field">${t("palette.name")}
          <input id="name" maxlength="40" value="${escape(zone.name)}" placeholder="${t("palette.namePlaceholder")}" />
        </label>
        <label class="field">
          <span class="field-row">${t("palette.feather")}<span class="value">${cells(zone.feather)}</span></span>
          <input id="feather" type="range" min="0" max="${MAX_FEATHER}" step="0.5" value="${zone.feather}" />
        </label>
        <div class="meter ${full ? "full" : ""}" title="${t("palette.shapesHelp")}"><span style="width:${Math.min(100, (used / limits.shapes) * 100)}%"></span></div>
        <p class="meter-text">${full ? t("palette.full") : t("palette.shapes", { count: used, limit: limits.shapes })}</p>
        <div class="zone-actions">
          <button type="button" class="icon-button" id="undo" title="${t("palette.undo")} (${keyNames().undo})" ${history.undo ? "" : "disabled"}>${icon("undo")}</button>
          <button type="button" class="icon-button" id="redo" title="${t("palette.redo")} (${keyNames().redo})" ${history.redo ? "" : "disabled"}>${icon("redo")}</button>
          <span class="spacer"></span>
          <button type="button" class="text-button" id="clear" ${zone.shapes.length ? "" : "disabled"}>${icon("clear")}${t("palette.clear")}</button>
          <button type="button" class="text-button danger ${confirmDelete ? "confirm" : ""}" id="delete">${icon("trash")}${confirmDelete ? t("palette.confirmDelete") : t("palette.delete")}</button>
        </div>
      </div>
    </div>`;
}

/** Barre de titre et zone de contenu, posées une seule fois. */
function shell() {
  app.innerHTML = `
    <header class="bar palette-bar" id="drag" title="${t("palette.drag")}">
      <span class="grip">${icon("grip")}</span>
      <strong>${t("tool.name")}</strong>
      <button type="button" class="icon-button" id="close" title="${t("palette.close")}">${icon("close")}</button>
    </header>
    <div id="content"></div>`;
  content = app.querySelector<HTMLElement>("#content")!;
  app.querySelector<HTMLButtonElement>("#close")!.onclick = async () => {
    await send({ type: "closed" });
    await OBR.popover.close(PALETTE_ID);
  };
  wireWindowMove(app.querySelector<HTMLElement>("#drag")!, { send: (message) => send(message as ToolMessage), frameId: PALETTE_FRAME_ID, width: PALETTE_WIDTH, color: "#4f9dff" });
}

function render() {
  pendingRender = false;
  // Alt enfoncé inverse le mode le temps de l'appui : la palette le montre.
  const erasingNow = settings.erase !== (settings.alt ?? false);
  content.innerHTML = `
    <main class="palette">
      <section class="block">
        <div class="segmented mode" role="group" aria-label="${t("palette.mode")}">
          <button type="button" data-erase="0" aria-pressed="${!erasingNow}">${icon("paint")}${t("palette.paint")}</button>
          <button type="button" data-erase="1" class="erase" aria-pressed="${erasingNow}">${icon("erase")}${t("palette.erase")}</button>
        </div>

        ${
          mode === "brush"
            ? `<label class="field">
          <span class="field-row">${t("palette.size")}<span class="value">${cells(settings.size)}</span></span>
          <input id="size" type="range" min="${BRUSH_SIZES.min}" max="${BRUSH_SIZES.max}" step="0.25" value="${settings.size}" />
        </label>`
            : ""
        }
        ${flashHtml(currentFlash())}
        ${helpHtml(modeHint(modeId))}
      </section>
      <section class="block">
        <div class="block-head">
          <h3>${t("palette.zones")}</h3>
          <button type="button" class="text-button" id="new" ${zones.zones.length >= limits.zones ? "disabled" : ""}>+ ${t("palette.newZone")}</button>
        </div>
        ${zones.zones.length ? `<div class="zone-list">${zones.zones.map(zoneRow).join("")}</div>` : `<p class="tip">${t("palette.noZone")}</p>`}
      </section>
      <p class="tip keys">${t("palette.keys", keyNames())}</p>
    </main>`;
  wire();
  fitHeight();
  if (justCreated) {
    const input = content.querySelector<HTMLInputElement>("#name");
    input?.focus();
    input?.select();
    justCreated = null;
  }
}

/** La fenêtre prend la hauteur de son contenu, sans dépasser l'écran. */
function fitHeight() {
  const height = Math.ceil(app.getBoundingClientRect().height);
  OBR.viewport
    .getHeight()
    .then((viewport) => OBR.popover.setHeight(PALETTE_ID, Math.min(height, viewport - 16)))
    .catch(() => {});
}

const report = (error: unknown) => {
  if (error instanceof TooManyZonesError) OBR.notification.show(t("tool.tooManyZones", { limit: limits.zones }), "WARNING");
  else {
    console.error("[Tempest!]", error);
    OBR.notification.show(t("tool.saveError"), "ERROR");
  }
};

async function select(zone: string | null) {
  confirmDelete = false;
  settings = { ...settings, zone };
  await setToolSettings({ zone });
  render();
}

const changeZone = (id: string, apply: (zone: Zone) => void) =>
  updateZones((data) => {
    const zone = data.zones.find((candidate) => candidate.id === id);
    if (zone) apply(zone);
  }).catch(report);

function wire() {
  const app = content;
  app.querySelectorAll<HTMLButtonElement>("[data-erase]").forEach((button) => {
    button.onclick = async () => {
      settings = { ...settings, erase: button.dataset.erase === "1" };
      await setToolSettings({ erase: settings.erase });
      render();
    };
  });
  const size = app.querySelector<HTMLInputElement>("#size");
  if (size) {
    size.oninput = () => {
      settings = { ...settings, size: Number(size.value) };
      size.closest("label")!.querySelector(".value")!.textContent = cells(settings.size);
    };
    size.onchange = () => setToolSettings({ size: settings.size }).catch(report);
  }
  app.querySelectorAll<HTMLButtonElement>("[data-zone]").forEach((button) => {
    // Un clic sur la zone ouverte la referme.
    button.onclick = () => select(button.dataset.zone === settings.zone ? null : button.dataset.zone!).catch(report);
  });
  app.querySelector<HTMLButtonElement>("#new")!.onclick = async () => {
    let created = "";
    try {
      await updateZones((data) => {
        const zone = newZone(t("tool.defaultName", { n: data.zones.length + 1 }), data.zones);
        addZone(data, zone, limits);
        created = zone.id;
      });
      justCreated = created;
      await select(created);
    } catch (error) {
      report(error);
    }
  };

  const id = settings.zone;
  if (!id || !zones.zones.some((zone) => zone.id === id)) return;
  const name = app.querySelector<HTMLInputElement>("#name")!;
  let saveName: ReturnType<typeof setTimeout> | undefined;
  // Le nom s'enregistre pendant la saisie, sans attendre de quitter le champ.
  name.oninput = () => {
    clearTimeout(saveName);
    saveName = setTimeout(() => changeZone(id, (zone) => (zone.name = name.value.trim())), 400);
  };
  name.onkeydown = (event) => {
    if (event.key === "Enter") name.blur();
  };
  name.onblur = () => {
    clearTimeout(saveName);
    changeZone(id, (zone) => (zone.name = name.value.trim())).then(() => pendingRender && render());
  };
  const feather = app.querySelector<HTMLInputElement>("#feather")!;
  feather.oninput = () => (feather.closest("label")!.querySelector(".value")!.textContent = cells(Number(feather.value)));
  feather.onchange = () => changeZone(id, (zone) => (zone.feather = Number(feather.value)));
  app.querySelector<HTMLButtonElement>("#undo")!.onclick = () => send({ type: "undo" });
  app.querySelector<HTMLButtonElement>("#redo")!.onclick = () => send({ type: "redo" });
  // Par la page de fond, pour pouvoir annuler.
  app.querySelector<HTMLButtonElement>("#clear")!.onclick = () => send({ type: "clear", zone: id });
  app.querySelector<HTMLButtonElement>("#delete")!.onclick = async () => {
    if (!confirmDelete) {
      confirmDelete = true;
      render();
      return;
    }
    await deleteZone(id).catch(report);
    await select(null);
  };
}

OBR.onReady(async () => {
  document.documentElement.lang = currentLanguage();
  const theme = await OBR.theme.getTheme();
  document.documentElement.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark";
  shell();
  // Langue changée dans le panneau : la palette se redessine dans la nouvelle.
  onLanguageChange(() => {
    app.querySelector<HTMLElement>("#drag")!.title = t("palette.drag");
    app.querySelector<HTMLElement>("#drag strong")!.textContent = t("tool.name");
    app.querySelector<HTMLElement>("#close")!.title = t("palette.close");
    if (settings) render();
  });
  [zones, limits, settings] = await Promise.all([readZones(), readLimits(), toolSettings()]);
  const readMode = (id: string | undefined) => {
    modeId = id;
    return id === `${TOOL_ID}/sommets` ? "vertices" : (PAINT_MODES.find((candidate) => id === `${TOOL_ID}/${candidate}`) ?? mode);
  };
  mode = readMode(await OBR.tool.getActiveToolMode());
  OBR.tool.onToolModeChange((id) => {
    mode = readMode(id);
    refresh();
  });
  currentFlash = watchFlash(() => refresh());
  // Zone choisie supprimée entre-temps : plus rien de choisi.
  if (settings.zone && !zones.zones.some((zone) => zone.id === settings.zone)) await select(null);
  else render();
  const refresh = () => {
    // Ne pas effacer un nom en cours de saisie.
    if (document.activeElement?.id === "name") pendingRender = true;
    else render();
  };
  onZonesChange((data) => {
    zones = data;
    refresh();
  });
  onLimitsChange((value) => {
    limits = value;
    refresh();
  });
  OBR.broadcast.onMessage(TOOL_CHANNEL, async ({ data }) => {
    const message = data as ToolMessage;
    if (message.type === "history") {
      history = { undo: message.undo, redo: message.redo };
      refresh();
    } else if (message.type === "settings" || message.type === "selection") {
      // Réglage changé depuis la barre d'outils (Peindre / Effacer) ou une première forme.
      settings = await toolSettings();
      refresh();
    }
  });
});
