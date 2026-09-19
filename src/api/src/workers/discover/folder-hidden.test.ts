/**
 * Folder-level `.hidden` marker (#2972): the sweep hides every photo in a
 * marked directory — and its subtree, via the frontier's `hidden_ancestor` flag
 * — and un-hides them when the marker is removed.
 *
 * The rules that make this safe rather than merely functional are all here. An
 * explicit per-photo override wins in both directions. Only `folder` hides are
 * lifted, so a manual or nudity hide survives marker removal. A non-live
 * location neither applies nor lifts the state. And a deduplicated asset stays
 * hidden while any of its other live locations is still under a marked
 * directory, without which it would flip-flop every sweep generation and thrash
 * both the search index and the R2 mirror.
 *
 * Real temp directories against a real database, matching `sweeper.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectId } from 'mongodb';
import { newObjectIdHex } from '../../db/sqlite/object-id.ts';
import type { HidableAsset } from '../../cloudflare/hidden-cleanup.ts';
import {
  assetRow,
  createDiscoverLibrary,
  seedAsset,
  seedLocation,
  stageRow,
  type DiscoverLibrary,
} from './discover.test-helpers.ts';
import * as frontier from './frontier.repo.ts';
import { visitDirectory } from './sweeper.ts';

type SeedOptions = Omit<Parameters<typeof seedAsset>[1], 'id'>;

/** Record one asset at one location in the library. */
function record(
  library: DiscoverLibrary,
  relDir: string,
  filename: string,
  options: SeedOptions = {},
): string {
  const id = seedAsset(library.db, { id: newObjectIdHex(), mapleId: newObjectIdHex(), ...options });
  seedLocation(library.db, {
    assetId: id,
    libraryId: library.folderId.toHexString(),
    path: relDir,
    filename,
  });
  return id;
}

/** Claim and visit the next frontier directory. */
async function visit(
  folderId: ObjectId,
  root: string,
  cleanupCalls?: HidableAsset[][],
): Promise<void> {
  const dir = await frontier.claimNextDir(folderId, 1, 60_000);
  expect(dir).not.toBeNull();
  await visitDirectory(dir!, root, {
    handleEvent: async () => {},
    folderId,
    cleanupHidden: cleanupCalls
      ? async (assets) => {
          cleanupCalls.push(assets);
        }
      : undefined,
  });
}

describe('folder .hidden marker — hide pass', () => {
  it('hides visible recorded assets in a marked dir, with reason folder and R2 cleanup', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    writeFileSync(join(library.root, '.hidden'), '');
    writeFileSync(join(library.root, 'a.dng'), 'x');
    const visibleId = record(library, '', 'a.dng', { stages: ['meili'] });

    await frontier.seedRoot(library.folderId, library.root, 1);
    const cleanupCalls: HidableAsset[][] = [];
    await visit(library.folderId, library.root, cleanupCalls);

    const row = assetRow(library.db, visibleId)!;
    expect(row.hidden).toBe(1);
    expect(row.hidden_reason).toBe('folder');
    // Meilisearch must re-project the hidden flag.
    expect(stageRow(library.db, visibleId, 'meili')!.version).toBe(0);
    // The R2 mirror comes down for the newly hidden asset.
    expect(cleanupCalls.flat().map((asset) => asset._id.toHexString())).toEqual([visibleId]);
  });

  it('leaves an explicit visible override alone, and does not disturb existing hides', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    writeFileSync(join(library.root, '.hidden'), '');
    writeFileSync(join(library.root, 'override.dng'), 'x');
    writeFileSync(join(library.root, 'manual.dng'), 'x');
    const overrideId = record(library, '', 'override.dng', {
      metadataOverride: { hidden: false },
    });
    const manualId = record(library, '', 'manual.dng', {
      hidden: true,
      hiddenReason: 'manual',
    });

    await frontier.seedRoot(library.folderId, library.root, 1);
    const cleanupCalls: HidableAsset[][] = [];
    await visit(library.folderId, library.root, cleanupCalls);

    const overridden = assetRow(library.db, overrideId)!;
    expect(overridden.hidden).toBe(0);
    expect(overridden.hidden_reason).toBeNull();
    const manual = assetRow(library.db, manualId)!;
    expect(manual.hidden).toBe(1);
    expect(manual.hidden_reason).toBe('manual');
    expect(cleanupCalls.flat()).toHaveLength(0);
  });
});

describe('folder .hidden marker — un-hide pass', () => {
  it('un-hides only folder-hidden assets when the marker is gone, re-arming cf-thumb-sync', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    writeFileSync(join(library.root, 'a.dng'), 'x');
    writeFileSync(join(library.root, 'manual.dng'), 'x');
    const folderHiddenId = record(library, '', 'a.dng', {
      hidden: true,
      hiddenReason: 'folder',
      stages: ['cf-thumb-sync', 'meili'],
    });
    library.db.run(`UPDATE stage_state SET version = 3 WHERE asset_id = ?`, [folderHiddenId]);
    const manualId = record(library, '', 'manual.dng', { hidden: true, hiddenReason: 'manual' });

    await frontier.seedRoot(library.folderId, library.root, 1);
    await visit(library.folderId, library.root);

    const unhidden = assetRow(library.db, folderHiddenId)!;
    expect(unhidden.hidden).toBe(0);
    expect(unhidden.hidden_reason).toBeNull();
    expect(stageRow(library.db, folderHiddenId, 'cf-thumb-sync')!.version).toBe(0);
    expect(stageRow(library.db, folderHiddenId, 'meili')!.version).toBe(0);
    const manual = assetRow(library.db, manualId)!;
    expect(manual.hidden).toBe(1);
    expect(manual.hidden_reason).toBe('manual');
  });

  it('does not un-hide a folder-hidden asset whose override has since forced hidden', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    writeFileSync(join(library.root, 'a.dng'), 'x');
    const id = record(library, '', 'a.dng', {
      hidden: true,
      hiddenReason: 'folder',
      metadataOverride: { hidden: true },
    });

    await frontier.seedRoot(library.folderId, library.root, 1);
    await visit(library.folderId, library.root);

    expect(assetRow(library.db, id)!.hidden).toBe(1);
  });
});

describe('folder .hidden marker — deduplicated assets (multi-location)', () => {
  it('keeps a dup hidden while its other live location is under a marked dir', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    mkdirSync(join(library.root, 'hidden-src'));
    writeFileSync(join(library.root, 'hidden-src', '.hidden'), '');
    writeFileSync(join(library.root, 'hidden-src', 'dup.dng'), 'x');
    mkdirSync(join(library.root, 'visible-dup'));
    writeFileSync(join(library.root, 'visible-dup', 'dup.dng'), 'x');
    setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));

    const id = seedAsset(library.db, {
      id: newObjectIdHex(),
      mapleId: 'dup',
      hidden: true,
      hiddenReason: 'folder',
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId.toHexString(),
      ordinal: 0,
      path: 'hidden-src',
      filename: 'dup.dng',
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId.toHexString(),
      ordinal: 1,
      path: 'visible-dup',
      filename: 'dup.dng',
    });

    try {
      // Visit ONLY the unmarked dir — the marker in hidden-src must still keep
      // the asset hidden, or every sweep generation flip-flops it.
      await frontier.enqueueDirs(library.folderId, [join(library.root, 'visible-dup')], 1, false);
      await visit(library.folderId, library.root);

      const row = assetRow(library.db, id)!;
      expect(row.hidden).toBe(1);
      expect(row.hidden_reason).toBe('folder');
    } finally {
      setLibraryRootsForTests(null);
    }
  });
});

describe('folder .hidden marker — entry liveness', () => {
  it('does not hide an asset whose only entry in the marked dir is missing or dead', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    writeFileSync(join(library.root, '.hidden'), '');

    const missingId = seedAsset(library.db, { id: newObjectIdHex(), mapleId: 'missing' });
    seedLocation(library.db, {
      assetId: missingId,
      libraryId: library.folderId.toHexString(),
      filename: 'gone.dng',
      missingSince: '2026-01-01T00:00:00Z',
    });
    const deadId = seedAsset(library.db, { id: newObjectIdHex(), mapleId: 'dead' });
    seedLocation(library.db, {
      assetId: deadId,
      libraryId: library.folderId.toHexString(),
      filename: 'dead.dng',
      deletedAt: '2026-01-01T00:00:00Z',
    });

    await frontier.seedRoot(library.folderId, library.root, 1);
    await visit(library.folderId, library.root);

    expect(assetRow(library.db, missingId)!.hidden).toBe(0);
    expect(assetRow(library.db, deadId)!.hidden).toBe(0);
  });
});

describe('folder .hidden marker — subtree propagation', () => {
  it('enqueues child dirs of a marked dir with the flag, and hides their assets', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    writeFileSync(join(library.root, '.hidden'), '');
    mkdirSync(join(library.root, 'sub'));
    writeFileSync(join(library.root, 'sub', 'nested.dng'), 'x');
    const nestedId = record(library, 'sub', 'nested.dng');

    await frontier.seedRoot(library.folderId, library.root, 1);
    await visit(library.folderId, library.root); // visits root, enqueues sub with the flag
    await visit(library.folderId, library.root); // visits sub (no marker of its own)

    const nested = assetRow(library.db, nestedId)!;
    expect(nested.hidden).toBe(1);
    expect(nested.hidden_reason).toBe('folder');
  });

  it('does not propagate the flag from an unmarked dir', async () => {
    using library = await createDiscoverLibrary('maple-folder-hidden-');
    mkdirSync(join(library.root, 'sub'));
    writeFileSync(join(library.root, 'sub', 'nested.dng'), 'x');
    const nestedId = record(library, 'sub', 'nested.dng');

    await frontier.seedRoot(library.folderId, library.root, 1);
    await visit(library.folderId, library.root);
    await visit(library.folderId, library.root);

    expect(assetRow(library.db, nestedId)!.hidden).toBe(0);
  });
});
