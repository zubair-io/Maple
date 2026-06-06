/**
 * Mirror config loader — bridges the Mongo-backed `FolderDoc.mirrors` settings
 * into the in-memory `mirror-registry.ts` the hot path consults.
 *
 * Call `loadMirrorConfig()` once at startup, and again after any change to a
 * library's mirror set (the `/api/folders/:id/mirror` route does this) so the
 * registry stays in sync without a restart — per the project rule that runtime
 * config is operator-toggleable, not env-gated.
 */

import { foldersCollection } from '../db/client.ts';
import { setMirrorRoots } from './mirror-registry.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/mirror-config');

/**
 * Read every library's enabled mirror roots from Mongo and (re)build the
 * registry. A disabled mirror is excluded — replication and failover skip it —
 * but its configuration is preserved in the DB so the operator can re-enable it.
 */
export async function loadMirrorConfig(): Promise<void> {
  const coll = await foldersCollection();
  const folders = await coll.find({ 'mirrors.0': { $exists: true } }).toArray();

  const map = new Map<string, string[]>();
  for (const f of folders) {
    const enabled = (f.mirrors ?? []).filter((m) => m.enabled).map((m) => m.path);
    if (enabled.length > 0) map.set(f.path, enabled);
  }
  setMirrorRoots(map);
  log.info({ libraries: map.size }, 'mirror config loaded');
}
