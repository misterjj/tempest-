// Météo : un effet GPU local par effet de l'état (STANDALONE pour la scène, ATTACHMENT pour
// une carte ou une forme). Les particules sont calculées dans le shader à partir du temps :
// aucun objet par goutte.

import type { Quality } from "../local";
import type { WeatherEffect } from "../state";

/** Met les effets météo locaux en accord avec l'état. À coder avec le prototype de rendu. */
export async function syncWeather(_effects: WeatherEffect[], _quality: Quality): Promise<void> {}

export async function clearWeather(): Promise<void> {}
