// Panneau de Tempest! : Ambiances, Météo, Heure et Filtres pour le MJ ; « Couper les effets »
// et la qualité pour les joueurs. Les curseurs agissent en direct : l'état part dans la scène
// pendant le glissement (au plus une écriture toutes les 120 ms).

import OBR from "@owlbear-rodeo/sdk";
import { currentLanguage, t } from "../i18n";
import { DEFAULT_LIMITS, type Limits } from "../limits";
import { QUALITIES, isMuted, qualitySetting, setMuted, setQuality, type Quality } from "../local";
import { lightAt } from "../render/daylight";
import { onLimitsChange, onStateChange, onZonesChange, readLimits, readState, readZones } from "../scene-state";
import {
  SCENE_ZONE,
  STATE_KEY,
  TIME_KEYS,
  WEATHER_KINDS,
  HIDDEN_FIELDS,
  OPTION_KEYS,
  defaultEffect,
  optionsOf,
  type OptionKey,
  stateBytes,
  MAX_STATE_BYTES,
  type Look,
  type TempestState,
  type WeatherEffect,
  type WeatherKind,
} from "../state";
import { PANEL_CHANNEL, type PanelMessage } from "../channels";
import { TOOL_ID, setToolSettings } from "../tool/tool";
import type { Zone } from "../zones";
import { icon, weatherIcon } from "./icons";
import "./panel.css";

const TABS = ["presets", "weather", "time", "filters"] as const;
type Tab = (typeof TABS)[number];

const app = document.querySelector<HTMLDivElement>("#app")!;
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let tab: Tab = "weather";
let state: TempestState;
let zones: Zone[] = [];
let limits: Limits = DEFAULT_LIMITS;
/** Zone réglée dans les onglets Météo, Heure et Filtres. */
let zoneId = SCENE_ZONE;
/** Cartes d'effets dépliées, et leurs « Variations naturelles » ouvertes. */
const open = new Set<string>();
const variationsOpen = new Set<string>();

/** Moments clés et leur heure. */
const MOMENT_HOURS = { dawn: 6, day: 12, dusk: 19, night: 23 } as const;
/** Filtres dont 50 % est la valeur neutre : affichés de -100 à +100. */
const CENTERED = new Set(["brightness", "contrast", "saturation", "hue"]);

// --- Écriture de l'état ------------------------------------------------------------------------

let writeTimer: ReturnType<typeof setTimeout> | undefined;
let lastWrite = 0;
/**
 * Ce que le panneau a écrit récemment : ses propres échos ne doivent ni redessiner le panneau ni
 * le ramener en arrière. Un curseur tiré vite envoie plusieurs écritures, dont les échos arrivent
 * en retard et dans le désordre : il faut toutes les reconnaître, pas seulement la dernière.
 */
const written: string[] = [];
const WRITTEN_KEPT = 30;
/** Un curseur est tenu : les changements venus de la scène attendent qu'il soit relâché. */
let holding = false;

function write() {
  clearTimeout(writeTimer);
  writeTimer = undefined;
  lastWrite = performance.now();
  if (stateBytes(state) > MAX_STATE_BYTES) {
    OBR.notification.show(t("panel.saveError"), "ERROR");
    return;
  }
  written.push(JSON.stringify(state));
  if (written.length > WRITTEN_KEPT) written.shift();
  OBR.scene.setMetadata({ [STATE_KEY]: state }).catch((error) => {
    console.error("[Tempest!]", error);
    OBR.notification.show(t("panel.saveError"), "ERROR");
  });
}

/** Applique un changement tout de suite à l'écran, et l'envoie à la scène sans l'inonder. */
function change(apply: (draft: TempestState) => void, redraw = true) {
  apply(state);
  if (redraw) render();
  const wait = 120 - (performance.now() - lastWrite);
  if (wait <= 0) write();
  else if (!writeTimer) writeTimer = setTimeout(write, wait);
}

// --- Morceaux d'interface ----------------------------------------------------------------------

const range = (id: string, value: number, min: number, max: number, step: number, label: string, shown: string) => `
  <label class="field">
    <span class="field-row">${label}<span class="value" data-value="${id}">${shown}</span></span>
    <input type="range" data-range="${id}" min="${min}" max="${max}" step="${step}" value="${value}" />
  </label>`;

const percent = (value: number) => `${Math.round(value * 100)} %`;
/** « ×1,25 » en français, « ×1.25 » en anglais. */
const times = (value: number) => `×${Number(value.toFixed(2)).toLocaleString(currentLanguage())}`;
const signedPercent = (value: number) => {
  const n = Math.round((value - 0.5) * 200);
  return `${n > 0 ? "+" : ""}${n}`;
};

function zonePicker() {
  const options = [{ id: SCENE_ZONE, name: t("zone.scene"), color: "" }, ...zones.map((zone) => ({ id: zone.id, name: zone.name || "—", color: zone.color }))];
  const current = zones.find((zone) => zone.id === zoneId);
  return `
    <div class="zone-picker">
      <span class="dot" style="background:${current?.color ?? "transparent"}" ${current ? "" : "hidden"}></span>
      <label class="sr" for="zone">${t("zone.label")}</label>
      <select id="zone">${options
        .map((option) => `<option value="${option.id}"${option.id === zoneId ? " selected" : ""}>${escape(option.name)}</option>`)
        .join("")}</select>
      <button type="button" class="stop with-icon" id="paint" title="${t("zone.paintTitle")}">${icon("pencil")}${t("zone.paint")}</button>
    </div>`;
}

function effectCard(effect: WeatherEffect) {
  const unfolded = open.has(effect.id);
  const head = `
    <div class="card-head">
      <button type="button" class="card-title" data-fold="${effect.id}" aria-expanded="${unfolded}" title="${t(unfolded ? "weather.fold" : "weather.unfold")}">
        ${icon("chevron", "chevron")}<span class="kind">${weatherIcon(effect.kind)}</span>${t(`weather.${effect.kind}`)}
        <span class="summary">${percent(effect.intensity)}</span>
      </button>
      <button type="button" class="icon-button" data-toggle="${effect.id}" aria-pressed="${!effect.enabled}" title="${t(effect.enabled ? "weather.hide" : "weather.show")}">${icon(effect.enabled ? "eye" : "eyeOff")}</button>
      <button type="button" class="icon-button danger" data-delete="${effect.id}" title="${t("weather.delete")}">${icon("trash")}</button>
    </div>`;
  if (!unfolded) return `<div class="card ${effect.enabled ? "" : "off"}">${head}</div>`;
  const id = (field: string) => `${effect.id}:${field}`;
  return `
    <div class="card ${effect.enabled ? "" : "off"}">
      ${head}
      <div class="card-body">
        <label class="field" title="${t("weather.directionHelp")}">
          <span class="field-row">${t("weather.direction")}</span>
          <span class="direction-slider">
            <span class="direction-arrow" data-arrow="${effect.id}" style="transform: rotate(${effect.direction}deg)">${icon("arrow")}</span>
            <input type="range" data-range="${id("direction")}" min="0" max="355" step="5" value="${effect.direction}" />
            <output data-value="${id("direction")}">${effect.direction}°</output>
          </span>
        </label>
        ${range(id("speed"), effect.speed, 0.25, 3, 0.05, t("weather.speed"), times(effect.speed))}
        ${range(id("intensity"), effect.intensity, 0, 1, 0.01, t("weather.intensity"), percent(effect.intensity))}
        ${range(id("scale"), effect.scale, 0.25, 4, 0.05, t("weather.scale"), times(effect.scale))}
        ${HIDDEN_FIELDS[effect.kind]?.includes("color") ? "" : `<div class="field-row color-row">
          <span>${t("weather.color")}</span>
          <span>
            <input type="color" data-color="${effect.id}" value="${effect.color ?? "#ffffff"}" ${effect.color ? "" : 'class="natural"'} />
            <button type="button" class="text-button" data-natural="${effect.id}" ${effect.color ? "" : "disabled"}>${t("weather.natural")}</button>
          </span>
        </div>`}
        ${range(id("opacity"), effect.opacity, 0, 1, 0.01, t("weather.opacity"), percent(effect.opacity))}
        ${optionsOf(effect.kind)
          .map((key) => range(id(key), effect.options[key] ?? 0, 0, 1, 0.01, t(`option.${key}`), percent(effect.options[key] ?? 0)))
          .join("")}
        <details class="variations" data-variations="${effect.id}" ${variationsOpen.has(effect.id) ? "open" : ""}>
          <summary>${icon("chevron", "chevron")}${t("weather.variations")}</summary>
          <div class="variations-body">
            ${range(id("turbulence"), effect.turbulence, 0, 1, 0.01, t("weather.turbulence"), percent(effect.turbulence))}
            ${range(id("gusts"), effect.gusts, 0, 1, 0.01, t("weather.gusts"), percent(effect.gusts))}
            ${range(id("variety"), effect.variety, 0, 1, 0.01, t("weather.variety"), percent(effect.variety))}
            ${range(id("patches"), effect.patches, 0, 1, 0.01, t("weather.patches"), percent(effect.patches))}
          </div>
        </details>
      </div>
    </div>`;
}

function weatherTab() {
  const effects = state.weather.filter((effect) => effect.zone === zoneId);
  const full = effects.length >= limits.effects;
  return `
    ${zonePicker()}
    ${effects.length ? `<div class="cards">${effects.map(effectCard).join("")}</div>` : `<p class="soon">${t("weather.empty")}</p>`}
    <p class="label add-label">${t("weather.add")}</p>
    <div class="add-row">
      ${WEATHER_KINDS.map((kind) => `<button type="button" class="stop with-icon" data-add="${kind}" title="${t(`weather.${kind}Help`)}" ${full ? "disabled" : ""}>${weatherIcon(kind)}${t(`weather.${kind}`)}</button>`).join("")}
    </div>
    ${full ? `<p class="hint">${t("weather.limit", { limit: limits.effects })}</p>` : ""}`;
}

/** Réglages d'ambiance de la zone, ou rien si elle suit la scène. */
const ownLook = () => state.looks.find((look) => look.zone === zoneId);

function followsScene() {
  return `
    <div class="follows">
      <p class="soon">${t("look.follows")}</p>
      <button type="button" class="stop" id="own">${t("look.own")}</button>
    </div>`;
}

const followButton = () => (zoneId === SCENE_ZONE ? "" : `<button type="button" class="text-button" id="follow">${t("look.follow")}</button>`);

function hourText(hour: number) {
  const h = Math.floor(hour) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60);
  return currentLanguage() === "fr" ? `${h} h ${String(m).padStart(2, "0")}` : `${h}:${String(m).padStart(2, "0")}`;
}

/** Dégradé du curseur d'heure : la teinte réelle à chaque heure. */
function skyGradient(look: Look) {
  const stops = Array.from({ length: 25 }, (_, h) => {
    const light = lightAt(h, look.time.colors);
    const c = [light.tint.x, light.tint.y, light.tint.z].map((v) => Math.round(Math.min(1, v * light.bright) * 255));
    return `rgb(${c.join(",")}) ${(h / 24) * 100}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function timeTab() {
  const look = ownLook();
  if (!look) return `${zonePicker()}${followsScene()}`;
  const time = look.time;
  return `
    ${zonePicker()}
    <label class="switch big"><input type="checkbox" id="time-on" ${time.enabled ? "checked" : ""} /><span>${t("time.enable")}</span>${followButton()}</label>
    <div class="clock ${time.enabled ? "" : "muted"}">
      <p class="hour" data-value="hour">${hourText(time.hour)}</p>
      <input type="range" class="sky" data-range="hour" min="0" max="24" step="0.25" value="${time.hour}" style="background:${skyGradient(look)}" />
      <div class="ticks"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
      <div class="moments">
        ${TIME_KEYS.map((key) => `<button type="button" class="stop" data-moment="${key}">${t(`time.${key}`)}</button>`).join("")}
      </div>
      <p class="label">${t("time.colors")}</p>
      <div class="moment-colors">
        ${TIME_KEYS.map((key) => `<label><input type="color" data-moment-color="${key}" value="${time.colors[key]}" />${t(`time.${key}`)} <small>${MOMENT_HOURS[key]} h</small></label>`).join("")}
      </div>
    </div>`;
}

function filtersTab() {
  const look = ownLook();
  if (!look) return `${zonePicker()}${followsScene()}`;
  return `
    ${zonePicker()}
    <div class="filters-head"><p class="hint">${t("filters.order")}</p>${followButton()}</div>
    <div class="filters">
      ${look.filters
        .map(
          (filter) => `
        <div class="filter ${filter.enabled ? "" : "muted"}">
          <label class="switch"><input type="checkbox" data-filter="${filter.kind}" ${filter.enabled ? "checked" : ""} /><span>${t(`filter.${filter.kind}`)}</span></label>
          <span class="value" data-value="filter:${filter.kind}">${CENTERED.has(filter.kind) ? signedPercent(filter.amount) : percent(filter.amount)}</span>
          <input type="range" data-range="filter:${filter.kind}" min="0" max="1" step="0.01" value="${filter.amount}" ${filter.enabled ? "" : "disabled"} />
        </div>`,
        )
        .join("")}
    </div>`;
}

// --- Rendu et événements -----------------------------------------------------------------------

/** Redessin reporté pendant qu'un sélecteur de couleur est ouvert. */
let renderLater = false;
const colorPickerOpen = () => document.activeElement instanceof HTMLInputElement && document.activeElement.type === "color";

/** Redessine le panneau sans perdre la position de défilement. */
function renderGM() {
  // Un sélecteur de couleur ouvert se ferme si son champ est remplacé : on attend qu'il le quitte.
  if (colorPickerOpen()) {
    renderLater = true;
    return;
  }
  renderLater = false;
  const scrolled = app.querySelector<HTMLElement>(".content")?.scrollTop ?? 0;
  drawGM();
  const content = app.querySelector<HTMLElement>(".content");
  if (content) content.scrollTop = scrolled;
}

function drawGM() {
  // La zone choisie a pu être supprimée.
  if (zoneId !== SCENE_ZONE && !zones.some((zone) => zone.id === zoneId)) zoneId = SCENE_ZONE;
  app.innerHTML = `
    <header class="bar">
      <strong>${t("app.name")}</strong>
      <button type="button" class="stop" id="stop" aria-pressed="${state.paused}">${state.paused ? t("app.resume") : t("app.stopAll")}</button>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map((name) => `<button type="button" role="tab" data-tab="${name}" aria-selected="${name === tab}">${t(`tab.${name}`)}</button>`).join("")}
    </nav>
    <main class="content" role="tabpanel">
      ${tab === "weather" ? weatherTab() : tab === "time" ? timeTab() : tab === "filters" ? filtersTab() : `<p class="soon">${t("tab.soon")}</p>`}
    </main>`;
}

let render = renderGM;

const effectById = (id: string) => state.weather.find((effect) => effect.id === id);

/** Valeur d'un curseur appliquée à l'état, et son affichage mis à jour sans tout redessiner. */
function onRange(key: string, value: number) {
  const shown = (text: string) => {
    const target = app.querySelector<HTMLElement>(`[data-value="${CSS.escape(key)}"]`);
    if (target) target.textContent = text;
  };
  if (key === "hour") {
    change((draft) => (ownLookOf(draft).time.hour = value), false);
    shown(hourText(value));
    return;
  }
  if (key.startsWith("filter:")) {
    const kind = key.slice(7);
    change((draft) => (ownLookOf(draft).filters.find((filter) => filter.kind === kind)!.amount = value), false);
    shown(CENTERED.has(kind) ? signedPercent(value) : percent(value));
    return;
  }
  type Field = "direction" | "speed" | "intensity" | "scale" | "opacity" | "turbulence" | "gusts" | "variety" | "patches" | OptionKey;
  const [id, field] = key.split(":") as [string, Field];
  change((draft) => {
    const effect = draft.weather.find((candidate) => candidate.id === id);
    if (!effect) return;
    if ((OPTION_KEYS as readonly string[]).includes(field)) effect.options[field as OptionKey] = value;
    else effect[field as Exclude<Field, OptionKey>] = value;
  }, false);
  shown(field === "direction" ? `${value}°` : field === "scale" || field === "speed" ? times(value) : percent(value));
  if (field === "direction") {
    const arrow = app.querySelector<HTMLElement>(`[data-arrow="${CSS.escape(id)}"]`);
    if (arrow) arrow.style.transform = `rotate(${value}deg)`;
  }
  if (field === "intensity") {
    const summary = app.querySelector<HTMLElement>(`[data-fold="${CSS.escape(id)}"] .summary`);
    if (summary) summary.textContent = percent(value);
  }
}

const ownLookOf = (draft: TempestState) => draft.looks.find((look) => look.zone === zoneId)!;

function wireGM() {
  app.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("button");
    if (!button) return;
    const data = button.dataset;
    if (button.id === "stop") change((draft) => (draft.paused = !draft.paused));
    else if (data.tab) {
      tab = data.tab as Tab;
      render();
      // Nouvel onglet : on repart du haut.
      app.querySelector<HTMLElement>(".content")?.scrollTo(0, 0);
    } else if (button.id === "paint") {
      // L'outil s'ouvre sur la zone choisie ; depuis « Toute la scène », la première forme en crée une.
      await setToolSettings({ zone: zoneId === SCENE_ZONE ? null : zoneId });
      await OBR.tool.activateTool(TOOL_ID);
    } else if (data.add) {
      const effect = defaultEffect(data.add as WeatherKind, zoneId);
      open.add(effect.id);
      change((draft) => draft.weather.push(effect));
    } else if (data.fold) {
      if (open.has(data.fold)) open.delete(data.fold);
      else open.add(data.fold);
      render();
    } else if (data.toggle) change(() => (effectById(data.toggle!)!.enabled = !effectById(data.toggle!)!.enabled));
    else if (data.delete) change((draft) => (draft.weather = draft.weather.filter((effect) => effect.id !== data.delete)));
    else if (data.natural) change(() => (effectById(data.natural!)!.color = null));
    else if (button.id === "own") change((draft) => draft.looks.push({ ...structuredClone(draft.looks[0]), zone: zoneId }));
    else if (button.id === "follow") change((draft) => (draft.looks = draft.looks.filter((look) => look.zone !== zoneId)));
    else if (data.moment) change((draft) => (ownLookOf(draft).time.hour = MOMENT_HOURS[data.moment as keyof typeof MOMENT_HOURS]));
  });

  app.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.range) onRange(input.dataset.range, Number(input.value));
    else if (input.dataset.color) {
      change(() => (effectById(input.dataset.color!)!.color = input.value.toLowerCase()), false);
      // Mis à jour sur place : redessiner fermerait le sélecteur.
      input.classList.remove("natural");
      const natural = app.querySelector<HTMLButtonElement>(`[data-natural="${CSS.escape(input.dataset.color)}"]`);
      if (natural) natural.disabled = false;
    }
    else if (input.dataset.momentColor) {
      change((draft) => (ownLookOf(draft).time.colors[input.dataset.momentColor as keyof Look["time"]["colors"]] = input.value.toLowerCase()), false);
      const sky = app.querySelector<HTMLInputElement>(".sky");
      if (sky) sky.style.background = skyGradient(ownLookOf(state));
    }
  });

  app.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.id === "zone") {
      zoneId = input.value;
      render();
    } else if (input.id === "time-on") change((draft) => (ownLookOf(draft).time.enabled = (input as HTMLInputElement).checked));
    else if ((input as HTMLInputElement).dataset.filter) {
      const kind = (input as HTMLInputElement).dataset.filter;
      change((draft) => (ownLookOf(draft).filters.find((filter) => filter.kind === kind)!.enabled = (input as HTMLInputElement).checked));
    }
  });

  // Section « Variations naturelles » : son état ouvert ou fermé survit aux redessins.
  app.addEventListener(
    "toggle",
    (event) => {
      const details = event.target as HTMLDetailsElement;
      const id = details.dataset?.variations;
      if (!id) return;
      if (details.open) variationsOpen.add(id);
      else variationsOpen.delete(id);
    },
    true,
  );

  // Sélecteur de couleur quitté : le redessin attendu peut se faire.
  app.addEventListener("focusout", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.type === "color" && renderLater) setTimeout(() => renderLater && render(), 0);
  });

  // Pendant qu'un curseur est tenu, la scène ne redessine pas le panneau sous le doigt.
  app.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).matches("input[type=range]")) holding = true;
  });
  window.addEventListener("pointerup", () => {
    if (!holding) return;
    holding = false;
    if (writeTimer) write();
  });
}

// --- Joueurs ---------------------------------------------------------------------------------

function renderPlayer() {
  const quality = qualitySetting();
  app.innerHTML = `
    <header class="bar"><strong>${t("player.title")}</strong></header>
    <main class="content">
      <label class="switch">
        <input type="checkbox" id="mute" ${isMuted() ? "checked" : ""} />
        <span>${t("player.mute")}</span>
      </label>
      <p class="hint mute-hint">${t("player.muteHint")}</p>
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

// --- Démarrage ---------------------------------------------------------------------------------

async function applyTheme() {
  const theme = await OBR.theme.getTheme();
  document.documentElement.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark";
}

function renderNoScene() {
  app.innerHTML = `<header class="bar"><strong>${t("app.name")}</strong></header><main class="content"><p class="soon">${t("app.noScene")}</p></main>`;
}

async function loadScene() {
  if (!(await OBR.scene.isReady())) {
    renderNoScene();
    return;
  }
  [state, zones, limits] = await Promise.all([readState(), readZones().then((data) => data.zones), readLimits()]);
  renderGM();
}

OBR.onReady(async () => {
  document.documentElement.lang = currentLanguage();
  await applyTheme();
  OBR.theme.onChange(applyTheme);
  if ((await OBR.player.getRole()) !== "GM") {
    render = renderPlayer;
    renderPlayer();
    return;
  }
  wireGM();
  // Au rechargement, le panneau peut s'ouvrir avant la scène : il attend qu'elle soit prête.
  OBR.scene.onReadyChange(() => loadScene().catch(console.error));
  onStateChange((next) => {
    // Son propre écho, ou un curseur tenu : rien à redessiner.
    if (written.includes(JSON.stringify(next)) || holding || writeTimer) return;
    state = next;
    if (state) renderGM();
  });
  onZonesChange((data) => {
    zones = data.zones;
    if (!holding && state) renderGM();
  });
  onLimitsChange((value) => {
    limits = value;
    if (!holding && state) renderGM();
  });
  // « Ajouter de la météo » sur une carte : le panneau s'ouvre sur sa zone.
  OBR.broadcast.onMessage(PANEL_CHANNEL, async ({ data }) => {
    const message = data as PanelMessage;
    if (message.type !== "zone") return;
    zoneId = message.zoneId;
    tab = "weather";
    zones = (await readZones()).zones;
    if (state) renderGM();
  });
  await loadScene();
});
