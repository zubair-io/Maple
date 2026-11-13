/**
 * Discover producer — idempotency tests.
 *
 * Two properties, and they are the ones a sweep depends on: re-discovering a
 * file must not undo a stage's recorded progress, and it must not add a second
 * location for a path the asset already holds.
 *
 * The second one used to be enforced by a conditional `$push`; it is the UNIQUE
 * index over `(library_id, path, filename)` now, so a duplicate cannot be
 * written even if the guard were removed.
 *
 * A third (#4507): a re-discover that changes nothing writes nothing — no
 * refresh of the asset row and no change-feed row. A full re-walk of an
 * unchanged library otherwise journals one row per file. Everything that does
 * change state (a new location, a revival, a recovered location, a new mtime,
 * a flipped `.keep` marker, a legacy hash adoption) still publishes.
 */
import { describe, expect, it } from 'bun:test';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../../db/object-id.ts';
import { hashFileForId } from '../../indexer/id.ts';
import {
  allAssets,
  assetIdAt,
  assetRow,
  changesFor,
  createDiscoverLibrary,
  locationsOf,
  seedAsset,
  seedLocation,
  setStageVersion,
  stageRow,
} from './discover.test-helpers.ts';
import { handleEvent } from './index.ts';

describe('discover producer — idempotency', () => {
  it('re-discover preserves existing stage progress', async () => {
    using library = await createDiscoverLibrary('discover-rescan-');
    const file = path.join(library.root, 'photo.jpg');
    await writeFile(file, Buffer.alloc(200, 0xbb));

    // First discover — inserts with the skeleton (every stage at version 0).
    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    const assetId = assetIdAt(library.db, '', 'photo.jpg');
    expect(assetId).not.toBeNull();

    // Simulate the exif stage completing.
    setStageVersion(library.db, assetId!, 'exif', 1);

    // Re-discover (modified event) — must not reset exif back to 0.
    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);
    expect(stageRow(library.db, assetId!, 'exif')!.version).toBe(1);
  });

  it('re-discovering the same path is idempotent — no duplicate locations', async () => {
    using library = await createDiscoverLibrary('discover-idem-');
    const file = path.join(library.root, 'x.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0xcd));

    // Two events for the same (library, path) — modify after create.
    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);

    const assets = allAssets(library.db);
    expect(assets).toHaveLength(1);
    expect(locationsOf(library.db, assets[0]!.id)).toHaveLength(1);
    expect(assets[0]!.live_location_count).toBe(1);
  });
});

const SENTINEL_INDEXED_AT = '2000-01-01T00:00:00.000Z';

/** Stamp the asset so a later refresh write is visible even within one millisecond. */
function stampIndexedAt(db: Database, assetId: string): void {
  db.run(`UPDATE assets SET indexed_at = ? WHERE id = ?`, [SENTINEL_INDEXED_AT, assetId]);
}

function indexedAt(db: Database, assetId: string): string {
  return (
    db.query(`SELECT indexed_at FROM assets WHERE id = ?`).get(assetId) as {
      indexed_at: string;
    }
  ).indexed_at;
}

describe('discover producer — unchanged re-discover is a no-op (#4507)', () => {
  it('writes no refresh and no change row when nothing changed', async () => {
    using library = await createDiscoverLibrary('discover-noop-');
    const file = path.join(library.root, 'same.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x5a));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    const assetId = assetIdAt(library.db, '', 'same.jpg')!;
    stampIndexedAt(library.db, assetId);

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);

    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create']);
    expect(indexedAt(library.db, assetId)).toBe(SENTINEL_INDEXED_AT);
  });

  it('a changed mtime refreshes the row and publishes', async () => {
    using library = await createDiscoverLibrary('discover-mtime-');
    const file = path.join(library.root, 'touched.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x5b));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    const assetId = assetIdAt(library.db, '', 'touched.jpg')!;
    stampIndexedAt(library.db, assetId);
    const later = new Date('2030-01-01T00:00:00.000Z');
    await utimes(file, later, later);

    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);

    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create', 'update']);
    expect(assetRow(library.db, assetId)!.mtime).toBe(later.getTime());
    expect(indexedAt(library.db, assetId)).not.toBe(SENTINEL_INDEXED_AT);
  });

  it('a second copy in a new location appends and publishes', async () => {
    using library = await createDiscoverLibrary('discover-newloc-');
    const first = path.join(library.root, 'a.jpg');
    await mkdir(path.join(library.root, 'sub'));
    const second = path.join(library.root, 'sub', 'a.jpg');
    const bytes = Buffer.alloc(80 * 1024, 0x5c);
    await writeFile(first, bytes);
    await writeFile(second, bytes);
    const stamp = new Date('2030-02-01T00:00:00.000Z');
    await utimes(first, stamp, stamp);
    await utimes(second, stamp, stamp);

    await handleEvent({ kind: 'created', absPath: first }, library.folderId, library.root);
    await handleEvent({ kind: 'created', absPath: second }, library.folderId, library.root);

    expect(changesFor(library.db, second).map((row) => row.kind)).toEqual(['create']);
    expect(locationsOf(library.db, assetIdAt(library.db, '', 'a.jpg')!)).toHaveLength(2);
  });

  it('a .keep marker appearing flips the flag and publishes', async () => {
    using library = await createDiscoverLibrary('discover-keep-');
    const file = path.join(library.root, 'kept.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x5d));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    await writeFile(path.join(library.root, '.keep'), '');
    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);

    const assetId = assetIdAt(library.db, '', 'kept.jpg')!;
    expect(locationsOf(library.db, assetId)[0]!.keep).toBe(1);
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create', 'update']);
  });

  it('recovering a missing-tagged location on a live asset publishes', async () => {
    using library = await createDiscoverLibrary('discover-recover-');
    const file = path.join(library.root, 'back.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x5e));
    const hashed = await hashFileForId(file);
    const id = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: hashed.maple_id,
      sha1Head: hashed.sha1_head,
      size: hashed.size,
    });
    library.db.run(`UPDATE assets SET mtime = ? WHERE id = ?`, [hashed.mtime, id]);
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId.toHexString(),
      filename: 'back.jpg',
      missingSince: '2026-08-01T00:00:00.000Z',
      missingReason: 'enoent',
    });

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    expect(locationsOf(library.db, id)[0]!.missing_since).toBeNull();
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create']);
  });

  it('reviving a reaped row publishes', async () => {
    using library = await createDiscoverLibrary('discover-revive-pub-');
    const file = path.join(library.root, 'reaped.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x5f));
    const hashed = await hashFileForId(file);
    const id = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: hashed.maple_id,
      sha1Head: hashed.sha1_head,
      size: hashed.size,
      deletedAt: '2026-08-10T00:00:00.000Z',
      deletedReason: 'reaped',
    });
    library.db.run(`UPDATE assets SET mtime = ? WHERE id = ?`, [hashed.mtime, id]);
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId.toHexString(),
      filename: 'reaped.jpg',
    });

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    expect(assetRow(library.db, id)!.deleted_at).toBeNull();
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create']);
  });

  it('adopting a legacy head hash publishes', async () => {
    using library = await createDiscoverLibrary('discover-adopt-pub-');
    const file = path.join(library.root, 'legacy.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x60));
    const hashed = await hashFileForId(file);
    const id = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: hashed.maple_id,
      sha1Head: null,
      size: hashed.size,
    });
    library.db.run(`UPDATE assets SET mtime = ? WHERE id = ?`, [hashed.mtime, id]);
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId.toHexString(),
      filename: 'legacy.jpg',
    });

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    expect(assetRow(library.db, id)!.sha1_head).toBe(hashed.sha1_head);
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create']);
  });

  it('concurrent first discovers of one file journal a single change', async () => {
    // Both events can miss the content lookup; the loser of the insert race
    // then finds the winner already holding this exact location, which is a
    // no-op and must not publish a second time.
    using library = await createDiscoverLibrary('discover-race-pub-');
    const file = path.join(library.root, 'raced.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x61));

    await Promise.all([
      handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root),
      handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root),
    ]);

    expect(allAssets(library.db)).toHaveLength(1);
    expect(changesFor(library.db, file).map((row) => row.kind)).toEqual(['create']);
  });
});
