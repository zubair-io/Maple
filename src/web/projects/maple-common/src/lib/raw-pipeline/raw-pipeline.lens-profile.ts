import { registerLensProfile, resolveLensProfile, selectedLensProfile } from './pkg/raw_wasm';
import { cachedLensProfile, cacheLensProfile, lensProfileDigest } from '../lens/lens-profile-cache';
import type {
  ImportedLensProfile,
  LensProfileRequest,
  LensProfileSuccess,
} from '../lens/lens-profile.types';
import { ensureReady } from './raw-pipeline.worker-handlers';

const loaded = new Set<string>();
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
let previousAttribute: string | null = null;
let previousReference = '';

/** Empty selection performs no IDB I/O; repeated ticks only read the cache. */
export async function restoreLensProfile(xmp: string | null): Promise<void> {
  if (!xmp) return;
  const attribute = /(?:^|\s)papp:LensProfile\s*=\s*(["'])(.*?)\1/s.exec(xmp)?.[2] ?? '';
  if (!attribute) return;
  await ensureReady();
  if (previousAttribute !== attribute) {
    previousReference = selectedLensProfile(xmp);
    previousAttribute = attribute;
  }
  const reference = previousReference;
  if (!reference) return;
  const digest = lensProfileDigest(reference);
  if (loaded.has(digest)) return;
  try {
    await restoreCachedProfile(reference, digest);
  } catch {
    // Storage denial or corrupt cached bytes cannot block an embedded or
    // disabled correction. Core still fails explicitly if this LCP is required.
  }
}

async function restoreCachedProfile(reference: string, digest: string): Promise<void> {
  let xml = await cachedLensProfile(reference);
  if (!xml) {
    await requestRestore(reference);
    xml = await cachedLensProfile(reference);
  }
  // Let the renderer decide: embedded corrections take priority, and a master-
  // disabled selection needs no external bytes. Otherwise core reports missing.
  if (!xml) return;
  const registered: { reference: string } = JSON.parse(registerLensProfile(xml));
  if (lensProfileDigest(registered.reference) !== digest)
    throw new Error('The cached lens profile does not match this edit. Import the original LCP.');
  loaded.add(digest);
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
  loaded.add(lensProfileDigest(registration.reference));
  const reply: LensProfileSuccess = {
    id: req.id,
    type: 'lens-profile-success',
    profile: { ...registration, resolution },
  };
  postMessage(reply);
}
