// Lecture et écriture de l'état dans les métadonnées de la scène.

import OBR from "@owlbear-rodeo/sdk";
import { MAX_STATE_BYTES, STATE_KEY, forgetZone, parseState, stateBytes, type TempestState } from "./state";
import { limitsIn, settingsWith, type Limits } from "./limits";
import { FLUIDS_KEY, MAX_FLUIDS_BYTES, fluidsBytes, parseFluids, type FluidsData } from "./fluids";
import { MAX_ZONES_BYTES, ZONES_KEY, parseZones, zonesBytes, type ZonesData } from "./zones";

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

// --- Zones peintes, sous leur propre clé ------------------------------------------------------

export async function readZones(): Promise<ZonesData> {
  return parseZones((await OBR.scene.getMetadata())[ZONES_KEY]);
}

export class ZonesTooLargeError extends Error {}

/** Modifie les zones de la scène (MJ seulement). */
export async function updateZones(change: (data: ZonesData) => void): Promise<ZonesData> {
  const data = await readZones();
  change(data);
  if (zonesBytes(data) > MAX_ZONES_BYTES) throw new ZonesTooLargeError();
  await OBR.scene.setMetadata({ [ZONES_KEY]: data });
  return data;
}

export function onZonesChange(callback: (data: ZonesData) => void) {
  return OBR.scene.onMetadataChange((metadata) => callback(parseZones(metadata[ZONES_KEY])));
}

/** Supprime une zone, et les effets et réglages qui la visaient. */
export async function deleteZone(id: string) {
  const [state, zones] = await Promise.all([readState(), readZones()]);
  forgetZone(state, id);
  zones.zones = zones.zones.filter((zone) => zone.id !== id);
  await OBR.scene.setMetadata({ [STATE_KEY]: state, [ZONES_KEY]: zones });
}

// --- Réglages de la salle --------------------------------------------------------------------

export async function readLimits(): Promise<Limits> {
  return limitsIn(await OBR.room.getMetadata());
}

/** Change les limites de la salle (MJ seulement). */
export async function writeLimits(limits: Limits) {
  await OBR.room.setMetadata(settingsWith(await OBR.room.getMetadata(), { limits }));
}

export function onLimitsChange(callback: (limits: Limits) => void) {
  return OBR.room.onMetadataChange((metadata) => callback(limitsIn(metadata)));
}

// --- Fluides, sous leur propre clé -------------------------------------------------------------

export async function readFluids(): Promise<FluidsData> {
  return parseFluids((await OBR.scene.getMetadata())[FLUIDS_KEY]);
}

export class FluidsTooLargeError extends Error {}

export async function writeFluids(data: FluidsData) {
  if (fluidsBytes(data) > MAX_FLUIDS_BYTES) throw new FluidsTooLargeError();
  await OBR.scene.setMetadata({ [FLUIDS_KEY]: data });
}

/** Modifie les fluides de la scène (MJ seulement). */
export async function updateFluids(change: (data: FluidsData) => void): Promise<FluidsData> {
  const data = await readFluids();
  change(data);
  await writeFluids(data);
  return data;
}

export function onFluidsChange(callback: (data: FluidsData) => void) {
  return OBR.scene.onMetadataChange((metadata) => callback(parseFluids(metadata[FLUIDS_KEY])));
}
