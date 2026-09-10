/// <reference lib="webworker" />
// Imported LCP profiles on the render worker (#3479).
//
// Two jobs. `importLensProfile` is the import handshake: register the
// document in raw-core's process cache, resolve it against the RAW the
// user is editing, persist the bytes in IndexedDB, and reply with the
// inventory + resolution the panel shows. `restoreLensProfile` runs before
// every request that carries a sidecar so a profile that sidecar names is
// registered before the decode that needs it — from IndexedDB, or (Self
// Hosted) from the server cache via the main thread's `lens-profile-fetch`
// handshake. Restores run in arrival order so a slow restore can never
// reorder the renders queued behind it.

import {
  clearLensProfiles,
  lensProfileCacheHasRoom,
  registerLensProfile,
  resolveLensProfile,
  selectedLensProfile,
} from './pkg/raw_wasm';
import { cachedLensProfile, cacheLensProfile, lensProfileDigest } from '../lens/lens-profile-cache';
import { LensProfileRestorer } from '../lens/lens-profile-restorer';
import type { LensProfileRestoreOutcome } from '../lens/lens-profile-restorer';
import { lensProfileFromJson } from '../lens/lens-profile.metadata';
import type {
  ImportedLensProfile,
  LensProfileInventory,
  LensProfileRequest,
  LensProfileStatus,
  LensProfileSuccess,
} from '../lens/lens-profile.types';
import { ensureReady } from './raw-pipeline.worker-handlers';

const restorer = new LensProfileRestorer(async (xmp) => {
  await ensureReady();
  return selectedLensProfile(xmp);
}, restoreCachedProfile);

// ── Main-thread cache-fetch handshake ────────────────────────────────────────
const waiting = new Map<number, () => void>();
let nextFetch = 1;

/** `lens-profile-restored` arrived: the main thread finished (or gave up on) the fetch. */
export function lensProfileRestored(id: number): void {
  waiting.get(id)?.();
  waiting.delete(id);
}

function requestRestore(reference: string): Promise<void> {
  const id = nextFetch++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    (self as unknown as Worker).postMessage({ id, type: 'lens-profile-fetch', reference });
  });
}

function postStatus(outcome: LensProfileRestoreOutcome): void {
  const status: LensProfileStatus = { id: 0, type: 'lens-profile-status', ...outcome };
  (self as unknown as Worker).postMessage(status);
}

/** Register the cached bytes for `reference`; `false` when no cache holds them. */
async function restoreCachedProfile(reference: string, digest: string): Promise<boolean> {
  const local = await cachedLensProfile(reference);
  const xml =
    local ??
    (await requestRestore(reference).then(
      () => cachedLensProfile(reference),
      () => undefined,
    ));
  if (!xml) return false;
  await ensureReady();
  if (!lensProfileCacheHasRoom(xml)) {
    clearLensProfiles();
    restorer.reset();
  }
  const registered = JSON.parse(registerLensProfile(xml)) as LensProfileInventory;
  if (lensProfileDigest(registered.reference) !== digest) {
    throw new Error(
      'The cached lens profile does not match this edit. Import the original .lcp file.',
    );
  }
  return true;
}

let restoreChain: Promise<unknown> = Promise.resolve();

/**
 * Make sure the profile `xmp` names is registered before the caller's
 * request runs. Never throws: an unparsable sidecar is the decode's own
 * error to report, and an unavailable profile is broadcast as a status the
 * panel shows while raw-core decides whether the render needed it.
 */
export function restoreLensProfile(xmp: string | null): Promise<void> {
  const run = async () => {
    const outcome = await restorer.restore(xmp).catch(() => null);
    if (outcome) postStatus(outcome);
  };
  const next = restoreChain.then(run, run);
  restoreChain = next;
  return next;
}

export async function importLensProfile(req: LensProfileRequest): Promise<void> {
  try {
    await ensureReady();
    if (!lensProfileCacheHasRoom(req.xml)) {
      clearLensProfiles();
      restorer.reset();
    }
    const registration = JSON.parse(registerLensProfile(req.xml)) as LensProfileInventory;
    const resolution = lensProfileFromJson(
      resolveLensProfile(new Uint8Array(req.bytes), req.ext, registration.reference),
    );
    if (!resolution)
      throw new Error('The renderer reported an unreadable lens profile resolution.');
    // Persist before reporting success: committing an edit whose only profile
    // copy lives in this worker would strand it after the browser is closed.
    await cacheLensProfile(registration.reference, req.xml);
    restorer.registered(registration.reference);
    postStatus({ reference: registration.reference, available: true });
    const profile: ImportedLensProfile = { ...registration, resolution };
    const reply: LensProfileSuccess = { id: req.id, type: 'lens-profile-success', profile };
    (self as unknown as Worker).postMessage(reply);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      type: 'lens-profile-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
