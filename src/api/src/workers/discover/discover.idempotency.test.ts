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
 */
import { describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  allAssets,
  assetIdAt,
  createDiscoverLibrary,
  locationsOf,
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
