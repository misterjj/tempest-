// Heure du jour et filtres : un effet sur la couche POST_PROCESS, qui relit l'image de la scène.

import type { TempestState } from "../state";

/** Met l'étalonnage couleur en accord avec l'état. À coder avec le prototype de rendu. */
export async function syncPost(_state: TempestState): Promise<void> {}

export async function clearPost(): Promise<void> {}
