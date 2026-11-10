// Panneau de Tempest! : Ambiances, Météo, Heure et Filtres pour le MJ ; « Couper les effets »
// et la qualité pour les joueurs. Les curseurs agissent en direct : l'état part dans la scène
// pendant le glissement (au plus une écriture toutes les 120 ms).

import OBR from "@owlbear-rodeo/sdk";
import { LANGUAGES, chooseLanguage, currentLanguage, languageSetting, onLanguageChange, t, type Language } from "../i18n";
import { DEFAULT_LIMITS, LIMIT_RANGES, parseLimit, raisedLimits, type Limits } from "../limits";
import { QUALITIES, isMuted, qualitySetting, setMuted, setQuality, type Quality } from "../local";
import { lightAt } from "../render/daylight";
import {
  onFluidsChange,
  onLimitsChange,
  onStateChange,
  onZonesChange,
  readFluids,
  readLimits,
  readState,
  readZones,
  writeFluids,
  writeLimits,
} from "../scene-state";
import { FLUID_KINDS, FLUID_OPTIONS, addFluid, emptyFluids, fluidCost, newFluid, reverseStroke, TooManyFluidsError, MAX_SEGMENTS, type Fluid, type FluidKind, type FluidsData } from "../fluids";
import { traceFluid } from "../tool/fluid-tool";
import { FLUID_COLOR_HINTS } from "../render/fluid";
import {
  BUILTIN_PRESETS,
  MAX_CUSTOM_PRESETS,
  applyPreset,
  capturePreset,
  lookIsActive,
  parseCustomPresets,
  restoreZone,
  snapshotZone,
  type Preset,
} from "../presets";
import { NATURAL_TINTS } from "../render/shaders";
import {
  SCENE_ZONE,
  STATE_KEY,
  LAMP_KEY,
  LAMP_PRESETS,
  type Lamp,
  type LampPreset,
  TRANSITIONS,
  defaultLook,
  TIME_KEYS,
  TIME_PACES,
  hourNow,
  settleHour,
  WEATHER_KINDS,
  HIDDEN_FIELDS,
  LEAF_SHAPES,
  OPTION_KEYS,
  defaultEffect,
  optionsOf,
  type OptionKey,
  stateBytes,
  MAX_STATE_BYTES,
  type Look,
  type TempestState,
  type LeafShape,
  type WeatherEffect,
  type WeatherKind,
} from "../state";
import { BURST_CHANNEL, BURST_KINDS, PANEL_CHANNEL, type BurstKind, type BurstMessage, type PanelMessage } from "../channels";
import { TOOL_ID, setToolSettings } from "../tool/tool";
import type { Zone } from "../zones";
import { icon, weatherIcon } from "./icons";
import "./panel.css";

const TABS = ["presets", "weather", "time", "filters", "fluids", "settings"] as const;
type Tab = (typeof TABS)[number];

const app = document.querySelector<HTMLDivElement>("#app")!;
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let tab: Tab = "presets";
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

/**
 * Applique un changement tout de suite à l'écran, et l'envoie à la scène sans l'inonder.
 * `smooth` : chez les joueurs, le changement se fait en douceur (durée de l'onglet Ambiances).
 */
function change(apply: (draft: TempestState) => void, redraw = true, smooth = false) {
  apply(state);
  if (smooth) state.smooth = crypto.randomUUID();
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
      <button type="button" class="stop with-icon" id="reset" aria-expanded="${resetting}" title="${t("reset.title")}" ${
        hasSomething() ? "" : "disabled"
      }>${icon("reset")}${t("reset.confirm")}</button>
    </div>
    ${
      resetting
        ? `<div class="undo-bar reset-bar"><span>${resetQuestion()}</span>
            <div class="reset-choices">${
              zoneId === SCENE_ZONE && paintedZonesHaveSomething()
                ? `<button type="button" class="stop" id="reset-scene">${t("reset.sceneOnly")}</button>
                   <button type="button" class="stop" id="reset-all">${t("reset.all")}</button>`
                : `<button type="button" class="stop" id="reset-scene">${t("reset.confirm")}</button>`
            }
              <button type="button" class="text-button" id="reset-cancel">${t("preset.cancel")}</button>
            </div></div>`
        : lastApplied && lastApplied.zone === zoneId
          ? `<div class="undo-bar"><span>${lastApplied.message}</span><button type="button" class="stop" id="undo-preset">${t("preset.undo")}</button></div>`
          : ""
    }`;
}

/** La zone choisie a de la météo, ou une heure ou des filtres actifs. `others` : les zones peintes aussi. */
function zoneHasSomething(others = false) {
  const inZone = (zone: string) => zone === zoneId || (others && zone !== SCENE_ZONE);
  return state.weather.some((effect) => inZone(effect.zone)) || state.looks.some((look) => inZone(look.zone) && (look.zone !== SCENE_ZONE || lookIsActive(look)));
}
const hasSomething = () => zoneHasSomething(zoneId === SCENE_ZONE);
/** Des zones peintes ont leur propre météo ou leur propre ambiance. */
const paintedZonesHaveSomething = () => state.weather.some((effect) => effect.zone !== SCENE_ZONE) || state.looks.length > 1;

/** Ce que fera la remise à zéro, dit au MJ avant qu'il confirme. */
function resetQuestion() {
  if (zoneId !== SCENE_ZONE) return t("reset.askZone", { name: escape(zoneName(zoneId)) });
  return paintedZonesHaveSomething() ? t("reset.askSceneWithZones") : t("reset.askScene");
}

/** Annulation proposée après une ambiance ou une remise à zéro. */
function offerUndo(zone: string, message: string, restore: (draft: TempestState) => void) {
  lastApplied = { zone, message, restore };
}

/** Remet à zéro la zone choisie ; `all` : la scène et toutes ses zones. */
function resetZone(all = false) {
  resetting = false;
  if (all) {
    const before = { weather: structuredClone(state.weather), looks: structuredClone(state.looks) };
    change((draft) => {
      draft.weather = [];
      draft.looks = [defaultLook()];
    }, false, true);
    offerUndo(SCENE_ZONE, t("reset.doneAll"), (draft) => {
      draft.weather = structuredClone(before.weather);
      draft.looks = structuredClone(before.looks);
    });
  } else {
    const snapshot = snapshotZone(state, zoneId);
    // Une zone peinte remise à zéro suit de nouveau la scène.
    change((draft) => restoreZone(draft, { zone: zoneId, weather: [], look: undefined }), false, true);
    offerUndo(zoneId, t("reset.done", { name: escape(zoneName(zoneId)) }), (draft) => restoreZone(draft, snapshot));
  }
  render();
}

function effectCard(effect: WeatherEffect) {
  const unfolded = open.has(effect.id);
  const head = `
    <div class="card-head">
      <button type="button" class="card-title" data-fold="${effect.id}" aria-expanded="${unfolded}" title="${t(unfolded ? "weather.fold" : "weather.unfold")}">
        ${icon("chevron", "chevron")}<span class="kind">${weatherIcon(effect.kind)}</span>${effect.shape ? t(`shape.${effect.shape}`) : t(`weather.${effect.kind}`)}
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
        ${
          effect.shape
            ? `<label class="field-row shape-row">
          <span>${t("weather.shape")}</span>
          <select data-shape="${effect.id}">${LEAF_SHAPES.map((shape) => `<option value="${shape}"${shape === effect.shape ? " selected" : ""}>${t(`shape.${shape}`)}</option>`).join("")}</select>
        </label>`
            : ""
        }
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

// --- Lumières --------------------------------------------------------------------------------

/** Nom des objets porteurs, lu dans la scène (un objet supprimé n'a plus de nom). */
let itemNames = new Map<string, string>();
const lampOpen = new Set<string>();

function lampCard(lamp: Lamp) {
  const unfolded = lampOpen.has(lamp.id);
  const name = itemNames.get(lamp.item);
  const id = (field: string) => `lamp:${lamp.id}:${field}`;
  const head = `
    <div class="card-head">
      <button type="button" class="card-title" data-lamp-fold="${lamp.id}" aria-expanded="${unfolded}">
        ${icon("chevron", "chevron")}<span class="kind lamp-dot" style="background:${lamp.color}"></span>${
          !lamp.item ? t("lamp.fixed") : name === undefined ? `<em>${t("lamp.missing")}</em>` : escape(name || t("lamp.unnamed"))
        }
        <span class="summary">${t("lamp.radiusShort", { n: lamp.radius })}</span>
      </button>
      <button type="button" class="icon-button danger" data-lamp-delete="${lamp.id}" title="${t("lamp.remove")}">${icon("trash")}</button>
    </div>`;
  if (!unfolded) return `<div class="card">${head}</div>`;
  return `
    <div class="card">
      ${head}
      <div class="card-body">
        <div class="lamp-presets">${(Object.keys(LAMP_PRESETS) as LampPreset[])
          .map((preset) => `<button type="button" class="stop" data-lamp-preset="${lamp.id}:${preset}">${t(`lamp.preset.${preset}`)}</button>`)
          .join("")}</div>
        ${range(id("radius"), lamp.radius, 0.5, 30, 0.5, t("lamp.radius"), t("lamp.radiusShort", { n: lamp.radius }))}
        ${range(id("intensity"), lamp.intensity, 0, 1, 0.01, t("lamp.intensity"), percent(lamp.intensity))}
        ${range(id("flicker"), lamp.flicker, 0, 1, 0.01, t("lamp.flicker"), percent(lamp.flicker))}
        <div class="field-row color-row"><span>${t("lamp.color")}</span><input type="color" data-lamp-color="${lamp.id}" value="${lamp.color}" /></div>
      </div>
    </div>`;
}

function lampsSection() {
  return `
    <section class="lamps">
      <p class="label section-label">${t("lamp.title")}</p>
      ${state.lamps.length ? `<div class="cards">${state.lamps.map(lampCard).join("")}</div>` : ""}
      <p class="hint flush">${t("lamp.help")}</p>
    </section>`;
}

/** Retire des lumières, et la marque posée sur leur objet. */
function removeLamps(ids: string[]) {
  const items = state.lamps.filter((lamp) => ids.includes(lamp.id)).map((lamp) => lamp.item);
  change((draft) => (draft.lamps = draft.lamps.filter((lamp) => !ids.includes(lamp.id))));
  const others = new Set(state.lamps.map((lamp) => lamp.item));
  const freed = items.filter((item) => item && !others.has(item) && itemNames.has(item));
  if (freed.length) OBR.scene.items.updateItems(freed, (list) => list.forEach((item) => delete item.metadata[LAMP_KEY])).catch(console.error);
}

function onLampRange(key: string, value: number) {
  const [, id, field] = key.split(":") as [string, string, "radius" | "intensity" | "flicker"];
  change((draft) => {
    const lamp = draft.lamps.find((candidate) => candidate.id === id);
    if (lamp) lamp[field] = value;
  }, false);
  const target = app.querySelector<HTMLElement>(`[data-value="${CSS.escape(key)}"]`);
  if (target) target.textContent = field === "radius" ? t("lamp.radiusShort", { n: value }) : percent(value);
}

function timeTab() {
  const look = ownLook();
  if (!look) return `${zonePicker()}${followsScene()}${lampsSection()}`;
  const time = look.time;
  return `
    ${zonePicker()}
    <label class="switch big"><input type="checkbox" id="time-on" ${time.enabled ? "checked" : ""} /><span>${t("time.enable")}</span>${followButton()}</label>
    <div class="clock ${time.enabled ? "" : "muted"}">
      <p class="hour" data-value="hour">${hourText(hourNow(time, Date.now()))}</p>
      <input type="range" class="sky" data-range="hour" min="0" max="24" step="0.25" value="${hourNow(time, Date.now())}" style="background:${skyGradient(look)}" />
      <div class="ticks"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>
      <div class="moments">
        ${TIME_KEYS.map((key) => `<button type="button" class="stop" data-moment="${key}">${t(`time.${key}`)}</button>`).join("")}
      </div>
      <div class="transition-row pace-row">
        <span class="label" title="${t("time.paceHelp")}">${t("time.pace")}</span>
        <div class="segmented" role="group" aria-label="${t("time.pace")}">
          ${TIME_PACES.map(
            (pace) => `<button type="button" data-pace="${pace}" aria-pressed="${time.pace === pace}">${pace ? t("time.paceValue", { n: pace }) : t("time.paceOff")}</button>`,
          ).join("")}
        </div>
      </div>
      <p class="label">${t("time.colors")}</p>
      <div class="moment-colors">
        ${TIME_KEYS.map((key) => `<label><input type="color" data-moment-color="${key}" value="${time.colors[key]}" />${t(`time.${key}`)} <small>${MOMENT_HOURS[key]} h</small></label>`).join("")}
      </div>
    </div>
    ${lampsSection()}`;
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
      <span class="bursts">${BURST_KINDS.map(
        (kind) => `<button type="button" class="icon-button burst" data-burst="${kind}" title="${t(`burst.${kind}`)}" aria-label="${t(`burst.${kind}`)}">${icon(`burst-${kind}`)}</button>`,
      ).join("")}</span>
      <button type="button" class="stop with-icon" id="stop" aria-pressed="${state.paused}">${state.paused ? `${icon("play")}${t("app.resume")}` : `${icon("stop")}${t("app.stopAll")}`}</button>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map((name) =>
        name === "settings"
          ? `<button type="button" role="tab" class="tab-icon" data-tab="${name}" aria-selected="${name === tab}" title="${t("tab.settings")}" aria-label="${t("tab.settings")}">${icon("sliders")}</button>`
          : `<button type="button" role="tab" data-tab="${name}" aria-selected="${name === tab}">${t(`tab.${name}`)}</button>`,
      ).join("")}
    </nav>
    <main class="content" role="tabpanel">
      ${{ presets: presetsTab, weather: weatherTab, time: timeTab, filters: filtersTab, fluids: fluidsTab, settings: settingsTab }[tab]()}
    </main>`;
}

// --- Ambiances ---------------------------------------------------------------------------------

const CUSTOM_KEY = "tempest/presets";

/** Ambiances du MJ, gardées dans son navigateur (navigation privée : rien n'est gardé). */
function customPresets(): Preset[] {
  try {
    return parseCustomPresets(localStorage.getItem(CUSTOM_KEY));
  } catch {
    return [];
  }
}

function storeCustomPresets(presets: Preset[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(presets));
    return true;
  } catch {
    OBR.notification.show(t("preset.storeError"), "ERROR");
    return false;
  }
}

/** Dernière ambiance appliquée, pour « Annuler ». */
/** Dernière ambiance appliquée ou remise à zéro, et de quoi l'annuler. */
let lastApplied: { zone: string; message: string; restore: (draft: TempestState) => void } | undefined;
/** Choix « la scène seulement / la scène et ses zones » ouvert. */
let resetting = false;
/** Formulaire « Enregistrer cette zone » ouvert. */
let saving = false;
/** Ambiance du MJ dont la suppression attend confirmation. */
let confirmDelete: string | undefined;

const presetName = (preset: Preset) => preset.name ?? t(`preset.${preset.id}` as Parameters<typeof t>[0]);
const zoneName = (id: string) => (id === SCENE_ZONE ? t("zone.scene") : zones.find((zone) => zone.id === id)?.name || "—");

const mix = (a: number[], b: number[], k: number) => a.map((value, i) => value + (b[i] - value) * k);
const css = (c: number[]) => `rgb(${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(" ")})`;

/** Vignette dessinée : un ciel sur une prairie, éclairé à l'heure de l'ambiance, avec ses filtres. */
function thumb(preset: Preset) {
  let top = [0.55, 0.75, 0.95];
  let bottom = [0.4, 0.58, 0.32];
  const { time, filters } = preset.look;
  if (time.enabled) {
    const light = lightAt(time.hour, time.colors);
    const lit = (c: number[]) => {
      const grey = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
      return mix([grey, grey, grey], c, light.sat).map((v, i) => v * [light.tint.x, light.tint.y, light.tint.z][i] * light.bright);
    };
    top = lit(top);
    bottom = lit(bottom);
  }
  const on = (kind: string) => filters.find((filter) => filter.kind === kind && filter.enabled)?.amount;
  const cssFilters = [
    on("blur") !== undefined && `blur(${(on("blur")! * 2).toFixed(1)}px)`,
    on("grayscale") !== undefined && `grayscale(${on("grayscale")})`,
    on("sepia") !== undefined && `sepia(${on("sepia")})`,
    on("brightness") !== undefined && `brightness(${on("brightness")! * 2})`,
    on("contrast") !== undefined && `contrast(${on("contrast")! * 2})`,
    on("saturation") !== undefined && `saturate(${on("saturation")! * 2})`,
    on("hue") !== undefined && `hue-rotate(${Math.round((on("hue")! - 0.5) * 360)}deg)`,
  ].filter(Boolean);
  const vignette = on("vignette");
  // La météo teinte la vignette : brume blanche, sable doré, ombres de nuages…
  const veils = preset.weather
    .filter((effect) => effect.enabled && !["heat", "embers", "fireflies", "leaves", "wind"].includes(effect.kind))
    .map((effect) => {
      const tint = effect.color ? effect.color : css([NATURAL_TINTS[effect.kind].x, NATURAL_TINTS[effect.kind].y, NATURAL_TINTS[effect.kind].z]);
      if (effect.kind === "sunrays")
        return `<span class="veil rays" style="--tint:${tint};opacity:${(0.35 + effect.intensity * 0.5).toFixed(2)}"></span>`;
      return `<span class="veil" style="background:${tint};opacity:${(effect.intensity * effect.opacity * 0.4).toFixed(2)}"></span>`;
    })
    .join("");
  const kinds = [...new Set(preset.weather.map((effect) => effect.kind))].slice(0, 4);
  return `
    <span class="thumb">
      <span class="thumb-sky" style="background:linear-gradient(${css(top)}, ${css(bottom)});${cssFilters.length ? `filter:${cssFilters.join(" ")};` : ""}${
        vignette ? `box-shadow:inset 0 0 ${Math.round(8 + vignette * 18)}px rgb(0 0 0 / ${(0.3 + vignette * 0.5).toFixed(2)});` : ""
      }"></span>
      ${veils}
      <span class="thumb-icons">${kinds.map((kind) => weatherIcon(kind)).join("")}</span>
    </span>`;
}

function presetCard(preset: Preset, custom: boolean) {
  const button = `<button type="button" class="preset" data-${custom ? "custom" : "preset"}="${preset.id}">${thumb(preset)}<span class="preset-name">${escape(presetName(preset))}</span></button>`;
  if (!custom) return button;
  const confirming = confirmDelete === preset.id;
  return `
    <div class="preset-wrap">
      ${button}
      <button type="button" class="preset-delete ${confirming ? "confirm" : ""}" data-delete-preset="${preset.id}" title="${t("preset.delete")}">${
        confirming ? t("preset.confirmDelete") : icon("trash")
      }</button>
    </div>`;
}

function presetsTab() {
  const custom = customPresets();
  const own = state.weather.some((effect) => effect.zone === zoneId) || lookIsActive(state.looks.find((look) => look.zone === zoneId) ?? state.looks[0]);
  const defaultName = zoneId === SCENE_ZONE ? t("preset.defaultName") : zoneName(zoneId);
  return `
    ${zonePicker()}
    ${lastApplied?.zone === zoneId || resetting ? "" : `<p class="hint flush">${t("preset.help")}</p>`}
    <div class="transition-row">
      <span class="label" title="${t("transition.help")}">${t("transition.label")}</span>
      <div class="segmented" role="group" aria-label="${t("transition.label")}">
        ${TRANSITIONS.map(
          (seconds) =>
            `<button type="button" data-transition="${seconds}" aria-pressed="${state.transition === seconds}">${seconds ? t("transition.seconds", { n: seconds }) : t("transition.none")}</button>`,
        ).join("")}
      </div>
    </div>
    <div class="presets">${BUILTIN_PRESETS.map((preset) => presetCard(preset, false)).join("")}</div>
    <p class="label section-label">${t("preset.mine")}</p>
    ${custom.length ? `<div class="presets">${custom.map((preset) => presetCard(preset, true)).join("")}</div>` : `<p class="hint flush">${t("preset.mineEmpty")}</p>`}
    ${
      saving
        ? `<div class="save-form">
            <label class="sr" for="preset-name">${t("preset.name")}</label>
            <input id="preset-name" maxlength="40" value="${escape(defaultName)}" />
            <button type="button" class="stop" id="save-preset">${t("preset.save")}</button>
            <button type="button" class="text-button" id="cancel-save">${t("preset.cancel")}</button>
          </div>`
        : `<button type="button" class="stop with-icon save-button" id="new-preset" ${own && custom.length < MAX_CUSTOM_PRESETS ? "" : "disabled"}>${icon("plus")}${t("preset.saveZone")}</button>
          ${custom.length >= MAX_CUSTOM_PRESETS ? `<p class="hint flush">${t("preset.full", { limit: MAX_CUSTOM_PRESETS })}</p>` : ""}`
    }`;
}

function usePreset(preset: Preset) {
  const snapshot = snapshotZone(state, zoneId);
  let skipped = 0;
  change((draft) => (skipped = applyPreset(draft, zoneId, preset, limits.effects)), false, true);
  offerUndo(
    zoneId,
    `${t("preset.applied", { name: escape(presetName(preset)) })}${skipped ? ` ${t("preset.skipped", { count: skipped })}` : ""}`,
    (draft) => restoreZone(draft, snapshot),
  );
  render();
}

function savePreset() {
  const input = app.querySelector<HTMLInputElement>("#preset-name");
  const presets = customPresets();
  if (!input || presets.length >= MAX_CUSTOM_PRESETS) return;
  if (storeCustomPresets([...presets, capturePreset(state, zoneId, input.value)])) saving = false;
  render();
}

// --- Fluides -----------------------------------------------------------------------------------

let fluids: FluidsData = emptyFluids();
/** Cartes de coulées dépliées, et coulée dont la suppression attend confirmation. */
const fluidOpen = new Set<string>();
let confirmFluidDelete: string | undefined;
let fluidTimer: ReturnType<typeof setTimeout> | undefined;
let lastFluidWrite = 0;
/** Échos des écritures du panneau, à ignorer (voir `written`). */
const fluidWritten: string[] = [];

function writeFluidsNow() {
  clearTimeout(fluidTimer);
  fluidTimer = undefined;
  lastFluidWrite = performance.now();
  fluidWritten.push(JSON.stringify(fluids));
  if (fluidWritten.length > WRITTEN_KEPT) fluidWritten.shift();
  writeFluids(fluids).catch((error) => {
    console.error("[Tempest!]", error);
    OBR.notification.show(t("panel.saveError"), "ERROR");
  });
}

/** Comme `change`, pour les coulées (gardées sous leur propre clé). */
function changeFluids(apply: (data: FluidsData) => void, redraw = true) {
  apply(fluids);
  if (redraw) render();
  const wait = 120 - (performance.now() - lastFluidWrite);
  if (wait <= 0) writeFluidsNow();
  else if (!fluidTimer) fluidTimer = setTimeout(writeFluidsNow, wait);
}

const fluidById = (id: string) => fluids.fluids.find((fluid) => fluid.id === id);

function fluidCard(fluid: Fluid) {
  const unfolded = fluidOpen.has(fluid.id);
  const confirming = confirmFluidDelete === fluid.id;
  const head = `
    <div class="card-head">
      <button type="button" class="card-title" data-fluid-fold="${fluid.id}" aria-expanded="${unfolded}">
        ${icon("chevron", "chevron")}<span class="kind ${fluid.kind}">${icon(fluid.kind)}</span>${escape(fluid.name || t(`fluid.kind.${fluid.kind}`))}
      </button>
      <button type="button" class="icon-button" data-fluid-trace="${fluid.id}" title="${t("fluid.traceTitle")}">${icon("pencil")}</button>
      <button type="button" class="icon-button" data-fluid-toggle="${fluid.id}" aria-pressed="${!fluid.enabled}" title="${t(fluid.enabled ? "fluid.hide" : "fluid.show")}">${icon(fluid.enabled ? "eye" : "eyeOff")}</button>
      <button type="button" class="icon-button danger ${confirming ? "confirm-text" : ""}" data-fluid-delete="${fluid.id}" title="${t("fluid.delete")}">${
        confirming ? t("fluid.confirmDelete") : icon("trash")
      }</button>
    </div>`;
  if (!unfolded) return `<div class="card ${fluid.enabled ? "" : "off"}">${head}</div>`;
  const id = (field: string) => `fluid:${fluid.id}:${field}`;
  return `
    <div class="card ${fluid.enabled ? "" : "off"}">
      ${head}
      <div class="card-body">
        <label class="field-row name-row"><span>${t("fluid.name")}</span><input class="text-field" data-fluid-name="${fluid.id}" maxlength="40" value="${escape(fluid.name)}" /></label>
        <p class="hint flush">${t(`fluid.how.${fluid.kind}`)}</p>
        <div class="fluid-actions">
          <button type="button" class="stop with-icon" data-fluid-trace="${fluid.id}">${icon("pencil")}${t("fluid.trace")}</button>
          <button type="button" class="stop with-icon" data-fluid-reverse="${fluid.id}" ${fluid.strokes.length ? "" : "disabled"}>${icon("swap")}${t("fluid.reverse")}</button>
        </div>
        ${range(id("speed"), fluid.speed, 0.25, 3, 0.05, t("fluid.speed"), times(fluid.speed))}
        ${Object.keys(FLUID_OPTIONS[fluid.kind])
          .map((key) => range(id(key), fluid.options[key] ?? 0, 0, 1, 0.01, t(`fluid.option.${key}` as Parameters<typeof t>[0]), percent(fluid.options[key] ?? 0)))
          .join("")}
        <div class="field-row color-row">
          <span>${t("fluid.color")}</span>
          <span>
            <input type="color" data-fluid-color="${fluid.id}" value="${fluid.color ?? FLUID_COLOR_HINTS[fluid.kind]}" ${fluid.color ? "" : 'class="natural"'} />
            <button type="button" class="text-button" data-fluid-natural="${fluid.id}" ${fluid.color ? "" : "disabled"}>${t("fluid.natural")}</button>
          </span>
        </div>
        ${range(id("opacity"), fluid.opacity, 0, 1, 0.01, t("fluid.opacity"), percent(fluid.opacity))}
        <p class="hint flush">${t("fluid.stats", { strokes: fluid.strokes.length, rocks: fluid.rocks.length, segments: fluidCost(fluid), max: MAX_SEGMENTS })}${
          fluid.sources.length ? t("fluid.statsSources", { sources: fluid.sources.length }) : ""
        }${fluid.masks.length ? t("fluid.statsMasks", { masks: fluid.masks.length }) : ""}</p>
      </div>
    </div>`;
}

function fluidsTab() {
  return `
    <p class="hint flush">${t("fluid.help")}</p>
    <div class="add-row fluid-add">
      ${FLUID_KINDS
        .map((kind) => `<button type="button" class="stop with-icon" data-add-fluid="${kind}" title="${t(`fluid.how.${kind}`)}">${icon(kind)}${t(`fluid.add.${kind}`)}</button>`)
        .join("")}
    </div>
    ${fluids.fluids.length ? `<div class="cards">${fluids.fluids.map(fluidCard).join("")}</div>` : `<p class="hint flush">${t("fluid.empty")}</p>`}
    <p class="hint flush">${t("fluid.directionHelp")}</p>`;
}

/** Nouvelle coulée : elle est choisie dans l'outil, qui s'ouvre pour la tracer. */
async function addFluidOf(kind: FluidKind) {
  const count = fluids.fluids.filter((fluid) => fluid.kind === kind).length + 1;
  const fluid = newFluid(kind, t(`fluid.name.${kind}`, { n: count }));
  try {
    changeFluids((data) => addFluid(data, fluid));
  } catch (error) {
    if (error instanceof TooManyFluidsError) OBR.notification.show(t("fluid.tooMany"), "WARNING");
    return;
  }
  fluidOpen.add(fluid.id);
  writeFluidsNow();
  render();
  await traceFluid(fluid.id, kind);
}

function onFluidRange(key: string, value: number) {
  const [, id, field] = key.split(":");
  changeFluids((data) => {
    const fluid = data.fluids.find((candidate) => candidate.id === id);
    if (!fluid) return;
    if (field === "speed" || field === "opacity") fluid[field] = value;
    else fluid.options[field] = value;
  }, false);
  const target = app.querySelector<HTMLElement>(`[data-value="${CSS.escape(key)}"]`);
  if (target) target.textContent = field === "speed" ? times(value) : percent(value);
}

// --- Réglages ----------------------------------------------------------------------------------

const LIMIT_KEYS = ["zones", "shapes", "effects", "lamps"] as const;

/** Choix de la langue, pour le MJ comme pour les joueurs. */
function languageSection() {
  const setting = languageSetting();
  return `
    <section class="settings">
      <p class="label">${t("settings.language")}</p>
      <div class="segmented" role="group" aria-label="${t("settings.language")}">
        ${(["auto", ...LANGUAGES] as const)
          .map((value) => `<button type="button" data-language="${value}" aria-pressed="${value === setting}" ${value === "auto" ? "" : `lang="${value}"`}>${t(`language.${value}`)}</button>`)
          .join("")}
      </div>
      <p class="hint flush">${t("settings.languageHelp")}</p>
    </section>`;
}

function settingsTab() {
  const quality = qualitySetting();
  const raised = raisedLimits(limits);
  return `
    <section class="settings">
      <p class="label">${t("settings.limits")}</p>
      ${LIMIT_KEYS.map(
        (key) => `
        <label class="limit">
          <span>${t(`settings.limit.${key}`)}</span>
          <input type="number" data-limit="${key}" min="${LIMIT_RANGES[key][0]}" max="${LIMIT_RANGES[key][1]}" step="1" value="${limits[key]}" />
        </label>`,
      ).join("")}
      ${raised.map((key) => `<p class="warning">⚠ ${t(`settings.warn.${key}`)}</p>`).join("")}
      <p class="hint flush">${t("settings.limitsHelp", { zones: DEFAULT_LIMITS.zones, shapes: DEFAULT_LIMITS.shapes, effects: DEFAULT_LIMITS.effects, lamps: DEFAULT_LIMITS.lamps })}</p>
    </section>
    <section class="settings">
      <p class="label">${t("settings.style")}</p>
      <div class="segmented" role="group" aria-label="${t("settings.style")}">
        ${(["realistic", "cartoon"] as const)
          .map((style) => `<button type="button" data-style="${style}" aria-pressed="${state.style === style}">${t(`settings.style.${style}`)}</button>`)
          .join("")}
      </div>
      <p class="hint flush">${t("settings.styleHelp")}</p>
    </section>
    <section class="settings">
      <p class="label">${t("settings.display")}</p>
      <div class="segmented" role="group" aria-label="${t("player.quality")}">
        ${(["auto", ...QUALITIES] as const)
          .map((value) => `<button type="button" data-quality="${value}" aria-pressed="${value === quality}">${t(`quality.${value}`)}</button>`)
          .join("")}
      </div>
      <p class="hint flush">${t("settings.displayHelp")}</p>
    </section>
    ${languageSection()}`;
}

let render = renderGM;

const effectById = (id: string) => state.weather.find((effect) => effect.id === id);

/** Valeur d'un curseur appliquée à l'état, et son affichage mis à jour sans tout redessiner. */
function onRange(key: string, value: number) {
  if (key.startsWith("lamp:")) {
    onLampRange(key, value);
    return;
  }
  if (key.startsWith("fluid:")) {
    onFluidRange(key, value);
    return;
  }
  const shown = (text: string) => {
    const target = app.querySelector<HTMLElement>(`[data-value="${CSS.escape(key)}"]`);
    if (target) target.textContent = text;
  };
  if (key === "hour") {
    change((draft) => {
      const time = ownLookOf(draft).time;
      time.hour = value;
      if (time.pace) time.since = Date.now();
    }, false);
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
    if (data.burst) {
      const message: BurstMessage = { kind: data.burst as BurstKind };
      OBR.broadcast.sendMessage(BURST_CHANNEL, message, { destination: "ALL" }).catch(console.error);
      return;
    }
    if (button.id === "stop") change((draft) => (draft.paused = !draft.paused), true, true);
    else if (data.preset) usePreset(BUILTIN_PRESETS.find((preset) => preset.id === data.preset)!);
    else if (data.custom) {
      const preset = customPresets().find((candidate) => candidate.id === data.custom);
      if (preset) usePreset(preset);
    } else if (button.id === "undo-preset" && lastApplied) {
      const { restore } = lastApplied;
      lastApplied = undefined;
      change(restore, true, true);
    } else if (button.id === "reset") {
      // On dit d'abord ce qui sera retiré ; la remise à zéro attend la confirmation.
      lastApplied = undefined;
      resetting = !resetting;
      render();
    } else if (button.id === "reset-scene") resetZone();
    else if (button.id === "reset-all") resetZone(true);
    else if (button.id === "reset-cancel") {
      resetting = false;
      render();
    } else if (data.transition) {
      change((draft) => (draft.transition = Number(data.transition)));
    } else if (button.id === "new-preset") {
      saving = true;
      render();
      const input = app.querySelector<HTMLInputElement>("#preset-name");
      input?.focus();
      input?.select();
    } else if (button.id === "save-preset") savePreset();
    else if (button.id === "cancel-save") {
      saving = false;
      render();
    } else if (data.deletePreset) {
      if (confirmDelete === data.deletePreset) {
        confirmDelete = undefined;
        storeCustomPresets(customPresets().filter((preset) => preset.id !== data.deletePreset));
      } else confirmDelete = data.deletePreset;
      render();
    } else if (data.lampFold) {
      if (lampOpen.has(data.lampFold)) lampOpen.delete(data.lampFold);
      else lampOpen.add(data.lampFold);
      render();
    } else if (data.lampDelete) removeLamps([data.lampDelete]);
    else if (data.lampPreset) {
      const [id, preset] = data.lampPreset.split(":") as [string, LampPreset];
      change((draft) => {
        const lamp = draft.lamps.find((candidate) => candidate.id === id);
        if (lamp) Object.assign(lamp, LAMP_PRESETS[preset]);
      });
    } else if (data.addFluid) addFluidOf(data.addFluid as FluidKind).catch(console.error);
    else if (data.fluidFold) {
      if (fluidOpen.has(data.fluidFold)) fluidOpen.delete(data.fluidFold);
      else fluidOpen.add(data.fluidFold);
      render();
    } else if (data.fluidTrace) traceFluid(data.fluidTrace).catch(console.error);
    else if (data.fluidToggle) changeFluids(() => (fluidById(data.fluidToggle!)!.enabled = !fluidById(data.fluidToggle!)!.enabled));
    else if (data.fluidReverse) changeFluids(() => fluidById(data.fluidReverse!)?.strokes.forEach(reverseStroke));
    else if (data.fluidNatural) changeFluids(() => (fluidById(data.fluidNatural!)!.color = null));
    else if (data.fluidDelete) {
      if (confirmFluidDelete === data.fluidDelete) {
        confirmFluidDelete = undefined;
        changeFluids((draft) => (draft.fluids = draft.fluids.filter((fluid) => fluid.id !== data.fluidDelete)));
      } else {
        confirmFluidDelete = data.fluidDelete;
        render();
      }
    } else if (data.style) change((draft) => (draft.style = data.style === "cartoon" ? "cartoon" : "realistic"));
    else if (data.quality) {
      setQuality(data.quality as Quality | "auto");
      render();
    } else if (data.language) {
      chooseLanguage(data.language as Language | "auto");
      render();
    }
    else if (data.tab) {
      tab = data.tab as Tab;
      saving = false;
      confirmDelete = undefined;
      resetting = false;
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
      change((draft) => draft.weather.push(effect), true, true);
    } else if (data.fold) {
      if (open.has(data.fold)) open.delete(data.fold);
      else open.add(data.fold);
      render();
    } else if (data.toggle) change(() => (effectById(data.toggle!)!.enabled = !effectById(data.toggle!)!.enabled), true, true);
    else if (data.delete) change((draft) => (draft.weather = draft.weather.filter((effect) => effect.id !== data.delete)), true, true);
    else if (data.natural) change(() => (effectById(data.natural!)!.color = null));
    else if (button.id === "own") change((draft) => draft.looks.push({ ...structuredClone(draft.looks[0]), zone: zoneId }), true, true);
    else if (button.id === "follow") change((draft) => (draft.looks = draft.looks.filter((look) => look.zone !== zoneId)), true, true);
    else if (data.moment)
      change(
        (draft) => {
          const time = ownLookOf(draft).time;
          time.hour = MOMENT_HOURS[data.moment as keyof typeof MOMENT_HOURS];
          if (time.pace) time.since = Date.now();
        },
        true,
        true,
      );
    else if (data.pace)
      change((draft) => {
        const time = ownLookOf(draft).time;
        settleHour(time, Date.now());
        time.pace = Number(data.pace);
        time.since = time.pace ? Date.now() : 0;
      });
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
    else if (input.dataset.lampColor) change(() => (state.lamps.find((lamp) => lamp.id === input.dataset.lampColor)!.color = input.value.toLowerCase()), false);
    else if (input.dataset.fluidColor) {
      changeFluids(() => (fluidById(input.dataset.fluidColor!)!.color = input.value.toLowerCase()), false);
      input.classList.remove("natural");
      const natural = app.querySelector<HTMLButtonElement>(`[data-fluid-natural="${CSS.escape(input.dataset.fluidColor)}"]`);
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
      saving = false;
      resetting = false;
      render();
    } else if ((input as HTMLInputElement).dataset.limit) {
      const key = (input as HTMLInputElement).dataset.limit as keyof Limits;
      limits = { ...limits, [key]: parseLimit(key, input.value, limits[key]) };
      writeLimits(limits).catch((error) => {
        console.error("[Tempest!]", error);
        OBR.notification.show(t("panel.saveError"), "ERROR");
      });
      render();
    } else if (input.dataset.shape) {
      const shape = input.value as LeafShape;
      if (LEAF_SHAPES.includes(shape)) change(() => (effectById(input.dataset.shape!)!.shape = shape));
    } else if ((input as HTMLInputElement).dataset.fluidName) {
      const fluid = fluidById((input as HTMLInputElement).dataset.fluidName!);
      if (fluid) changeFluids(() => (fluid.name = input.value.trim().slice(0, 40)));
    } else if (input.id === "time-on") change((draft) => (ownLookOf(draft).time.enabled = (input as HTMLInputElement).checked), true, true);
    else if ((input as HTMLInputElement).dataset.filter) {
      const kind = (input as HTMLInputElement).dataset.filter;
      change((draft) => (ownLookOf(draft).filters.find((filter) => filter.kind === kind)!.enabled = (input as HTMLInputElement).checked), true, true);
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

  // Nom d'ambiance : Entrée enregistre, Échap renonce.
  app.addEventListener("keydown", (event) => {
    if ((event.target as HTMLElement).id !== "preset-name") return;
    if (event.key === "Enter") savePreset();
    else if (event.key === "Escape") {
      saving = false;
      render();
    }
  });

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
    if (fluidTimer) writeFluidsNow();
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
      ${languageSection()}
    </main>`;
  app.querySelector<HTMLInputElement>("#mute")!.onchange = (event) => setMuted((event.target as HTMLInputElement).checked);
  app.querySelectorAll<HTMLButtonElement>("[data-quality]").forEach((button) => {
    button.onclick = () => {
      setQuality(button.dataset.quality as Quality | "auto");
      renderPlayer();
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-language]").forEach((button) => {
    button.onclick = () => {
      chooseLanguage(button.dataset.language as Language | "auto");
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
  [state, zones, limits, fluids] = await Promise.all([readState(), readZones().then((data) => data.zones), readLimits(), readFluids()]);
  itemNames = new Map((await OBR.scene.items.getItems()).map((item) => [item.id, item.name]));
  renderGM();
}

/** L'heure avance seule : le panneau suit, sans redessiner (on peut être en train de glisser). */
setInterval(() => {
  if (tab !== "time" || holding || !state) return;
  const look = state.looks.find((candidate) => candidate.zone === zoneId);
  if (!look?.time.enabled || !look.time.pace) return;
  const hour = hourNow(look.time, Date.now());
  const shown = app.querySelector<HTMLElement>('[data-value="hour"]');
  const slider = app.querySelector<HTMLInputElement>('[data-range="hour"]');
  if (shown) shown.textContent = hourText(hour);
  if (slider) slider.value = String(hour);
}, 1000);

OBR.onReady(async () => {
  document.documentElement.lang = currentLanguage();
  await applyTheme();
  OBR.theme.onChange(applyTheme);
  // Langue changée ailleurs (un autre panneau de l'extension) : le panneau suit.
  onLanguageChange(() => {
    if (render === renderPlayer) renderPlayer();
    else if (state && !holding) renderGM();
  });
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
  // Noms des porteurs de lumière : seulement si l'un d'eux change (pas à chaque déplacement).
  OBR.scene.items.onChange((items) => {
    const next = new Map(items.map((item) => [item.id, item.name]));
    const relevant = state?.lamps.some((lamp) => next.get(lamp.item) !== itemNames.get(lamp.item));
    itemNames = next;
    if (relevant && !holding && tab === "time") renderGM();
  });
  onFluidsChange((data) => {
    // Son propre écho, ou un curseur tenu : rien à redessiner.
    if (fluidWritten.includes(JSON.stringify(data)) || holding || fluidTimer) return;
    fluids = data;
    if (state) renderGM();
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
