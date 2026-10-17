import { hasUnregisteredLibrary } from '../../indexer/libraries.cache.ts';
import type { StageResult } from '../stage-config.ts';

const UNREGISTERED_LIBRARY_RETRY_MS = 60_000;

type AssetLocations = Parameters<typeof hasUnregisteredLibrary>[0];

/**
 * Outcome for an asset whose on-disk path could not be resolved. A live
 * location in a library this process has not seen yet is a stale registry, not
 * a finished asset, so it is deferred instead of being marked permanently done.
 */
export function noResolvableLocation(
  asset: AssetLocations,
  libs: ReadonlyMap<string, string>,
): StageResult {
  return hasUnregisteredLibrary(asset, libs)
    ? {
        defer: {
          reason: 'library-not-registered',
          retryAt: new Date(Date.now() + UNREGISTERED_LIBRARY_RETRY_MS),
        },
      }
    : { skip: 'no-resolvable-location' };
}
