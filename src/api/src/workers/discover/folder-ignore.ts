/**
 * Discover-side handling of the `.mapleignore` folder marker (#5398).
 *
 * A marked directory leaves the index the way deleted files do: each live
 * location under it is tagged missing exactly as a `removed` event tags one,
 * and the missing-reaper prunes or soft-deletes from there unchanged. Nothing
 * on disk is touched. Removing the marker needs no code here: the sweep
 * descends again, the reaper recovers in-window locations, and content-dedup
 * revives soft-deleted assets.
 */
import path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { tagLocationMissing } from '../../db/repos/assets.discover.ts';
import {
  listLiveLocationsIn,
  relabelMissingAsExcluded,
  subtreeRuns,
  type IgnoredLiveLocation,
} from '../../db/repos/assets.mapleignore.ts';
import {
  ignoreVerdictForDir,
  ignoreVerdictForFile,
  listingHasIgnoreMarker,
  MAPLE_IGNORE_MARKER,
  MAPLE_IGNORE_MISSING_REASON,
} from '../../fs/mapleignore.ts';
import { libraryRootAvailable } from '../missing-reaper.helpers.ts';
import { toPosixRelDir, type WatchEvent } from './types.ts';
import { child } from '../../log.ts';

const log = child('discover');

const BATCH_SIZE = 500;

/**
 * The sweep's gate, run before anything else in a directory visit: true when
 * the visit must stop. A marked directory is excluded here. A directory under
 * a marked ancestor (queued before the marker appeared), or whose chain cannot
 * be checked, is skipped outright — the visit's rename reconciliation moves
 * sidecars on disk, so it must never run under a marker. The marked
 * ancestor's own visit tags this subtree.
 */
export async function skipsIgnoredDirectory(
  folderId: ObjectId,
  root: string,
  dirPath: string,
  entries: readonly { name: string }[],
): Promise<boolean> {
  if (
    await listingHasIgnoreMarker(
      dirPath,
      entries.map((e) => e.name),
    )
  ) {
    await excludeIgnoredDirectory(folderId, root, dirPath);
    return true;
  }
  const verdict = await ignoreVerdictForDir(root, dirPath);
  if (verdict === 'indexed') return false;
  log.info({ dir: dirPath, verdict }, 'sweep: directory under a .mapleignore folder — skipping');
  return true;
}

/**
 * Exclude the marked directory `dirPath` and its subtree. The marker was just
 * listed, but the library-root availability guard still runs first, so a
 * half-mounted share can never turn into a mass exclusion.
 */
async function excludeIgnoredDirectory(
  folderId: ObjectId,
  root: string,
  dirPath: string,
): Promise<void> {
  const rel = toPosixRelDir(path.relative(root, dirPath));
  if (rel === '') {
    log.warn(
      { root, marker: path.join(root, MAPLE_IGNORE_MARKER) },
      '.mapleignore at the LIBRARY ROOT — the whole library is excluded from indexing; delete the marker to index it again',
    );
  }
  if (!(await libraryRootAvailable(root))) {
    log.warn({ dir: dirPath, root }, '.mapleignore found but library root unavailable — skipping');
    return;
  }

  let tagged = 0;
  for (const run of subtreeRuns(rel)) {
    tagged += await forEachPage(
      (after) => listLiveLocationsIn(folderId, run, after, BATCH_SIZE),
      (location) => tagExcluded(folderId, root, location),
    );
    tagged += await relabelMissingAsExcluded(folderId, run);
  }
  if (tagged > 0) {
    log.info({ dir: dirPath, count: tagged }, '.mapleignore: excluded indexed files from library');
  }
}

async function forEachPage(
  page: (after: IgnoredLiveLocation | null) => Promise<IgnoredLiveLocation[]>,
  fn: (location: IgnoredLiveLocation) => Promise<boolean>,
): Promise<number> {
  let total = 0;
  let after: IgnoredLiveLocation | null = null;
  for (;;) {
    const batch = await page(after);
    if (batch.length === 0) return total;
    for (const location of batch) if (await fn(location)) total++;
    after = batch[batch.length - 1]!;
  }
}

async function tagExcluded(
  folderId: ObjectId,
  root: string,
  location: IgnoredLiveLocation,
): Promise<boolean> {
  const key = { library_id: folderId, path: location.path, filename: location.filename };
  const result = await tagLocationMissing(
    key,
    MAPLE_IGNORE_MISSING_REASON,
    new Date().toISOString(),
  );
  if (!result) return false;
  await recordAndPublishAssetChange({
    kind: result.fullyGone ? 'delete' : 'update',
    asset_id: result.assetId,
    folder_id: folderId,
    abs_path: path.join(root, ...location.path.split('/').filter(Boolean), location.filename),
  });
  return true;
}

/**
 * Chokepoint check for `handleEvent`, which every producer other than the
 * sweep (imports, browse indexing, pano on-demand, rescans) reaches the catalog
 * through. An `unknown` verdict also refuses: the event is dropped and the
 * next sweep retries the file. `removed` passes, since tagging a vanished file
 * is right either way, and so does a sweep event: the sweep's gate already
 * checked the directory chain before the visit did anything.
 */
export async function refusesIgnoredTreeEvent(
  event: Pick<WatchEvent, 'kind' | 'absPath' | 'markerChainChecked'>,
  libraryRoot: string,
): Promise<boolean> {
  if (event.kind === 'removed' || event.markerChainChecked) return false;
  const verdict = await ignoreVerdictForFile(libraryRoot, event.absPath);
  if (verdict === 'indexed') return false;
  log.debug({ absPath: event.absPath, verdict }, 'event under a .mapleignore folder — refusing');
  return true;
}
