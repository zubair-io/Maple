/**
 * Discover producer — event-handling tests.
 *
 * The removal half is the interesting one, and both of its rules are here: a
 * `removed` event for a file that is still on disk is refused (#2171 — a present
 * file must never be marked missing), and a confirmed removal tags only the
 * vanished location, never the asset. A deduped asset with a surviving copy
 * therefore stays live, which is the bug that rule exists to prevent.
 *
 * The rest covers the change feed a File Provider client reads, and the search
 * stage re-arm a rename has to carry (#2357).
 */
import { describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  allAssets,
  assetIdAt,
  assetRow,
  changesFor,
  createDiscoverLibrary,
  deadLetterStage,
  locationsNamed,
  locationsOf,
  stageRow,
} from './discover.test-helpers.ts';
import { handleEvent } from './index.ts';

describe('discover producer — events', () => {
  it('tags the location missing, never the asset, when a removed event is confirmed', async () => {
    using library = await createDiscoverLibrary('discover-del-');
    const file = path.join(library.root, 'todelete.jpg');
    await writeFile(file, Buffer.alloc(50, 0xaa));
    // Keep the library root non-empty after `file` is unlinked below — the
    // removed handler refuses to tag when the root looks unmounted (#2171).
    await writeFile(path.join(library.root, 'other.jpg'), Buffer.alloc(50, 0xbb));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    const assetId = assetIdAt(library.db, '', 'todelete.jpg');
    expect(assetId).not.toBeNull();
    expect(assetRow(library.db, assetId!)!.deleted_at).toBeNull();

    // A removed event for a file that is STILL ON DISK is refused — the handler
    // stat-confirms before tagging.
    await handleEvent({ kind: 'removed', absPath: file }, library.folderId, library.root);
    expect(locationsOf(library.db, assetId!)[0]!.missing_since).toBeNull();

    // Now genuinely delete the file and fire removed again. The single location
    // is tagged; the asset's own `deleted_at` is NEVER touched (that is reserved
    // for the File Provider trash path). With no live location left the asset is
    // hidden, and the missing-reaper owns it from here.
    await rm(file);
    await handleEvent({ kind: 'removed', absPath: file }, library.folderId, library.root);

    const after = assetRow(library.db, assetId!)!;
    expect(after.deleted_at).toBeNull();
    expect(after.live_location_count).toBe(0);
    const entry = locationsOf(library.db, assetId!)[0]!;
    expect(typeof entry.missing_since).toBe('string');
    // Structured provenance for the tag (#2171).
    expect(entry.missing_reason).toBe('watch-removed');
  });

  it('keeps a deduped asset live when only ONE of its copies is removed', async () => {
    using library = await createDiscoverLibrary('discover-dedup-del-');
    // Two identical-content files: same bytes → same dedup id → one row with
    // two locations.
    const bytes = Buffer.alloc(64 * 1024 + 7, 0xcd);
    const copyA = path.join(library.root, 'copyA.jpg');
    const copyB = path.join(library.root, 'copyB.jpg');
    await writeFile(copyA, bytes);
    await writeFile(copyB, bytes);

    await handleEvent({ kind: 'created', absPath: copyA }, library.folderId, library.root);
    await handleEvent({ kind: 'created', absPath: copyB }, library.folderId, library.root);

    const assets = allAssets(library.db);
    expect(assets).toHaveLength(1);
    const assetId = assets[0]!.id;
    expect(locationsOf(library.db, assetId)).toHaveLength(2);

    // Remove ONE copy (genuinely unlink it — the handler stat-confirms). The
    // other copy is still on disk, so the asset must stay live: the bug this
    // fixes soft-deleted the whole row.
    await rm(copyA);
    await handleEvent({ kind: 'removed', absPath: copyA }, library.folderId, library.root);

    const after = assetRow(library.db, assetId)!;
    expect(after.deleted_at).toBeNull();
    expect(after.live_location_count).toBe(1); // copyB keeps it live
    expect(typeof locationsNamed(library.db, 'copyA.jpg')[0]!.missing_since).toBe('string');
    expect(locationsNamed(library.db, 'copyB.jpg')[0]!.missing_since).toBeNull();
  });

  it('emits change-feed rows on create / modify / rename / removal', async () => {
    using library = await createDiscoverLibrary('discover-changes-');
    const file = path.join(library.root, 'feed.jpg');
    await writeFile(file, Buffer.alloc(64, 0x33));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create']);

    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create', 'update']);

    // A rename keeps the same asset, so it surfaces as an update at the new path.
    const newPath = path.join(library.root, 'feed-renamed.jpg');
    await writeFile(newPath, Buffer.alloc(64, 0x33));
    await handleEvent(
      { kind: 'renamed', absPath: newPath, fromPath: file },
      library.folderId,
      library.root,
    );
    expect(changesFor(library.db, newPath).map((row) => row.kind)).toEqual(['update']);

    // Last live location gone → a delete. Unlink first, since the handler
    // stat-confirms; the file at the pre-rename path keeps the root non-empty.
    await rm(newPath);
    await handleEvent({ kind: 'removed', absPath: newPath }, library.folderId, library.root);
    expect(changesFor(library.db, newPath).map((row) => row.kind)).toEqual(['update', 'delete']);
  });

  it('re-arms the meili stage in full on a rename event', async () => {
    // #2357: a rename rewrites the filename — the highest-weight lexical field
    // in the Meilisearch index. Without re-arming the stage the search document
    // is never re-synced and goes permanently stale. The reset is all five
    // fields, not just the version: a stage that had dead-lettered would
    // otherwise stay parked and never be claimed.
    using library = await createDiscoverLibrary('discover-meili-rename-');
    const file = path.join(library.root, 'meili-src.jpg');
    await writeFile(file, Buffer.alloc(64, 0x55));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    const assetId = assetIdAt(library.db, '', 'meili-src.jpg');
    expect(assetId).not.toBeNull();
    deadLetterStage(library.db, assetId!, 'meili');

    const newPath = path.join(library.root, 'meili-renamed.jpg');
    await writeFile(newPath, Buffer.alloc(64, 0x55));
    await handleEvent(
      { kind: 'renamed', absPath: newPath, fromPath: file },
      library.folderId,
      library.root,
    );

    const meili = stageRow(library.db, assetId!, 'meili')!;
    expect(meili.version).toBe(0);
    expect(meili.dead).toBe(0);
    expect(meili.attempts).toBe(0);
    expect(meili.last_error).toBeNull();
  });

  for (const reserved of [
    {
      label: '`.maple/` cache',
      // Regression for #1186: if any producer hands the handler a path inside
      // `.maple/`, it must refuse rather than insert a phantom row whose own
      // derivatives land one `.maple/` deeper — a self-feeding loop.
      prefix: 'discover-maple-cache-',
      dir: path.join('.maple', 'thumbs'),
      filename: 'cafe.jpg',
    },
    {
      label: '`_duplicates/` quarantine',
      // The sweeper never descends into `_duplicates/`, but handleEvent is also
      // fed by the imports hand-off, browse indexing, the pano on-demand path
      // and the folder walkers. A quarantined path would content-dedup back
      // onto the very asset it was split from, and the next dedupe pass would
      // nest it under `_duplicates/_duplicates/…`.
      prefix: 'discover-dup-quarantine-',
      dir: path.join('_duplicates', 'photos'),
      filename: 'copy.jpg',
    },
  ]) {
    it(`refuses every event kind inside the ${reserved.label}`, async () => {
      using library = await createDiscoverLibrary(reserved.prefix);
      const dir = path.join(library.root, reserved.dir);
      await mkdir(dir, { recursive: true });
      const phantom = path.join(dir, reserved.filename);
      await writeFile(phantom, Buffer.alloc(50, 0xab));

      await handleEvent({ kind: 'created', absPath: phantom }, library.folderId, library.root);
      await handleEvent({ kind: 'modified', absPath: phantom }, library.folderId, library.root);
      await handleEvent({ kind: 'removed', absPath: phantom }, library.folderId, library.root);
      await handleEvent(
        { kind: 'renamed', absPath: path.join(library.root, 'oops.jpg'), fromPath: phantom },
        library.folderId,
        library.root,
      );

      expect(allAssets(library.db)).toEqual([]);
    });
  }
});
