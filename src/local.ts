// Réglages propres à ce navigateur : qualité du rendu, « Couper les effets » pour soi seul, et langue.

export type Quality = "low" | "medium" | "high";
export const QUALITIES: Quality[] = ["low", "medium", "high"];

const QUALITY_KEY = "tempest/qualite";
const MUTE_KEY = "tempest/coupe";
export const LANGUAGE_KEY = "tempest/langue";

/** Part des particules gardées : le niveau bas les divise par 4. */
export const PARTICLE_FACTOR: Record<Quality, number> = { low: 0.25, medium: 0.6, high: 1 };
/** Profondeurs de pluie dessinées : la plus lointaine est la plus coûteuse. */
export const RAIN_LAYERS: Record<Quality, number> = { low: 1, medium: 2, high: 3 };

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sans stockage, le réglage ne dure que le temps de la page.
  }
}

/** Niveau choisi automatiquement : bas sur tablette et téléphone, moyen sur un petit processeur. */
export function autoQuality(): Quality {
  const touch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 1;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  if (touch) return "low";
  return cores <= 4 ? "medium" : "high";
}

export function qualitySetting(): Quality | "auto" {
  const saved = read(QUALITY_KEY);
  return QUALITIES.includes(saved as Quality) ? (saved as Quality) : "auto";
}

export const currentQuality = (): Quality => {
  const setting = qualitySetting();
  return setting === "auto" ? autoQuality() : setting;
};

export const setQuality = (quality: Quality | "auto") => write(QUALITY_KEY, quality === "auto" ? null : quality);

export const isMuted = () => read(MUTE_KEY) === "1";
export const setMuted = (muted: boolean) => write(MUTE_KEY, muted ? "1" : null);

/** Langue choisie ("fr", "en"), ou null pour suivre le navigateur. */
export const savedLanguage = () => read(LANGUAGE_KEY);
export const saveLanguage = (language: string | null) => write(LANGUAGE_KEY, language);

/** Les autres pages de l'extension (panneau, fond) suivent le changement. */
export function onLocalChange(callback: () => void) {
  window.addEventListener("storage", (event) => {
    if (event.key === QUALITY_KEY || event.key === MUTE_KEY || event.key === LANGUAGE_KEY) callback();
  });
}
