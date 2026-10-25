/**
 * Sweep-side handling of the `.mapleignore` folder marker (#5398).
 *
 * When `visitDirectory` finds the marker it calls {@link excludeIgnoredDirectory}
 * instead of reconciling the directory: nothing below it is enqueued or
 * ingested, and every live location still recorded in the directory or its
 * subtree is tagged missing — the same per-location tag a `removed` event
 * writes. From there the existing missing-reaper takes over unchanged: the
 * asset drops out of reads at once (no live location left), and after the
 * prune window its location is pruned, or the asset soft-deleted
 * (`deleted_reason: 'reaped'`) when that was its last one. Dedup, thumbnails,
 * search and cloud-backup bookkeeping follow from that path, not from here.
 *
 * Nothing on disk is touched — not the originals, not their sidecars, not the
 * marker. The only writes are location tags and change-feed events.
 *
 * Removing the marker needs no code here: the next sweep descends into the
 * directory again, the reaper recovers locations still in their window (their
 * file is present and no longer under a marker), and discover's content-dedup
 * revives assets the reaper already soft-deleted.
 */
import path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { tagLocationMissing } from '../../db/repos/assets.discover.ts';
import { listLiveLocationsUnder } from '../../db/repos/assets.mapleignore.ts';
import { ignoreVerdictForFile, MAPLE_IGNORE_MARKER } from '../../fs/mapleignore.ts';
import { libraryRootAvailable } from '../missing-reaper.helpers.ts';
import { toPosixRelDir, type WatchEvent } from './types.ts';
import { child } from '../../log.ts';

const log = child('discover');

/** `missing_reason` written on locations excluded by the marker. */
export const MAPLE_IGNORE_MISSING_REASON = 'mapleignore';

/** Bounded page of locations tagged per read, so a marker dropped on a folder
 * of tens of thousands of photos never buffers them all at once. */
const BATCH_SIZE = 500;

/**
 * Exclude the marked directory `dirPath` and its subtree. Returns the number
 * of locations tagged this visit (0 in the steady state).
 *
 * The marker itself is positive evidence — it was just listed — but the
 * library-root availability guard still runs before anything is tagged, so a
 * stale or half-mounted share can never turn into a mass exclusion.
 */
export async function excludeIgnoredDirectory(
  folderId: ObjectId,
  root: string,
  dirPath: string,
): Promise<number> {
  const rel = toPosixRelDir(path.relative(root, dirPath));
  if (rel === '') {
    log.warn(
      { root, marker: path.join(root, MAPLE_IGNORE_MARKER) },
      '.mapleignore at the LIBRARY ROOT — the whole library is excluded from indexing; delete the marker to index it again',
    );
  }
  if (!(await libraryRootAvailable(root))) {
    log.warn({ dir: dirPath, root }, '.mapleignore found but library root unavailable — skipping');
    return 0;
  }

  const tagged = await tagSubtree(folderId, root, rel);
  if (tagged > 0) {
    log.info({ dir: dirPath, count: tagged }, '.mapleignore: excluded indexed files from library');
  }
  return tagged;
}

async function tagSubtree(folderId: ObjectId, root: string, rel: string): Promise<number> {
  let total = 0;
  let after = 0;
  for (;;) {
    const batch = await listLiveLocationsUnder(folderId, rel, after, BATCH_SIZE);
    if (batch.length === 0) return total;
    const at = new Date().toISOString();
    for (const location of batch) {
      const key = { library_id: folderId, path: location.path, filename: location.filename };
      const result = await tagLocationMissing(key, MAPLE_IGNORE_MISSING_REASON, at);
      if (!result) continue;
      total++;
      await recordAndPublishAssetChange({
        kind: result.fullyGone ? 'delete' : 'update',
        asset_id: result.assetId,
        folder_id: folderId,
        abs_path: path.join(root, ...location.path.split('/').filter(Boolean), location.filename),
      });
    }
    after = batch[batch.length - 1]!.id;
  }
}

/**
 * Chokepoint check for `handleEvent`: true when a created/modified/renamed
 * event lands under an ignored directory and must not be ingested. Every
 * producer other than the sweep (imports, browse indexing, pano on-demand,
 * folder rescans) reaches the catalog through here, so this is what makes
 * the marker hold for them too. An `unknown` verdict (a marker stat error)
 * also refuses: the event is dropped and the next sweep retries the file.
 * `removed` events pass — tagging a vanished file missing is right either way.
 */
export async function refusesIgnoredTreeEvent(
  event: Pick<WatchEvent, 'kind' | 'absPath'>,
  libraryRoot: string,
): Promise<boolean> {
  if (event.kind === 'removed') return false;
  const verdict = await ignoreVerdictForFile(libraryRoot, event.absPath);
  if (verdict === 'indexed') return false;
  log.debug({ absPath: event.absPath, verdict }, 'event under a .mapleignore folder — refusing');
  return true;
}
