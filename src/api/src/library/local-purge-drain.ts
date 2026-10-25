/**
 * Drains `local_purge_obligations` (#5403): the files a kept-photo purge owes
 * the disk. Every attempt re-checks the guards from scratch: the trashed copy
 * and its sidecars must still resolve inside `.maple/trash/`, a companion must
 * still pass its library jail, nothing under a `.mapleignore` marker is
 * touched, and a path some photo has since claimed is never unlinked. Failures
 * back off on the stage retry ladder and stay recorded until they succeed.
 */

import * as path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { assetOwnsRelPath } from '../db/repos/assets.location-owner.ts';
import {
  completeLocalPurge,
  deferLocalPurge,
  dueLocalPurges,
  type LocalPurgeObligation,
} from '../db/repos/local-purge.repo.ts';
import { refusesFileUnderMarker } from '../fs/mapleignore-guard.ts';
import { unlinkPrimaryForPurge } from '../fs/mirrored.ts';
import { errnoCode } from '../fs/relocate-publish.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { child as childLogger } from '../log.ts';
import { retryDelayMs } from '../workers/loop-policy.ts';
import { resolvePurgeCompanion } from './purge-rendered-companion.ts';
import { checkTrashPurgeTarget } from './trashed-copy.ts';

const log = childLogger('local-purge');

export interface LocalPurgeDrainSummary {
  done: number;
  pending: number;
}

/** The path to unlink now, or null when nothing may or needs to be unlinked. */
async function unlinkTarget(row: LocalPurgeObligation, root: string): Promise<string | null> {
  if (await assetOwnsRelPath(new ObjectId(row.library_id), row.owner_rel_path)) return null;
  if (row.kind === 'companion') {
    const companion = await resolvePurgeCompanion(root, row.rel_path, '');
    return companion !== null && !(await refusesFileUnderMarker(companion)) ? companion : null;
  }
  const canonical = await checkTrashPurgeTarget(path.join(root, ...row.rel_path.split('/')), root);
  if (canonical !== null && (await refusesFileUnderMarker(canonical))) {
    throw new Error('Trash path is under a .mapleignore marker');
  }
  return canonical;
}

async function attempt(
  row: LocalPurgeObligation,
  libraries: ReadonlyMap<string, string>,
): Promise<void> {
  const root = libraries.get(row.library_id);
  if (!root) throw new Error('Library root is not registered');
  const target = await unlinkTarget(row, root);
  if (target === null) return;
  try {
    await unlinkPrimaryForPurge(target);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
}

export async function drainLocalPurges(
  options: { assetId?: string; now?: number } = {},
): Promise<LocalPurgeDrainSummary> {
  const now = options.now ?? Date.now();
  const rows = await dueLocalPurges(now, options.assetId);
  if (rows.length === 0) return { done: 0, pending: 0 };
  const libraries = await loadLibraryRoots().catch(() => new Map<string, string>());
  const outcomes: boolean[] = [];
  for (const row of rows) {
    try {
      await attempt(row, libraries);
      await completeLocalPurge(row.id);
      outcomes.push(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(
        { obligation: row.id, relPath: row.rel_path, err: message },
        'purge cleanup deferred',
      );
      await deferLocalPurge(row.id, now + retryDelayMs(row.attempts + 1), message);
      outcomes.push(false);
    }
  }
  const done = outcomes.filter(Boolean).length;
  return { done, pending: outcomes.length - done };
}
