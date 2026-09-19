/**
 * Mirror config loader — bridges the persisted `FolderDoc.mirrors` settings into
 * the in-memory `mirror-registry.ts` the hot path consults.
 *
 * Call `loadMirrorConfig()` once at startup, and again after any change to a
 * library's mirror set (the `/api/folders/:id/mirror` route does this) so the
 * registry stays in sync without a restart — per the project rule that runtime
 * config is operator-toggleable, not env-gated.
 */

import { listFoldersWithMirrors } from '../db/repos/folders.repo.ts';
import { setMirrorRoots } from './mirror-registry.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('fs/mirror-config');

/**
 * Read every library's enabled mirror roots and (re)build the registry. A
 * disabled mirror is excluded — replication and failover skip it — but its
 * configuration is preserved in the database so the operator can re-enable it.
 *
 * `listFoldersWithMirrors` already drops libraries whose mirror list is unset or
 * empty, which is what `{ 'mirrors.0': { $exists: true } }` selected for; the
 * enabled filter below stays here because "configured but switched off" is a
 * registry decision, not a storage one.
 */
export async function loadMirrorConfig(): Promise<void> {
  const folders = await listFoldersWithMirrors();

  const map = new Map<string, string[]>();
  for (const folder of folders) {
    const enabled = folder.mirrors.filter((m) => m.enabled).map((m) => m.path);
    if (enabled.length > 0) map.set(folder.path, enabled);
  }
  setMirrorRoots(map);
  log.info({ libraries: map.size }, 'mirror config loaded');
}
