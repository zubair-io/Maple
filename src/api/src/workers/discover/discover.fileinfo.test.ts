/**
 * Discover producer — location tests.
 *
 * Covers the library-relative addressing of a recorded location: the same
 * basename in two subdirectories, nested directories, a file at the library
 * root (empty path), the operator `.keep` marker, and a rename rewriting the
 * location in place rather than adding a second one.
 *
 * These used to read `doc.fileinfo[0]`. A location is a row in
 * `asset_locations` now, and the UNIQUE `(library_id, path, filename)` index is
 * what makes "two assets cannot claim the same file" a property of the schema
 * rather than of the producer.
 */
import { describe, expect, it } from 'bun:test';
import { mkdir, rename as fsRename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  assetIdAt,
  createDiscoverLibrary,
  locationsNamed,
  locationsOf,
} from './discover.test-helpers.ts';
import { handleEvent } from './index.ts';

describe('discover producer — locations', () => {
  it('does not collide on a shared basename across subdirectories', async () => {
    using library = await createDiscoverLibrary('discover-coll-');
    const dir2024 = path.join(library.root, '2024');
    const dir2025 = path.join(library.root, '2025');
    await mkdir(dir2024, { recursive: true });
    await mkdir(dir2025, { recursive: true });
    const file2024 = path.join(dir2024, 'IMG_0001.DNG');
    const file2025 = path.join(dir2025, 'IMG_0001.DNG');
    // Different content, so these dedup to two rows rather than one.
    await writeFile(file2024, Buffer.alloc(100, 0x11));
    await writeFile(file2025, Buffer.alloc(100, 0x22));

    await handleEvent({ kind: 'created', absPath: file2024 }, library.folderId, library.root);
    await handleEvent({ kind: 'created', absPath: file2025 }, library.folderId, library.root);

    const rows = locationsNamed(library.db, 'IMG_0001.DNG');
    expect(rows.map((row) => row.path)).toEqual(['2024', '2025']);
    expect(new Set(rows.map((row) => row.asset_id)).size).toBe(2);
  });

  it('records the directory relative to the library root on insert', async () => {
    using library = await createDiscoverLibrary('discover-fi-');
    const sub = path.join(library.root, 'vacation', '2024');
    await mkdir(sub, { recursive: true });
    const file = path.join(sub, 'IMG_001.dng');
    await writeFile(file, Buffer.alloc(100, 0xdd));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    const assetId = assetIdAt(library.db, 'vacation/2024', 'IMG_001.dng');
    expect(assetId).not.toBeNull();
    const rows = locationsOf(library.db, assetId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('vacation/2024');
    expect(rows[0]!.filename).toBe('IMG_001.dng');
    expect(rows[0]!.library_id).toBe(library.folderId.toHexString());
  });

  it("the directory is '' for files at the library root", async () => {
    using library = await createDiscoverLibrary('discover-fi-root-');
    const file = path.join(library.root, 'top.jpg');
    await writeFile(file, Buffer.alloc(50, 0xee));

    await handleEvent({ kind: 'created', absPath: file }, library.folderId, library.root);

    const rows = locationsNamed(library.db, 'top.jpg');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('');
  });

  it('records keep on the location when a `.keep` marker is in the folder', async () => {
    using library = await createDiscoverLibrary('discover-keep-');
    const pinned = path.join(library.root, 'pinned');
    const loose = path.join(library.root, 'loose');
    await mkdir(pinned, { recursive: true });
    await mkdir(loose, { recursive: true });
    // Marker in the pinned folder only.
    await writeFile(path.join(pinned, '.keep'), '');
    const pinnedFile = path.join(pinned, 'A.dng');
    const looseFile = path.join(loose, 'B.dng');
    await writeFile(pinnedFile, Buffer.alloc(64, 0x01));
    await writeFile(looseFile, Buffer.alloc(64, 0x02));

    await handleEvent({ kind: 'created', absPath: pinnedFile }, library.folderId, library.root);
    await handleEvent({ kind: 'created', absPath: looseFile }, library.folderId, library.root);

    expect(locationsNamed(library.db, 'A.dng')[0]!.keep).toBe(1);
    expect(locationsNamed(library.db, 'B.dng')[0]!.keep).toBe(0);
  });

  it('rename rewrites the location in place — still one entry', async () => {
    using library = await createDiscoverLibrary('discover-fi-rename-');
    const dirA = path.join(library.root, 'a');
    const dirB = path.join(library.root, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const before = path.join(dirA, 'x.dng');
    const after = path.join(dirB, 'x.dng');
    await writeFile(before, Buffer.alloc(50, 0xff));

    await handleEvent({ kind: 'created', absPath: before }, library.folderId, library.root);
    await fsRename(before, after);
    await handleEvent(
      { kind: 'renamed', absPath: after, fromPath: before },
      library.folderId,
      library.root,
    );

    const assetId = assetIdAt(library.db, 'b', 'x.dng');
    expect(assetId).not.toBeNull();
    const rows = locationsOf(library.db, assetId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('b');
    expect(rows[0]!.filename).toBe('x.dng');
  });
});
