import { registerLensProfile, resolveLensProfile, selectedLensProfile } from './pkg/raw_wasm';
import { cachedLensProfile, cacheLensProfile, lensProfileDigest } from '../lens/lens-profile-cache';
import type {
  ImportedLensProfile,
  LensProfileRequest,
  LensProfileSuccess,
} from '../lens/lens-profile.types';
import { ensureReady } from './raw-pipeline.worker-handlers';
import { LensProfileRestorer } from '../lens/lens-profile-restorer';

const restorer = new LensProfileRestorer(async (xmp) => {
  await ensureReady();
  return selectedLensProfile(xmp);
}, restoreCachedProfile);
const waiting = new Map<number, () => void>();
let nextFetch = 1;
export function lensProfileRestored(id: number): void {
  waiting.get(id)?.();
  waiting.delete(id);
}
function requestRestore(reference: string): Promise<void> {
  const id = nextFetch++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    postMessage({ id, type: 'lens-profile-fetch', reference });
  });
}
export function restoreLensProfile(xmp: string | null): Promise<void> {
  return restorer.restore(xmp);
}

async function restoreCachedProfile(reference: string, digest: string): Promise<boolean> {
  let xml = await cachedLensProfile(reference);
  if (!xml) {
    await requestRestore(reference);
    xml = await cachedLensProfile(reference);
  }
  // Let the renderer decide: embedded corrections take priority, and a master-
  // disabled selection needs no external bytes. Otherwise core reports missing.
  if (!xml) return false;
  const registered: { reference: string } = JSON.parse(registerLensProfile(xml));
  if (lensProfileDigest(registered.reference) !== digest)
    throw new Error('The cached lens profile does not match this edit. Import the original LCP.');
  return true;
}

export async function importLensProfile(req: LensProfileRequest): Promise<void> {
  await ensureReady();
  const registration: Omit<ImportedLensProfile, 'resolution'> = JSON.parse(
    registerLensProfile(req.xml),
  );
  const resolution: ImportedLensProfile['resolution'] = JSON.parse(
    resolveLensProfile(new Uint8Array(req.bytes), req.ext, registration.reference),
  );
  // Persist before reporting success: committing an edit whose only profile
  // copy lives in this worker would strand it after the browser is closed.
  await cacheLensProfile(registration.reference, req.xml);
  restorer.registered(registration.reference);
  const reply: LensProfileSuccess = {
    id: req.id,
    type: 'lens-profile-success',
    profile: { ...registration, resolution },
  };
  postMessage(reply);
}
