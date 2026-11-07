// Panneau de Tempest! : quatre onglets pour le MJ, « Couper les effets » pour les joueurs.

import OBR from "@owlbear-rodeo/sdk";
import { PANEL_CHANNEL, type PanelMessage } from "../background";
import { currentLanguage, t } from "../i18n";
import { QUALITIES, isMuted, qualitySetting, setMuted, setQuality, type Quality } from "../local";
import { DEFAULT_PROTO, PROTO_KEY, parseProto, type Proto, type ProtoTarget } from "../render/proto";
import { onStateChange, readState, updateState } from "../scene-state";
import type { TempestState } from "../state";
import "./panel.css";

const TABS = ["presets", "weather", "time", "filters"] as const;
type Tab = (typeof TABS)[number];

const app = document.querySelector<HTMLDivElement>("#app")!;
let tab: Tab = "presets";

function renderGM(state: TempestState) {
  app.innerHTML = `
    <header class="bar">
      <strong>${t("app.name")}</strong>
      <button type="button" class="stop" id="stop" aria-pressed="${state.paused}">${state.paused ? t("app.resume") : t("app.stopAll")}</button>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map((name) => `<button type="button" role="tab" data-tab="${name}" aria-selected="${name === tab}">${t(`tab.${name}`)}</button>`).join("")}
    </nav>
    <main class="content" role="tabpanel">
      ${tab === "weather" ? `<div id="proto"></div>` : `<p class="soon">${t("tab.soon")}</p>`}
    </main>`;
  if (tab === "weather") renderProto(app.querySelector<HTMLElement>("#proto")!);
  app.querySelector<HTMLButtonElement>("#stop")!.onclick = () =>
    updateState((draft) => {
      draft.paused = !draft.paused;
    });
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.onclick = () => {
      tab = button.dataset.tab as Tab;
      renderGM(state);
    };
  });
}

// --- PROTOTYPE de rendu (temporaire) : pluie et nuit, scène ou zone de test ------------------

async function writeProto(change: (proto: Proto) => void) {
  const proto = parseProto((await OBR.scene.getMetadata())[PROTO_KEY]);
  change(proto);
  await OBR.scene.setMetadata({ [PROTO_KEY]: proto });
}

/** Centre de l'écran du MJ, sur la carte : la zone de test s'y dessine. */
async function viewportCenter() {
  const [width, height] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  return OBR.viewport.inverseTransformPoint({ x: width / 2, y: height / 2 });
}

async function renderProto(root: HTMLElement) {
  const proto = parseProto((await OBR.scene.getMetadata())[PROTO_KEY]);
  const targets = (name: "rain" | "night", label: string) => `
    <p class="label">${label}</p>
    <div class="segmented" role="group" aria-label="${label}">
      ${(["off", "scene", "zone"] as ProtoTarget[])
        .map((value) => `<button type="button" data-${name}="${value}" aria-pressed="${proto[name] === value}">${{ off: "Off", scene: "Scène", zone: "Zone" }[value]}</button>`)
        .join("")}
    </div>`;
  root.innerHTML = `
    <p class="hint proto-hint">Prototype de rendu. Les réglages passent par la scène : ouvre la même salle sur un autre appareil (iPad…) pour comparer.</p>
    ${targets("rain", "Pluie")}
    ${targets("night", "Nuit (après-rendu)")}
    <p class="label">Masque de test : ${proto.strokes} traits de pinceau</p>
    <div class="segmented" role="group">
      ${[12, 60, 200, 500, 1000].map((count) => `<button type="button" data-strokes="${count}" aria-pressed="${proto.strokes === count}">${count}</button>`).join("")}
    </div>
    <p class="label">Fondu : ${proto.feather} case(s)</p>
    <input type="range" id="feather" min="0" max="5" step="0.5" value="${proto.feather}" />
    <label class="switch"><input type="checkbox" id="show-mask" ${proto.showMask ? "checked" : ""} /><span>Voir le masque (MJ)</span></label>
    <button type="button" class="stop" id="center">Placer la zone au centre de mon écran</button>
    <button type="button" class="stop" id="reset">Tout remettre à zéro</button>`;
  const rerender = () => renderProto(root);
  root.querySelectorAll<HTMLButtonElement>("[data-rain], [data-night], [data-strokes]").forEach((button) => {
    button.onclick = async () => {
      await writeProto((draft) => {
        if (button.dataset.rain) draft.rain = button.dataset.rain as ProtoTarget;
        if (button.dataset.night) draft.night = button.dataset.night as ProtoTarget;
        if (button.dataset.strokes) draft.strokes = Number(button.dataset.strokes);
      });
      rerender();
    };
  });
  root.querySelector<HTMLInputElement>("#feather")!.onchange = async (event) => {
    await writeProto((draft) => (draft.feather = Number((event.target as HTMLInputElement).value)));
    rerender();
  };
  root.querySelector<HTMLInputElement>("#show-mask")!.onchange = async (event) => {
    await writeProto((draft) => (draft.showMask = (event.target as HTMLInputElement).checked));
  };
  root.querySelector<HTMLButtonElement>("#center")!.onclick = async () => {
    const center = await viewportCenter();
    await writeProto((draft) => (draft.center = center));
  };
  root.querySelector<HTMLButtonElement>("#reset")!.onclick = async () => {
    await OBR.scene.setMetadata({ [PROTO_KEY]: { ...DEFAULT_PROTO, center: await viewportCenter() } });
    rerender();
  };
}

function renderPlayer() {
  const quality = qualitySetting();
  app.innerHTML = `
    <header class="bar"><strong>${t("player.title")}</strong></header>
    <main class="content">
      <label class="switch">
        <input type="checkbox" id="mute" ${isMuted() ? "checked" : ""} />
        <span>${t("player.mute")}</span>
      </label>
      <p class="hint">${t("player.muteHint")}</p>
      <p class="label">${t("player.quality")}</p>
      <div class="segmented" role="group" aria-label="${t("player.quality")}">
        ${(["auto", ...QUALITIES] as const)
          .map((value) => `<button type="button" data-quality="${value}" aria-pressed="${value === quality}">${t(`quality.${value}`)}</button>`)
          .join("")}
      </div>
    </main>`;
  app.querySelector<HTMLInputElement>("#mute")!.onchange = (event) => setMuted((event.target as HTMLInputElement).checked);
  app.querySelectorAll<HTMLButtonElement>("[data-quality]").forEach((button) => {
    button.onclick = () => {
      setQuality(button.dataset.quality as Quality | "auto");
      renderPlayer();
    };
  });
}

async function applyTheme() {
  const theme = await OBR.theme.getTheme();
  document.documentElement.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark";
}

/** Rien à régler tant qu'aucune scène n'est ouverte. */
function renderNoScene() {
  app.innerHTML = `<header class="bar"><strong>${t("app.name")}</strong></header><main class="content"><p class="soon">${t("app.noScene")}</p></main>`;
}

async function showGM() {
  if (!(await OBR.scene.isReady())) {
    renderNoScene();
    return;
  }
  renderGM(await readState());
}

OBR.onReady(async () => {
  document.documentElement.lang = currentLanguage();
  await applyTheme();
  OBR.theme.onChange(applyTheme);
  if ((await OBR.player.getRole()) !== "GM") {
    renderPlayer();
    return;
  }
  // Au rechargement, le panneau peut s'ouvrir avant la scène : il attend qu'elle soit prête.
  OBR.scene.onReadyChange(() => showGM().catch(console.error));
  onStateChange(renderGM);
  OBR.broadcast.onMessage(PANEL_CHANNEL, ({ data }) => {
    const message = data as PanelMessage;
    if (message.type === "target") {
      tab = "weather";
      showGM().catch(console.error);
    }
  });
  await showGM();
});
