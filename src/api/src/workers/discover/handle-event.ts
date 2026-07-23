/**
 * Discover producer — event handler.
 *
 * Owns the per-event logic that the chokidar watcher fires into:
 *   - removed → soft-delete the matching row
 *   - renamed → rewrite `fileinfo[N]` in place
 *   - created/modified → hash the file, dedup by `maple_id`, insert-or-append
 *
 * Lifted out of `index.ts` to keep the entry-point thin; the watcher wiring
 * in `startDiscover` calls `handleEvent` once per debounced event.
 *
 * Exported so integration tests can simulate events without waiting for the
 * watcher's polling interval. See `discover.test.ts`.
 */
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import type { WatchEvent } from './types.ts';
import { blankStagesSkeleton } from '../stages/manifest.ts';
import { child } from '../../log.ts';
import { assetsCollection } from '../../db/client.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { hashFileForId } from '../../indexer/id.ts';
import { liveFileInfoElemMatch, updateLiveLocationCount } from '../../indexer/images.repo.ts';
import { directoryHasKeepFile } from '../../fs/duplicates.ts';
import { libraryRootAvailable, statKind } from '../missing-reaper.helpers.ts';
import { buildFileinfoEntry, isInsideMapleCache } from './types.ts';

const log = child('discover');

/**
 * Exported for integration tests — allows tests to simulate events without
 * waiting for chokidar's polling interval (60s/300s in production config).
 *
 * `libraryRoot` is the absolute filesystem path of the library that owns
 * `folderId`. The supervisor caches this from the folders collection at
 * boot (see `startDiscover`) so handleEvent doesn't pay a Mongo round-trip
 * per FS event. Tests that drive `handleEvent` directly must pass it.
 */
export async function handleEvent(
  event: WatchEvent,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  const { kind, absPath, fromPath } = event;

  // Defense-in-depth: refuse any event whose absPath lives inside our own
  // derivative cache. The sweeper filters `.maple/` at directory-walk time,
  // so this branch should never fire in practice — but if a future event
  // source (re-introduced watcher, manual enqueue, etc.) forgets to filter,
  // refusing here keeps the bug local instead of letting it poison the
  // assets collection. See the issue/PR that introduced this guard for the
  // recursive `.maple/.maple/…` failure mode it prevents.
  if (isInsideMapleCache(libraryRoot, absPath)) {
    log.warn({ libraryRoot, absPath, kind }, 'event inside .maple cache — refusing');
    return;
  }
  if (kind === 'renamed' && fromPath && isInsideMapleCache(libraryRoot, fromPath)) {
    log.warn({ libraryRoot, fromPath, kind }, 'rename from .maple cache — refusing');
    return;
  }

  const coll = await assetsCollection();

  if (kind === 'removed') {
    const removed = buildFileinfoEntry(libraryRoot, absPath, folderId);
    if (!removed) {
      log.warn({ libraryRoot, absPath }, 'removed event escapes library root — skipping');
      return;
    }
    // Chokepoint guard (#2171): every `removed` producer flows through here,
    // so re-confirm the claim before the tag is written. A present file, an
    // inconclusive stat (EACCES/EIO), or an unavailable library root (an
    // unmounted mount is a present-but-empty dir under which everything
    // ENOENTs) all refuse the tag — a present file must never be marked
    // missing, and a missing ROOT must never read as per-file deletions.
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
    const now = new Date().toISOString();
    const existing = await coll.findOne(
      {
        fileinfo: {
          $elemMatch: { library_id: folderId, path: removed.path, filename: removed.filename },
        },
      },
      { projection: { _id: 1 } },
    );
    if (!existing) {
      log.info({ absPath }, 'removed event but no matching row — skipping');
      return;
    }
    // Tag ONLY the vanished location `missing_since` (first-detection wins) —
    // never the whole asset. A deduped asset with copies elsewhere stays
    // visible + claimable on its other live entries; the missing-reaper
    // re-stats THIS entry and either recovers it (file reappeared) or `$pull`s
    // it past the prune window, deleting the record only when no entry remains.
    await coll.updateOne(
      { _id: existing._id },
      {
        $set: {
          'fileinfo.$[e].missing_since': now,
          'fileinfo.$[e].missing_reason': 'watch-removed',
        },
      },
      {
        arrayFilters: [
          {
            'e.library_id': folderId,
            'e.path': removed.path,
            'e.filename': removed.filename,
            $or: [{ 'e.missing_since': { $exists: false } }, { 'e.missing_since': null }],
          },
        ],
      },
    );
    // Recompute the denormalized live count after tagging one entry missing.
    await updateLiveLocationCount(coll, existing._id);
    // Was that the last live location? If so the asset is now hidden (no live
    // fileinfo entry) — surface a `delete`. Otherwise a copy survives, so this
    // is an `update` (the asset lost one of its locations). The post-update
    // re-check is race-safe against a concurrent re-add: a freshly appended
    // live entry keeps the asset visible and downgrades this to `update`.
    const stillLive = await coll.findOne(
      { _id: existing._id, ...liveFileInfoElemMatch() },
      { projection: { _id: 1 } },
    );
    const fullyGone = !stillLive;
    log.info(
      { absPath, fullyGone },
      fullyGone ? 'last location missing — asset hidden' : 'location missing — asset still live',
    );
    await recordAndPublishAssetChange({
      kind: fullyGone ? 'delete' : 'update',
      asset_id: existing._id,
      folder_id: folderId,
      abs_path: absPath,
    });
    return;
  }

  if (kind === 'renamed' && fromPath) {
    const fromEntry = buildFileinfoEntry(libraryRoot, fromPath, folderId);
    if (!fromEntry) {
      log.warn({ libraryRoot, fromPath }, 'rename source escapes library root — skipping');
      return;
    }
    const before = await coll.findOne(
      {
        fileinfo: {
          $elemMatch: {
            library_id: folderId,
            path: fromEntry.path,
            filename: fromEntry.filename,
          },
        },
      },
      { projection: { _id: 1, fileinfo: 1 } },
    );
    if (!before) {
      log.warn({ fromPath, absPath }, 'renamed event but no existing row — skipping');
      return;
    }

    // A rename is not a new location — we overwrite the matching entry
    // in place so `fileinfo.length` stays the same.
    const entry = buildFileinfoEntry(libraryRoot, absPath, folderId);
    if (!entry) {
      log.warn({ libraryRoot, absPath }, 'rename target escapes library root — skipping');
      return;
    }
    const list = (before.fileinfo ?? []) as Array<{
      path: string;
      filename: string;
      library_id: ObjectId;
      deleted_at?: string | null;
    }>;
    const matchIdx = list.findIndex(
      (e) =>
        e.library_id.equals(folderId) &&
        e.path === fromEntry.path &&
        e.filename === fromEntry.filename,
    );
    const newFileinfo =
      matchIdx === -1
        ? [entry, ...list]
        : list.map((e, i) => (i === matchIdx ? { ...entry, deleted_at: null } : e));

    await coll.updateOne(
      { _id: before._id },
      {
        $set: {
          fileinfo: newFileinfo,
          indexed_at: new Date().toISOString(),
          deleted_at: null,
        },
      },
    );
    log.info({ from: fromPath, to: absPath }, 'renamed');
    // Renames keep the same _id but change the path — surface as an
    // `update` so File Provider clients pick up the new filename.
    await recordAndPublishAssetChange({
      kind: 'update',
      asset_id: before._id,
      folder_id: folderId,
      abs_path: absPath,
    });
    return;
  }

  // created or modified — hash, then dedup by maple_id.
  //
  // PR 2: hashing moves from the post-insert `hash` stage to here so the
  // unique `maple_id_gt_1` index becomes the dedup gate. When two files have
  // identical content the second event no longer inserts a new row — it
  // $push's a fileinfo entry on the existing row.
  //
  // Hard-skip when the file escapes the library root — we'd rather log a
  // warning and drop the event than insert a row without a valid fileinfo
  // entry (which would violate the invariant that every live asset has
  // length ≥ 1).
  const baseEntry = buildFileinfoEntry(libraryRoot, absPath, folderId);
  if (!baseEntry) {
    log.warn({ libraryRoot, absPath }, 'event absPath escapes library root — skipping insert');
    return;
  }
  // Record whether this location is operator-protected: a `.keep` marker file in
  // the same directory pins every copy here against the DeDuplicate worker. Stored
  // on the fileinfo entry for read-side visibility; the worker re-confirms the
  // marker on disk before acting (it can be added/removed after first index).
  const keep = await directoryHasKeepFile(path.dirname(absPath));
  const fileinfoEntry = { ...baseEntry, keep };

  let hashed: Awaited<ReturnType<typeof hashFileForId>>;
  try {
    hashed = await hashFileForId(absPath);
  } catch (err) {
    // hashFileForId opens + reads + stats the file. ENOENT here means the
    // file was unlinked between the watcher fire and our read; treat like
    // a stat failure (skip the event, watcher will fire again on next
    // poll if the file reappears).
    log.warn(
      { absPath, err: err instanceof Error ? err.message : err },
      'hash failed after watch event — skipping',
    );
    return;
  }
  const now = new Date().toISOString();

  // Modified-file new-content guard: a file at an existing (library, path,
  // filename) location may have been modified to NEW content. The maple_id
  // lookup below won't see this — it'll miss (new content) and try to insert
  // a new row, leaving the OLD row's fileinfo still pointing at this path
  // with the old maple_id. Mark that fileinfo entry deleted first so the
  // old row stops claiming the location.
  //
  // The guard compares `sha1_head` (invariant for the row's lifetime), NOT
  // `maple_id`. maple_id gets rewritten in place by the exif stage when it
  // upgrades the fallback id to the primary form, so a maple_id mismatch on
  // a re-discover does NOT indicate a content change — it indicates the row
  // has been through the upgrade. Comparing sha1_head keeps the idempotent
  // re-discover case unaffected after that upgrade.
  const staleAtPath = await coll.findOne(
    {
      fileinfo: {
        $elemMatch: {
          library_id: fileinfoEntry.library_id,
          path: fileinfoEntry.path,
          filename: fileinfoEntry.filename,
        },
      },
    },
    { projection: { _id: 1, sha1_head: 1 } },
  );
  if (staleAtPath && staleAtPath.sha1_head == null) {
    // Legacy row (predates content hashing): there is NO recorded hash to
    // compare, so a missing `sha1_head` is not evidence of changed content.
    // Treating it as a mismatch (#2171) dual-flagged the present, unchanged
    // file's entry and inserted a duplicate row — again on EVERY subsequent
    // sweep, since neither row ever gained the field. Adopt the computed hash
    // onto the row instead; the sha1_head dedup lookup below then resolves
    // this event to the same row as an idempotent re-discover.
    await coll.updateOne({ _id: staleAtPath._id }, { $set: { sha1_head: hashed.sha1_head } });
    log.info(
      { absPath, sha1_head: hashed.sha1_head },
      'legacy row without sha1_head — adopted hash from on-disk file',
    );
  } else if (staleAtPath && staleAtPath.sha1_head !== hashed.sha1_head) {
    // Flag the entry both deleted_at (content changed) and missing_since (for
    // the missing-reaper to prune/reap it after the cooldown). Doing it in one
    // update is atomic, fast, and ensures even live assets have their stale
    // locations pulled after the cooldown instead of lingering forever.
    await coll.updateOne(
      { _id: staleAtPath._id },
      {
        $set: {
          'fileinfo.$[entry].deleted_at': now,
          'fileinfo.$[missingEntry].missing_since': now,
          'fileinfo.$[missingEntry].missing_reason': 'content-changed',
        },
      },
      {
        arrayFilters: [
          {
            'entry.library_id': fileinfoEntry.library_id,
            'entry.path': fileinfoEntry.path,
            'entry.filename': fileinfoEntry.filename,
          },
          {
            'missingEntry.library_id': fileinfoEntry.library_id,
            'missingEntry.path': fileinfoEntry.path,
            'missingEntry.filename': fileinfoEntry.filename,
            $or: [
              { 'missingEntry.missing_since': { $exists: false } },
              { 'missingEntry.missing_since': null },
            ],
          },
        ],
      },
    );
    // Recompute live count after marking one entry deleted on the old row.
    await updateLiveLocationCount(coll, staleAtPath._id);
    log.info(
      { absPath, old_sha1_head: staleAtPath.sha1_head, new_sha1_head: hashed.sha1_head },
      'file content changed — marked old fileinfo entry deleted',
    );
  }

  // Top-level fields refreshed on every dedup hit. Legacy `abs_path` /
  // `filename` / `folder_id` were dropped by the
  // drop-abs-path-2026-05-21 migration; location lives entirely in
  // `fileinfo[]` now, and the per-entry add/clear-deleted updates
  // alongside this $set keep the row's location accurate.
  const dedupSet = {
    indexed_at: now,
    deleted_at: null,
    mtime: hashed.mtime,
    size: hashed.size,
  };

  // Find any existing row for this content. We project narrowly so the
  // doc body stays small even on libraries with many assets.
  let existing = await coll.findOne(
    { maple_id: hashed.maple_id },
    { projection: { _id: 1, fileinfo: 1 } },
  );
  if (!existing) {
    // Fallback dedup by `sha1_head`. The exif stage upgrades `maple_id`
    // from fallback form (BLAKE3(sha1_head || u64(head_len))) to primary
    // form (BLAKE3(sha1_head || captured_at || …)) once EXIF is available.
    // After that upgrade, the maple_id no longer equals what hashFileForId
    // computes for a fresh duplicate at discover time — the lookup above
    // misses and we'd insert a duplicate row that the exif stage later
    // tries to upgrade into the same primary id, hitting E11000.
    //
    // sha1_head is invariant for the asset's lifetime (set once at insert,
    // never rewritten), so it stays a stable join key across the upgrade.
    // The dedup is consistent with the maple_id design because both forms
    // of the id only consume the first 64 KB of file content (which is
    // exactly what sha1_head hashes), so files that share sha1_head are
    // the same content from the pipeline's point of view.
    existing = await coll.findOne(
      { sha1_head: hashed.sha1_head },
      { projection: { _id: 1, fileinfo: 1 } },
    );
  }

  if (existing) {
    // Same content — record the new location if it's not already on the
    // row, refresh timestamps. We DO NOT touch any user-edited fields
    // (rating, flag, color_label, sidecar mirror, …) on a dedup hit.
    const list = (existing.fileinfo ?? []) as Array<{
      path: string;
      filename: string;
      library_id: ObjectId;
      deleted_at?: string | null;
    }>;
    const dupIdx = list.findIndex(
      (e) =>
        e.library_id.equals(fileinfoEntry.library_id) &&
        e.path === fileinfoEntry.path &&
        e.filename === fileinfoEntry.filename,
    );
    if (dupIdx === -1) {
      // Conditional $push: only append if no entry already matches
      // (library_id, path, filename). A concurrent worker may have seen
      // dupIdx === -1 against the same stale read and raced ahead of us;
      // the $not/$elemMatch filter makes us a no-op in that case. We
      // ignore modifiedCount === 0 silently — the winning worker has
      // already done the work.
      await coll.updateOne(
        {
          _id: existing._id,
          fileinfo: {
            $not: {
              $elemMatch: {
                library_id: fileinfoEntry.library_id,
                path: fileinfoEntry.path,
                filename: fileinfoEntry.filename,
              },
            },
          },
        },
        {
          $push: { fileinfo: fileinfoEntry as never },
          $set: dedupSet,
        },
      );
      // Recompute live count after appending a new live fileinfo entry.
      await updateLiveLocationCount(coll, existing._id);
      log.info({ absPath, maple_id: hashed.maple_id, dedup: 'append' }, 'deduped — new location');
    } else {
      // Already-known location: clear any per-entry deleted_at on a
      // re-discover, refresh top-level timestamps. Use arrayFilters
      // (not a positional index) — a concurrent $push from another
      // worker can shift indices between our findOne and updateOne.
      await coll.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...dedupSet,
            'fileinfo.$[entry].deleted_at': null,
            // Re-discovering a live file at this location un-parks it: clear
            // any per-entry `missing_since` the reaper would otherwise act on.
            'fileinfo.$[entry].missing_since': null,
            'fileinfo.$[entry].missing_reason': null,
            // Refresh the keep flag — a `.keep` marker may have been added or
            // removed since this location was first indexed.
            'fileinfo.$[entry].keep': keep,
          },
        },
        {
          arrayFilters: [
            {
              'entry.library_id': fileinfoEntry.library_id,
              'entry.path': fileinfoEntry.path,
              'entry.filename': fileinfoEntry.filename,
            },
          ],
        },
      );
      // Recompute live count: clearing deleted_at/missing_since may revive an entry.
      await updateLiveLocationCount(coll, existing._id);
      log.debug({ absPath, maple_id: hashed.maple_id, dedup: 'noop' }, 'idempotent re-discover');
    }
    await recordAndPublishAssetChange({
      kind: kind === 'created' ? 'create' : 'update',
      asset_id: existing._id,
      folder_id: folderId,
      abs_path: absPath,
    });
    return;
  }

  // No existing row for this content — insert. The discover watcher hashes
  // inline (sha1_head + maple_id are in `hashed`) so no post-insert hash
  // stage pass is needed. The legacy `hash` stage was retired in the
  // drop-abs-path-2026-05-21 migration.
  const stagesSkeleton = blankStagesSkeleton() as Record<string, { version: number }>;

  const insertedId = new ObjectId();
  try {
    await coll.insertOne({
      _id: insertedId,
      fileinfo: [{ ...fileinfoEntry, deleted_at: null }],
      // One live fileinfo entry on insert.
      live_location_count: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      exif: null,
      maple_id: hashed.maple_id,
      sha1_head: hashed.sha1_head,
      size: hashed.size,
      mtime: hashed.mtime,
      indexed_at: now,
      deleted_at: null,
      stages: stagesSkeleton,
    } as never);
  } catch (err) {
    // E11000 means another worker raced us to insert this maple_id
    // between our findOne and insertOne. Fall back to the append path —
    // mirror the main dedup branch so timestamps + abs_path refresh.
    const code = (err as { code?: number } | null)?.code;
    if (code === 11000) {
      const winner = await coll.findOne(
        { maple_id: hashed.maple_id },
        { projection: { _id: 1, fileinfo: 1 } },
      );
      if (winner) {
        const list = (winner.fileinfo ?? []) as Array<{
          path: string;
          filename: string;
          library_id: ObjectId;
        }>;
        const dupIdx = list.findIndex(
          (e) =>
            e.library_id.equals(fileinfoEntry.library_id) &&
            e.path === fileinfoEntry.path &&
            e.filename === fileinfoEntry.filename,
        );
        if (dupIdx === -1) {
          // Same conditional $push pattern as the main dedup-append
          // branch — silent fallthrough on modifiedCount === 0.
          await coll.updateOne(
            {
              _id: winner._id,
              fileinfo: {
                $not: {
                  $elemMatch: {
                    library_id: fileinfoEntry.library_id,
                    path: fileinfoEntry.path,
                    filename: fileinfoEntry.filename,
                  },
                },
              },
            },
            {
              $push: { fileinfo: fileinfoEntry as never },
              $set: dedupSet,
            },
          );
          // Recompute live count after race-loser append of a new live entry.
          await updateLiveLocationCount(coll, winner._id);
        } else {
          await coll.updateOne(
            { _id: winner._id },
            {
              $set: {
                ...dedupSet,
                'fileinfo.$[entry].deleted_at': null,
                'fileinfo.$[entry].missing_since': null,
                'fileinfo.$[entry].missing_reason': null,
              },
            },
            {
              arrayFilters: [
                {
                  'entry.library_id': fileinfoEntry.library_id,
                  'entry.path': fileinfoEntry.path,
                  'entry.filename': fileinfoEntry.filename,
                },
              ],
            },
          );
          // Recompute live count: race-loser re-discover may have un-tombstoned an entry.
          await updateLiveLocationCount(coll, winner._id);
        }
        await recordAndPublishAssetChange({
          kind: kind === 'created' ? 'create' : 'update',
          asset_id: winner._id,
          folder_id: folderId,
          abs_path: absPath,
        });
        log.info(
          { absPath, maple_id: hashed.maple_id, dedup: 'race-loser' },
          'race lost — appended to winner',
        );
        return;
      }
    }
    throw err;
  }

  log.info({ absPath, kind, maple_id: hashed.maple_id }, 'inserted');
  await recordAndPublishAssetChange({
    kind: kind === 'created' ? 'create' : 'update',
    asset_id: insertedId,
    folder_id: folderId,
    abs_path: absPath,
  });
}
