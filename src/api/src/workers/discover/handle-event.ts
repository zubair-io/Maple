/**
 * Discover producer — event handler.
 *
 * Owns the per-event logic every discovery producer funnels into (sweep,
 * imports hand-off, browse indexing, pano on-demand, folder walkers):
 *   - removed → tag the vanished location missing
 *   - renamed → rewrite the location in place
 *   - created/modified → hash the file, dedup by content, insert-or-append
 *
 * Lifted out of `index.ts` to keep the entry-point thin. Exported so
 * integration tests can drive events directly. See `discover.test.ts`.
 *
 * Every database verb below lives in `db/sqlite/repos/assets.discover.ts`; this
 * module owns the decisions and the filesystem confirmations, which is what the
 * chokepoint guards are about.
 */
import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import type { WatchEvent } from './types.ts';
import { ALL_STAGE_NAMES } from '../stages/manifest.ts';
import { child } from '../../log.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import {
  adoptSha1Head,
  findAssetAtLocation,
  releaseChangedLocation,
  renameLocation,
  tagLocationMissing,
  type LocationKey,
} from '../../db/sqlite/repos/assets.discover.ts';
import {
  findAssetForContent,
  insertDiscoveredAsset,
  isMapleIdConflict,
  type DedupRefresh,
} from '../../db/sqlite/repos/assets.discover.dedup.ts';
import { appendOrRefreshLocation } from './dedup-location.ts';
import { hashFileForId } from '../../indexer/id.ts';
import { directoryHasKeepFile } from '../../fs/duplicates.ts';
import { libraryRootAvailable, statKind } from '../missing-reaper.helpers.ts';
import { buildFileinfoEntry } from './types.ts';
import { refusesReservedTreeEvent } from './reserved-trees.ts';
import { classifyMediaType } from '../../indexer/media-types.ts';

const log = child('discover');

/**
 * `libraryRoot` is the absolute filesystem path of the library that owns
 * `folderId`. The supervisor caches this from the folders table at boot (see
 * `startDiscover`) so handleEvent doesn't pay a round-trip per event. Tests
 * that drive `handleEvent` directly must pass it.
 */
export async function handleEvent(
  event: WatchEvent,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  const { kind, absPath, fromPath } = event;

  // Reserved trees (`.maple/` cache, `_duplicates/` quarantine) must never be
  // indexed, whatever the producer — see `reserved-trees.ts` for why.
  if (refusesReservedTreeEvent(event, libraryRoot)) return;

  if (kind === 'removed') return handleRemoved(absPath, folderId, libraryRoot);
  if (kind === 'renamed' && fromPath)
    return handleRenamed(fromPath, absPath, folderId, libraryRoot);
  return handleCreatedOrModified(kind, absPath, folderId, libraryRoot);
}

/**
 * Chokepoint guard (#2171): every `removed` producer flows through here, so the
 * claim is re-confirmed before the tag is written. A present file, an
 * inconclusive stat (EACCES/EIO), or an unavailable library root (an unmounted
 * mount is a present-but-empty dir under which everything ENOENTs) all refuse
 * the tag — a present file must never be marked missing, and a missing ROOT
 * must never read as per-file deletions.
 */
async function handleRemoved(
  absPath: string,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  const removed = buildFileinfoEntry(libraryRoot, absPath, folderId);
  if (!removed) {
    log.warn({ libraryRoot, absPath }, 'removed event escapes library root — skipping');
    return;
  }
  if ((await statKind(absPath)) !== 'absent') {
    log.warn({ absPath }, 'removed event but file stats non-absent — refusing to tag');
    return;
  }
  if (!(await libraryRootAvailable(libraryRoot))) {
    log.warn(
      { absPath, libraryRoot },
      'removed event but library root unavailable — refusing to tag',
    );
    return;
  }

  // Tag ONLY the vanished location (first detection wins) — never the whole
  // asset. A deduped asset with copies elsewhere stays visible and claimable on
  // its other live entries; the missing-reaper re-stats THIS entry and either
  // recovers it (file reappeared) or prunes it past the window, deleting the
  // record only when no entry remains.
  const tagged = await tagLocationMissing(removed, 'watch-removed', new Date().toISOString());
  if (!tagged) {
    log.info({ absPath }, 'removed event but no matching row — skipping');
    return;
  }

  // Was that the last live location? If so the asset is now hidden (no live
  // entry) — surface a `delete`. Otherwise a copy survives, so this is an
  // `update` (the asset lost one of its locations).
  const { assetId, fullyGone } = tagged;
  log.info(
    { absPath, fullyGone },
    fullyGone ? 'last location missing — asset hidden' : 'location missing — asset still live',
  );
  await recordAndPublishAssetChange({
    kind: fullyGone ? 'delete' : 'update',
    asset_id: assetId,
    folder_id: folderId,
    abs_path: absPath,
  });
}

/** A rename is not a new location — the entry moves in place, so the asset's
 * location count is unchanged and its `_id` survives. Surfaced as an `update`
 * so File Provider clients pick up the new filename. */
async function handleRenamed(
  fromPath: string,
  absPath: string,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  const fromEntry = buildFileinfoEntry(libraryRoot, fromPath, folderId);
  if (!fromEntry) {
    log.warn({ libraryRoot, fromPath }, 'rename source escapes library root — skipping');
    return;
  }
  const entry = buildFileinfoEntry(libraryRoot, absPath, folderId);
  if (!entry) {
    log.warn({ libraryRoot, absPath }, 'rename target escapes library root — skipping');
    return;
  }

  const assetId = await renameLocation(fromEntry, entry, new Date().toISOString());
  if (!assetId) {
    log.warn({ fromPath, absPath }, 'renamed event but no existing row — skipping');
    return;
  }
  log.info({ from: fromPath, to: absPath }, 'renamed');
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: assetId,
    folder_id: folderId,
    abs_path: absPath,
  });
}

/**
 * created or modified — hash, then dedup by content.
 *
 * Hashing happens here rather than in a post-insert stage so the unique dedup
 * index is the gate: when two files have identical content the second event
 * records a location on the existing row instead of inserting a second one.
 */
async function handleCreatedOrModified(
  kind: WatchEvent['kind'],
  absPath: string,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  // Hard-skip when the file escapes the library root — better a warning and a
  // dropped event than a row with no valid location, which would violate the
  // invariant that every live asset has at least one.
  const baseEntry = buildFileinfoEntry(libraryRoot, absPath, folderId);
  if (!baseEntry) {
    log.warn({ libraryRoot, absPath }, 'event absPath escapes library root — skipping insert');
    return;
  }
  // Record whether this location is operator-protected: a `.keep` marker file
  // in the same directory pins every copy here against the DeDuplicate worker.
  // Stored for read-side visibility; the worker re-confirms the marker on disk
  // before acting (it can be added or removed after first index).
  const keep = await directoryHasKeepFile(path.dirname(absPath));
  const entry = { ...baseEntry, keep };

  let hashed: Awaited<ReturnType<typeof hashFileForId>>;
  try {
    hashed = await hashFileForId(absPath);
  } catch (err) {
    // hashFileForId opens + reads + stats the file. ENOENT here means the file
    // was unlinked between the watcher fire and our read; treat it like a stat
    // failure and let the next sweep re-fire.
    log.warn(
      { absPath, err: err instanceof Error ? err.message : err },
      'hash failed after watch event — skipping',
    );
    return;
  }
  const now = new Date().toISOString();
  await reconcileStaleContentAt(entry, hashed.sha1_head, absPath);

  const refresh: DedupRefresh = { indexedAt: now, mtime: hashed.mtime, size: hashed.size };
  const existing = await findAssetForContent(hashed.maple_id, hashed.sha1_head);
  if (existing) {
    // Same content — record the new location if the row has not seen it,
    // refresh timestamps, revive a soft-deleted row (#2977). No user-edited
    // field is touched on a dedup hit.
    const dedup = await appendOrRefreshLocation(existing, entry, refresh, keep);
    if (dedup === 'append') {
      log.info({ absPath, maple_id: hashed.maple_id, dedup: 'append' }, 'deduped — new location');
    } else {
      log.debug({ absPath, maple_id: hashed.maple_id, dedup: 'noop' }, 'idempotent re-discover');
    }
    await publishDiscovered(kind, existing.id, folderId, absPath);
    return;
  }

  try {
    const insertedId = await insertDiscoveredAsset({
      entry,
      mapleId: hashed.maple_id,
      sha1Head: hashed.sha1_head,
      size: hashed.size,
      mtime: hashed.mtime,
      indexedAt: now,
      mediaKind: classifyMediaType(entry.filename),
      stages: ALL_STAGE_NAMES,
    });
    log.info({ absPath, kind, maple_id: hashed.maple_id }, 'inserted');
    await publishDiscovered(kind, insertedId, folderId, absPath);
  } catch (err) {
    // A dedup-id collision means another worker inserted this content between
    // our lookup and our insert. Fall back to the append path against the
    // winner — `keep` is intentionally omitted, mirroring the pre-cutover
    // behaviour where the race-loser path never rewrote the flag.
    if (!isMapleIdConflict(err)) throw err;
    const winner = await findAssetForContent(hashed.maple_id, hashed.sha1_head);
    if (!winner) throw err;
    await appendOrRefreshLocation(winner, entry, refresh, undefined);
    log.info(
      { absPath, maple_id: hashed.maple_id, dedup: 'race-loser' },
      'race lost — appended to winner',
    );
    await publishDiscovered(kind, winner.id, folderId, absPath);
  }
}

/**
 * Modified-file new-content guard.
 *
 * A file at an existing location may have been modified to NEW content. The
 * content lookup below would miss (new content) and insert a new row, leaving
 * the OLD row still claiming this path — which the UNIQUE index over
 * `(library_id, path, filename)` refuses outright. So the old row gives the
 * location up first; see `releaseChangedLocation` for what that costs and why
 * the cost is the right one.
 *
 * The comparison is on `sha1_head`, which is invariant for a row's lifetime,
 * NOT on `maple_id` — the exif stage rewrites `maple_id` in place when it
 * upgrades the fallback id to the primary form, so a mismatch there means the
 * row has been through the upgrade rather than that the bytes changed.
 *
 * A row with no recorded hash predates content hashing, so its absence is not
 * evidence of a change: adopt the computed hash instead. Treating it as a
 * mismatch (#2171) dual-flagged the present, unchanged file and inserted a
 * duplicate — again on every subsequent sweep, since neither row ever gained
 * the field.
 */
async function reconcileStaleContentAt(
  entry: LocationKey,
  sha1Head: string,
  absPath: string,
): Promise<void> {
  const stale = await findAssetAtLocation(entry);
  if (!stale) return;
  if (stale.sha1Head === null) {
    await adoptSha1Head(stale.id, sha1Head);
    log.info(
      { absPath, sha1_head: sha1Head },
      'legacy row without sha1_head — adopted hash from on-disk file',
    );
    return;
  }
  if (stale.sha1Head === sha1Head) return;
  await releaseChangedLocation(entry);
  log.info(
    { absPath, old_sha1_head: stale.sha1Head, new_sha1_head: sha1Head },
    'file content changed — released the location from the old row',
  );
}

function publishDiscovered(
  kind: WatchEvent['kind'],
  assetId: ObjectId,
  folderId: ObjectId,
  absPath: string,
): Promise<void> {
  return recordAndPublishAssetChange({
    kind: kind === 'created' ? 'create' : 'update',
    asset_id: assetId,
    folder_id: folderId,
    abs_path: absPath,
  });
}
