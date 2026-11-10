// Palette de l'outil « Fluides » : gestes du mode actif, largeur du trait (mode Tracer), coulée
// visée, annuler et rétablir. Fenêtre déplaçable par sa barre de titre, comme celle des zones.
// Les réglages de chaque coulée (vitesse, couleur…) restent dans le panneau Tempest!.

import OBR from "@owlbear-rodeo/sdk";
import { FLUID_KINDS, HIDE_BRUSH, STROKE_WIDTHS, type FluidKind, type FluidsData } from "../fluids";
import { flashHtml, helpHtml, watchFlash } from "../hint/help";
import { modeHint } from "../hint/messages";
import { currentLanguage, onLanguageChange, t } from "../i18n";
import { keyNames } from "../keys";
import "../panel/panel.css";
import { onFluidsChange, readFluids } from "../scene-state";
import { wireWindowMove } from "../window/move";
import {
  FLUID_CHANNEL,
  FLUID_PALETTE_FRAME_ID,
  FLUID_PALETTE_ID,
  FLUID_PALETTE_WIDTH,
  FLUID_TOOL_ID,
  KIND_COLORS,
  fluidToolSettings,
  setFluidToolSettings,
  type FluidToolMessage,
  type FluidToolSettings,
} from "./fluid-tool";
import "./palette.css";

const app = document.querySelector<HTMLDivElement>("#app")!;
let content: HTMLElement;
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const send = (message: FluidToolMessage) => OBR.broadcast.sendMessage(FLUID_CHANNEL, message, { destination: "LOCAL" });

let fluids: FluidsData = { v: 1, fluids: [] };
let settings: FluidToolSettings;
let history = { undo: 0, redo: 0 };
let modeId: string | undefined;
let currentFlash: ReturnType<typeof watchFlash> = () => null;

const ICON = {
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
};
const icon = (name: keyof typeof ICON) =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/** « 1 case », « 1,5 case », « 2 cases ». */
const cells = (value: number) => {
  const n = String(value).replace(".", currentLanguage() === "fr" ? "," : ".");
  const plural = currentLanguage() === "fr" ? value >= 2 : value !== 1;
  return t(plural ? "palette.cellsMany" : "palette.cellsOne", { n });
};

/** Nom du mode actif, d'après l'identifiant de mode d'Owlbear. */
function modeTitle() {
  const mode = modeId?.slice(FLUID_TOOL_ID.length + 1);
  if (mode === "sommets") return t("vertices.mode");
  const known = (["trace", "rock", "hide", "hideBrush", "source", "direction", "erase"] as const).find((candidate) => candidate === mode);
  return known ? t(`fluid.mode.${known}`) : "";
}

function shell() {
  app.innerHTML = `
    <header class="bar palette-bar" id="drag" title="${t("palette.drag")}">
      <span class="grip">${icon("grip")}</span>
      <strong>${t("fluid.tool")}</strong>
      <button type="button" class="icon-button" id="close" title="${t("palette.close")}">${icon("close")}</button>
    </header>
    <div id="content"></div>`;
  content = app.querySelector<HTMLElement>("#content")!;
  app.querySelector<HTMLButtonElement>("#close")!.onclick = async () => {
    await send({ type: "closed" });
    await OBR.popover.close(FLUID_PALETTE_ID);
  };
  wireWindowMove(app.querySelector<HTMLElement>("#drag")!, {
    send: (message) => send(message as FluidToolMessage),
    frameId: FLUID_PALETTE_FRAME_ID,
    width: FLUID_PALETTE_WIDTH,
    color: KIND_COLORS.water,
  });
}

function fluidRow(fluid: FluidsData["fluids"][number]) {
  const selected = fluid.id === settings.fluid;
  return `<div class="zone ${selected ? "open" : ""}" style="--zone:${KIND_COLORS[fluid.kind]}">
    <button type="button" class="zone-pick" data-fluid="${fluid.id}" aria-pressed="${selected}">
      <span class="dot" style="background:${KIND_COLORS[fluid.kind]}"></span>
      <span class="zone-name">${escape(fluid.name || t(`fluid.add.${fluid.kind}`))}</span>
      <span class="zone-count">${t(`fluid.add.${fluid.kind}`)}</span>
    </button>
  </div>`;
}

function render() {
  const tracing = modeId === `${FLUID_TOOL_ID}/trace`;
  const hiding = modeId === `${FLUID_TOOL_ID}/hideBrush`;
  const chosen = fluids.fluids.find((fluid) => fluid.id === settings.fluid);
  content.innerHTML = `
    <main class="palette">
      <section class="block">
        <p class="mode-title">${modeTitle()}</p>
        ${flashHtml(currentFlash())}
        ${helpHtml(modeHint(modeId))}
        ${
          tracing
            ? `<label class="field">
          <span class="field-row">${t("fluidPalette.width")}<span class="value">${cells(settings.size)}</span></span>
          <input id="size" type="range" min="${STROKE_WIDTHS.min}" max="${STROKE_WIDTHS.max}" step="0.5" value="${settings.size}" />
        </label>`
            : hiding
              ? `<label class="field">
          <span class="field-row">${t("fluidPalette.hideSize")}<span class="value">${cells(settings.hideSize)}</span></span>
          <input id="hideSize" type="range" min="${HIDE_BRUSH.min}" max="${HIDE_BRUSH.max}" step="0.05" value="${settings.hideSize}" />
        </label>`
              : ""
        }
      </section>
      <section class="block">
        <div class="block-head">
          <h3>${t("fluidPalette.flows")}</h3>
          <span>
            <button type="button" class="icon-button" id="undo" title="${t("palette.undo")} (${keyNames().undo})" ${history.undo ? "" : "disabled"}>${icon("undo")}</button>
            <button type="button" class="icon-button" id="redo" title="${t("palette.redo")} (${keyNames().redo})" ${history.redo ? "" : "disabled"}>${icon("redo")}</button>
          </span>
        </div>
        ${fluids.fluids.length ? `<div class="zone-list">${fluids.fluids.map(fluidRow).join("")}</div>` : ""}
        ${
          chosen
            ? `<p class="tip">${t("fluidPalette.chosen")}</p>`
            : `<label class="field">${t("fluidPalette.newKind")}
          <select id="kind">${FLUID_KINDS.map((kind) => `<option value="${kind}" ${kind === settings.kind ? "selected" : ""}>${t(`fluid.add.${kind}`)}</option>`).join("")}</select>
        </label>
        <p class="tip">${t("fluidPalette.newTip")}</p>`
        }
      </section>
    </main>`;
  wire();
  fitHeight();
}

function fitHeight() {
  const height = Math.ceil(app.getBoundingClientRect().height);
  OBR.viewport
    .getHeight()
    .then((viewport) => OBR.popover.setHeight(FLUID_PALETTE_ID, Math.min(height, viewport - 16)))
    .catch(() => {});
}

/**
 * Curseur de taille : la valeur part pendant le glissement (au plus toutes les 80 ms), pour que
 * l'anneau sur la carte suive, puis une dernière fois au relâchement.
 */
function wireSize(id: string, change: (value: number) => Partial<FluidToolSettings>, keep: (value: number) => void) {
  const input = content.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = () => {
    timer = undefined;
    setFluidToolSettings(change(Number(input.value))).catch(console.error);
  };
  input.oninput = () => {
    keep(Number(input.value));
    input.closest("label")!.querySelector(".value")!.textContent = cells(Number(input.value));
    timer ??= setTimeout(push, 80);
  };
  input.onchange = () => {
    clearTimeout(timer);
    push();
  };
}

function wire() {
  wireSize("size", (value) => ({ size: value }), (value) => (settings = { ...settings, size: value }));
  wireSize("hideSize", (value) => ({ hideSize: value }), (value) => (settings = { ...settings, hideSize: value }));
  content.querySelectorAll<HTMLButtonElement>("[data-fluid]").forEach((button) => {
    // Un clic sur la coulée choisie la libère : le prochain trait en crée une nouvelle.
    button.onclick = async () => {
      const fluid = button.dataset.fluid === settings.fluid ? null : button.dataset.fluid!;
      settings = { ...settings, fluid };
      render();
      await setFluidToolSettings({ fluid });
    };
  });
  const kind = content.querySelector<HTMLSelectElement>("#kind");
  if (kind) kind.onchange = () => setFluidToolSettings({ kind: kind.value as FluidKind }).catch(console.error);
  content.querySelector<HTMLButtonElement>("#undo")!.onclick = () => send({ type: "undo" });
  content.querySelector<HTMLButtonElement>("#redo")!.onclick = () => send({ type: "redo" });
}

OBR.onReady(async () => {
  document.documentElement.lang = currentLanguage();
  const theme = await OBR.theme.getTheme();
  document.documentElement.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark";
  shell();
  // Langue changée dans le panneau : la palette se redessine dans la nouvelle.
  onLanguageChange(() => {
    app.querySelector<HTMLElement>("#drag")!.title = t("palette.drag");
    app.querySelector<HTMLElement>("#drag strong")!.textContent = t("fluid.tool");
    app.querySelector<HTMLElement>("#close")!.title = t("palette.close");
    if (settings) render();
  });
  [fluids, settings, modeId] = await Promise.all([readFluids(), fluidToolSettings(), OBR.tool.getActiveToolMode()]);
  // Ne pas redessiner pendant qu'on fait glisser la largeur ou qu'une liste est ouverte.
  const refresh = () => {
    const active = document.activeElement?.id;
    if (active === "size" || active === "hideSize" || active === "kind") return;
    render();
  };
  OBR.tool.onToolModeChange((id) => {
    modeId = id;
    render();
  });
  onFluidsChange((data) => {
    fluids = data;
    refresh();
  });
  currentFlash = watchFlash(render);
  OBR.broadcast.onMessage(FLUID_CHANNEL, async ({ data }) => {
    const message = data as FluidToolMessage;
    if (message.type === "history") {
      history = { undo: message.undo, redo: message.redo };
      refresh();
    } else if (message.type === "selection" || message.type === "settings") {
      settings = await fluidToolSettings();
      refresh();
    }
  });
  render();
});
