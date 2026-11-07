// Textes de l'interface, en français et en anglais.

export type Language = "fr" | "en";

const fr = {
  "app.name": "Tempest!",
  "app.stopAll": "Tout couper",
  "app.resume": "Reprendre",
  "app.noScene": "Ouvre une scène pour régler son ambiance.",
  "tab.presets": "Ambiances",
  "tab.weather": "Météo",
  "tab.time": "Heure",
  "tab.filters": "Filtres",
  "tab.soon": "À venir : on définit d'abord l'interface ensemble.",
  "menu.addWeather": "Ajouter de la météo",
  "player.title": "Effets d'ambiance",
  "player.mute": "Couper les effets sur mon écran",
  "player.muteHint": "Seulement pour toi : les autres joueurs voient toujours les effets.",
  "player.quality": "Qualité",
  "quality.auto": "Auto",
  "quality.low": "Basse",
  "quality.medium": "Moyenne",
  "quality.high": "Haute",
  "weather.rain": "Pluie",
  "weather.snow": "Neige",
  "weather.fog": "Brume",
  "weather.sand": "Sable",
  "weather.embers": "Braises",
  "preset.sunny": "Grand soleil",
  "preset.dusk": "Crépuscule",
  "preset.clearNight": "Nuit claire",
  "preset.stormyNight": "Nuit d'orage",
  "preset.blizzard": "Blizzard",
  "preset.toxicFog": "Brume toxique",
  "preset.sandstorm": "Tempête de sable",
  "preset.memory": "Souvenir",
};

type Key = keyof typeof fr;

const en: Record<Key, string> = {
  "app.name": "Tempest!",
  "app.stopAll": "Stop all",
  "app.resume": "Resume",
  "app.noScene": "Open a scene to set its mood.",
  "tab.presets": "Moods",
  "tab.weather": "Weather",
  "tab.time": "Time",
  "tab.filters": "Filters",
  "tab.soon": "Coming soon: we design the interface together first.",
  "menu.addWeather": "Add weather",
  "player.title": "Mood effects",
  "player.mute": "Turn effects off on my screen",
  "player.muteHint": "Only for you: other players still see the effects.",
  "player.quality": "Quality",
  "quality.auto": "Auto",
  "quality.low": "Low",
  "quality.medium": "Medium",
  "quality.high": "High",
  "weather.rain": "Rain",
  "weather.snow": "Snow",
  "weather.fog": "Fog",
  "weather.sand": "Sand",
  "weather.embers": "Embers",
  "preset.sunny": "Bright sun",
  "preset.dusk": "Dusk",
  "preset.clearNight": "Clear night",
  "preset.stormyNight": "Stormy night",
  "preset.blizzard": "Blizzard",
  "preset.toxicFog": "Toxic fog",
  "preset.sandstorm": "Sandstorm",
  "preset.memory": "Memory",
};

export const DICTIONARIES: Record<Language, Record<Key, string>> = { fr, en };

let forced: Language | undefined;

export function currentLanguage(): Language {
  if (forced) return forced;
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

/** Pour les tests : impose une langue. */
export const setLanguage = (language: Language | undefined) => {
  forced = language;
};

export function t(key: Key, vars: Record<string, string | number> = {}) {
  const text = DICTIONARIES[currentLanguage()][key] ?? fr[key];
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}
