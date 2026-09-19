/**
 * Discover producer — content-dedup tests.
 *
 * Two files with the same bytes are one asset with two locations, and this
 * suite covers every path into and out of that rule: the plain dedup, the
 * fallback lookup that keeps it working after the exif stage rewrites a dedup
 * id, the modified-content guard that stops a changed file from being claimed
 * by its old row, the legacy row with no recorded hash, and the two concurrent
 * workers racing to record the same location.
 */
import { describe, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { newObjectIdHex } from '../../db/sqlite/object-id.ts';
import { hashFileForId } from '../../indexer/id.ts';
import {
  allAssets,
  assetIdAt,
  assetRow,
  createDiscoverLibrary,
  locationsNamed,
  locationsOf,
  stageRow,
  type LocationRow,
} from './discover.test-helpers.ts';
import { seedAsset, seedLocation } from './discover.test-helpers.ts';
import { handleEvent } from './index.ts';

/** `path/filename` for each of an asset's locations, sorted. */
function addresses(rows: readonly LocationRow[]): string[] {
  return rows.map((row) => `${row.path}/${row.filename}`).sort();
}

describe('discover producer — dedup', () => {
  it('revives a reaped row when its content is rediscovered, and re-arms meili (#2977)', async () => {
    using library = await createDiscoverLibrary('discover-revive-');
    const file = path.join(library.root, 'BACK.dng');
    const bytes = Buffer.alloc(70 * 1024, 0xcd);
    await writeFile(file, bytes);
    const { maple_id, sha1_head } = await hashFileForId(file);

    // A reaped row for this content: soft-deleted, its location tagged missing,
    // and the meili stage at a version it reached before the reap tombstoned
    // its search document.
    const id = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: maple_id,
      sha1Head: sha1_head,
      size: bytes.length,
      deletedAt: '2026-08-10T00:00:00.000Z',
      deletedReason: 'reaped',
      stages: ['meili'],
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId.toHexString(),
      filename: 'BACK.dng',
      missingSince: '2026-08-01T00:00:00.000Z',
      missingReason: 'enoent',
    });
    library.db.run(`UPDATE stage_state SET version = 4 WHERE asset_id = ? AND stage = 'meili'`, [
      id,
    ]);

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    const row = assetRow(library.db, id)!;
    expect(row.deleted_at).toBeNull();
    expect(row.deleted_reason).toBeNull();
    expect(row.live_location_count).toBe(1);
    expect(locationsOf(library.db, id)[0]!.missing_since).toBeNull();
    // Meili re-armed, so the tombstoned search document is rebuilt.
    expect(stageRow(library.db, id, 'meili')!.version).toBe(0);
  });

  it('dedups two files with identical content into one row with two locations', async () => {
    using library = await createDiscoverLibrary('discover-dedup-');
    const dirA = path.join(library.root, 'a');
    const dirB = path.join(library.root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    const bytes = Buffer.alloc(70 * 1024, 0xab);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    await handleEvent({ kind: 'created', absPath: fileA }, library.folderId, library.root);
    await handleEvent({ kind: 'created', absPath: fileB }, library.folderId, library.root);

    const assets = allAssets(library.db);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.maple_id).toMatch(/^[0-9a-f]{32}$/);
    expect(addresses(locationsOf(library.db, assets[0]!.id))).toEqual(['a/IMG.dng', 'b/IMG.dng']);
    expect(assets[0]!.live_location_count).toBe(2);
  });

  it('a modified file with new content hands its location to the new row', async () => {
    using library = await createDiscoverLibrary('discover-modnew-');
    const file = path.join(library.root, 'shifty.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x11));
    const oldHashed = await hashFileForId(file);

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);
    const oldId = assetIdAt(library.db, '', 'shifty.jpg')!;

    // Replace the file with different content → a different dedup id.
    await writeFile(file, Buffer.alloc(80 * 1024, 0x99));
    const newHashed = await hashFileForId(file);
    expect(newHashed.maple_id).not.toBe(oldHashed.maple_id);

    await handleEvent({ kind: 'modified', absPath: file }, library.folderId, library.root);

    // The old row survives with its edits and stage history — originals are
    // soft state here — but it gives up the claim on a path that now holds
    // different bytes. The UNIQUE index over (library_id, path, filename) is
    // what makes that a release rather than the tag the Mongo version wrote.
    expect(locationsOf(library.db, oldId)).toEqual([]);
    expect(assetRow(library.db, oldId)!.live_location_count).toBe(0);

    // A new row now holds the path, with a live location of its own.
    const assets = allAssets(library.db);
    expect(assets).toHaveLength(2);
    const newRow = assets.find((asset) => asset.maple_id === newHashed.maple_id)!;
    expect(newRow).toBeDefined();
    const newEntries = locationsOf(library.db, newRow.id);
    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]!.filename).toBe('shifty.jpg');
    expect(newEntries[0]!.deleted_at).toBeNull();
  });

  it('a legacy row without sha1_head ADOPTS the hash on re-discover (#2171)', async () => {
    // A row that predates content hashing has no recorded hash. Re-discovering
    // its present, unchanged file used to satisfy "the hashes differ"
    // (undefined ≠ hash), which dual-flagged the location and inserted a
    // duplicate row — every sweep generation, forever, since neither row ever
    // gained the field. The guard adopts the computed hash instead and the
    // event resolves as an idempotent re-discover.
    using library = await createDiscoverLibrary('discover-legacy-');
    const file = path.join(library.root, 'legacy.jpg');
    await writeFile(file, Buffer.alloc(80 * 1024, 0x42));
    const hashed = await hashFileForId(file);

    // Legacy row: an upgraded, primary-form dedup id and no hash at all.
    const legacyId = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: 'legacy-primary-id',
      sha1Head: null,
    });
    seedLocation(library.db, {
      assetId: legacyId,
      libraryId: library.folderId.toHexString(),
      filename: 'legacy.jpg',
    });

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    // No duplicate row — the legacy row absorbed the event.
    expect(allAssets(library.db)).toHaveLength(1);
    expect(assetRow(library.db, legacyId)!.sha1_head).toBe(hashed.sha1_head);
    // The location stays fully live — no orphan flags.
    const entry = locationsOf(library.db, legacyId)[0]!;
    expect(entry.deleted_at).toBeNull();
    expect(entry.missing_since).toBeNull();
  });

  it('concurrent dedup-append: the race-loser is a silent no-op', async () => {
    // Two callers process the same event at once. Both read the existing row,
    // both find the location absent from their stale snapshot, and both try to
    // record it. Exactly one append can land: the UNIQUE index over
    // `(library_id, path, filename)` refuses the second, and the conflict clause
    // turns the refusal into a no-op rather than an error.
    using library = await createDiscoverLibrary('discover-race-');
    const dirA = path.join(library.root, 'a');
    const dirB = path.join(library.root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    const bytes = Buffer.alloc(70 * 1024, 0x77);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);

    await handleEvent({ kind: 'created', absPath: fileA }, library.folderId, library.root);
    await Promise.all([
      handleEvent({ kind: 'created', absPath: fileB }, library.folderId, library.root),
      handleEvent({ kind: 'created', absPath: fileB }, library.folderId, library.root),
    ]);

    const assets = allAssets(library.db);
    expect(assets).toHaveLength(1);
    expect(addresses(locationsOf(library.db, assets[0]!.id))).toEqual(['a/IMG.dng', 'b/IMG.dng']);
  });

  it('dedups by sha1_head once the existing row has an upgraded dedup id', async () => {
    // The exif stage rewrites `maple_id` from the discover-time fallback form
    // to the primary form once a capture time is available. A duplicate
    // discovered after that upgrade no longer matches by dedup id, so without
    // the head-hash fallback it would insert a second row that the exif stage
    // then tries to upgrade into the same primary id — a unique-index violation
    // that ends up dead-lettered.
    using library = await createDiscoverLibrary('discover-sha1-');
    const dirA = path.join(library.root, 'a');
    const dirB = path.join(library.root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const fileA = path.join(dirA, 'IMG.dng');
    const fileB = path.join(dirB, 'IMG.dng');
    const bytes = Buffer.alloc(70 * 1024, 0xcd);
    await writeFile(fileA, bytes);
    await writeFile(fileB, bytes);
    const { maple_id: fallbackId } = await hashFileForId(fileA);
    const upgradedId = `01${'f'.repeat(30)}`;

    await handleEvent({ kind: 'created', absPath: fileA }, library.folderId, library.root);
    // Simulate the exif stage's upgrade. `sha1_head` is left untouched,
    // mirroring the real one in `workers/stages/exif.ts`.
    library.db.run(`UPDATE assets SET maple_id = ? WHERE maple_id = ?`, [upgradedId, fallbackId]);

    await handleEvent({ kind: 'created', absPath: fileB }, library.folderId, library.root);

    const assets = allAssets(library.db);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.maple_id).toBe(upgradedId);
    expect(addresses(locationsOf(library.db, assets[0]!.id))).toEqual(['a/IMG.dng', 'b/IMG.dng']);
  });

  it('the insert path records the dedup id and head hash directly', async () => {
    using library = await createDiscoverLibrary('discover-mid-');
    const file = path.join(library.root, 'y.jpg');
    await writeFile(file, Buffer.alloc(50 * 1024, 0xef));
    const expected = await hashFileForId(file);

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    const assets = allAssets(library.db);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.maple_id).toBe(expected.maple_id);
    expect(assets[0]!.sha1_head).toBe(expected.sha1_head);
    expect(assets[0]!.size).toBe(expected.size);
  });

  it('a modified copy of a multi-location asset gives up only its own location', async () => {
    using library = await createDiscoverLibrary('discover-modmulti-');
    const fileA = path.join(library.root, 'photoA.jpg');
    const fileB = path.join(library.root, 'photoB.jpg');
    const originalBytes = Buffer.alloc(64 * 1024, 0xaa);
    await writeFile(fileA, originalBytes);
    await writeFile(fileB, originalBytes);

    await handleEvent({ kind: 'created', absPath: fileA }, library.folderId, library.root);
    await handleEvent({ kind: 'created', absPath: fileB }, library.folderId, library.root);
    const deduped = allAssets(library.db);
    expect(deduped).toHaveLength(1);
    expect(locationsOf(library.db, deduped[0]!.id)).toHaveLength(2);

    // Overwrite one copy — the modified-content guard fires on that path alone.
    await writeFile(fileA, Buffer.alloc(64 * 1024, 0x55));
    await handleEvent({ kind: 'modified', absPath: fileA }, library.folderId, library.root);

    // The changed copy's location now belongs to the new content's row; the
    // other copy is untouched, so the original asset stays live on it.
    expect(locationsNamed(library.db, 'photoA.jpg')[0]!.asset_id).not.toBe(deduped[0]!.id);
    expect(locationsNamed(library.db, 'photoB.jpg')[0]!.asset_id).toBe(deduped[0]!.id);
    expect(locationsNamed(library.db, 'photoB.jpg')[0]!.missing_since).toBeNull();
    expect(assetRow(library.db, deduped[0]!.id)!.live_location_count).toBe(1);
  });
});
