// Les 8 ambiances fournies. Leur contenu (météo, heure, filtres) sera réglé avec les effets.

export const PRESET_IDS = ["sunny", "dusk", "clearNight", "stormyNight", "blizzard", "toxicFog", "sandstorm", "memory"] as const;
export type PresetId = (typeof PRESET_IDS)[number];
