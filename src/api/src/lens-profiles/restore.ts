/** Call within the isolated, single-flight render child before rendering this exact XMP. */
import { loadLensProfile } from './cache.ts';
import {
  clearLensProfiles,
  registerLensProfile,
  resolveLensProfile,
  selectedLensProfile,
} from './native.ts';
import { lensProfileDigest } from './types.ts';

export async function restoreLensProfile(rawPath: string, xmpXml: string | null): Promise<void> {
  clearLensProfiles();
  if (!xmpXml) return;
  const selected = selectedLensProfile(xmpXml);
  if (!selected.reference || !selected.enabled) return;
  const digest = lensProfileDigest(selected.reference);
  await restoreCachedBytes(digest);
  // Even a missing external cache is allowed when the RAW's embedded model wins.
  // Otherwise the core reports the missing profile explicitly before pixel I/O.
  resolveLensProfile(rawPath, selected.reference);
}

async function restoreCachedBytes(digest: string): Promise<void> {
  const bytes = await loadLensProfile(digest);
  if (bytes) {
    const inventory = registerLensProfile(bytes);
    if (lensProfileDigest(inventory.reference) !== digest)
      throw new Error('LCP cache identity mismatch');
  }
}
