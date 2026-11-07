// Lecture et écriture de l'état dans les métadonnées de la scène.

import OBR from "@owlbear-rodeo/sdk";
import { MAX_STATE_BYTES, STATE_KEY, parseState, stateBytes, type TempestState } from "./state";

export async function readState(): Promise<TempestState> {
  const metadata = await OBR.scene.getMetadata();
  return parseState(metadata[STATE_KEY]);
}

export class StateTooLargeError extends Error {}

/** Modifie l'état de la scène (MJ seulement). */
export async function updateState(change: (state: TempestState) => void): Promise<TempestState> {
  const state = await readState();
  change(state);
  if (stateBytes(state) > MAX_STATE_BYTES) throw new StateTooLargeError();
  await OBR.scene.setMetadata({ [STATE_KEY]: state });
  return state;
}

export function onStateChange(callback: (state: TempestState) => void) {
  return OBR.scene.onMetadataChange((metadata) => callback(parseState(metadata[STATE_KEY])));
}
