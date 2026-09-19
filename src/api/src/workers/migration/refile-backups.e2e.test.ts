/**
 * End-to-end coverage for the refile-backups cleanup.
 *
 * Seeds backup-origin assets with real files in a temp library, drives one
 * migration tick through the worker, and asserts the on-disk move, the
 * repoint, the done-marker and the stage re-arms. The pure destination logic
 * is unit-tested in `refile-backups.test.ts`; what these add is everything the
 * filesystem half can get wrong.
 *
 * Three behaviours here are the reason the migration was rewritten. An asset
 * frozen at an older generation is re-swept rather than trusted. An asset
 * already in the right folder is stamped WITHOUT resetting its caches, because
 * nothing moved. And an asset whose source file is gone is stamped anyway, or a
 * batch of missing sources head-of-line-blocks the whole library every tick.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { BACKUP_LAYOUT_VERSION } from './refile-backups.ts';
import {
  loadMigrationState,
  resetMigrationState,
  setMigrationEnabled,
} from '../migration-config.repo.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import type { Place } from '../../db/schema.ts';
import {
  assetRow,
  createLibrary,
  locationsOf,
  seedAsset,
  stageRow,
  type MigrationLibrary,
} from './migration.test-helpers.ts';

const MIGRATION_ID = 'refile-backups';

afterEach(() => {
  setLibraryRootsForTests(null);
  stageRegistry._resetForTests();
});

function place(p: {
  address?: Partial<Place['address']>;
  rollups?: Partial<Place['rollups']>;
  pois?: Place['pois'];
}): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: (p.address ?? {}) as Place['address'],
    pois: p.pois ?? [],
    rollups: { locality: null, region: null, country_code: null, ...(p.rollups ?? {}) },
    search_blob: '',
  };
}

const JAPAN = place({
  address: { country: 'Japan', country_code: 'jp' },
  rollups: { locality: 'Kyoto', country_code: 'jp' },
});
const FRANCE = place({
  address: { country: 'France', country_code: 'fr' },
  rollups: { locality: 'Paris', country_code: 'fr' },
});

/** A library whose root the migration can resolve, un-registered on exit. */
async function createBackupLibrary(prefix: string): Promise<MigrationLibrary> {
  const library = await createLibrary(prefix);
  setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));
  return library;
}

/** Write `filename` (and any companions) into `rel` under the library root. */
async function writeFiles(
  library: MigrationLibrary,
  rel: string,
  files: Record<string, string>,
): Promise<void> {
  await fs.mkdir(path.join(library.root, ...rel.split('/')), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(library.root, rel, name), body);
  }
}

/** One migration tick, enabled from a clean state. */
async function runTick(): Promise<void> {
  await resetMigrationState(MIGRATION_ID);
  await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
  await runMigrationTickOnce(50, new Date().toISOString());
}

/** The asset's single location, which every assertion here reads. */
function location(library: MigrationLibrary, id: string): { path: string; filename: string } {
  const rows = locationsOf(library.db, id);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('refile-backups end-to-end', () => {
  it('moves a geocoded backup into year/Country/City, stamps, and re-arms the caches', async () => {
    using library = await createBackupLibrary('refile-geo-');
    const oldRel = '2024/Tokyo';
    await writeFiles(library, oldRel, { 'IMG_GEO.HEIC': 'pixels', 'IMG_GEO.xmp': 'edits' });

    const id = seedAsset(library.db, {
      mapleId: 'refile-geo-id',
      phassetDevices: ['dev'],
      place: JAPAN,
      exif: { captured_year: 2024 },
      stages: ['thumb', 'preview', 'meili'],
      location: { libraryId: library.folderId, path: oldRel, filename: 'IMG_GEO.HEIC' },
    });
    library.db.run(`UPDATE stage_state SET version = 1 WHERE asset_id = ?`, [id]);
    // #2357: a previously dead-lettered meili stage must be fully re-armed by
    // the repoint, not left stale at the old filename.
    library.db.run(
      `UPDATE stage_state
          SET version = 3, attempts = 5, last_error = 'boom', dead = 1,
              processed_at = '2024-01-01T00:00:00.000Z'
        WHERE asset_id = ? AND stage = 'meili'`,
      [id],
    );

    await runTick();

    expect(location(library, id).path).toBe('2024/Japan/Kyoto');
    expect(location(library, id).filename).toBe('IMG_GEO.HEIC');
    expect(assetRow(library.db, id)!.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
    for (const stage of ['thumb', 'preview', 'meili']) {
      expect(stageRow(library.db, id, stage)).toEqual({
        version: 0,
        attempts: 0,
        last_error: null,
        dead: 0,
      });
    }

    // The file and its sidecar moved, and the emptied folder was reclaimed.
    const moved = path.join(library.root, '2024/Japan/Kyoto');
    expect(await fs.readFile(path.join(moved, 'IMG_GEO.HEIC'), 'utf8')).toBe('pixels');
    expect(await fs.readFile(path.join(moved, 'IMG_GEO.xmp'), 'utf8')).toBe('edits');
    await expect(fs.stat(path.join(library.root, oldRel))).rejects.toThrow();

    expect(await refileRemaining()).toBe(0);
  });

  it('unfreezes an asset stamped at an older generation and stuck at a stale POI path', async () => {
    // The exact frozen state the rewrite exists for: stamped at generation 2,
    // sitting at a pre-geocode POI path, with a place that now fully resolves.
    // The old selector skipped it forever; a generation bump must re-sweep it.
    using library = await createBackupLibrary('refile-regression-');
    const oldRel = '2026/24 rue Vignon';
    await writeFiles(library, oldRel, { 'IMG_0333.JPG': 'pixels' });

    const id = seedAsset(library.db, {
      mapleId: 'refile-regression-id',
      phassetDevices: ['dev'],
      backupLayoutVersion: 2, // ← the frozen stamp
      place: place({
        address: { country: 'France', country_code: 'fr', state: 'Île-de-France' },
        rollups: { locality: 'Paris', country_code: 'fr' },
        pois: [{ name: '24 rue Vignon', category: 'building', type: 'apartments' }],
      }),
      exif: { captured_year: 2026 },
      stages: ['thumb', 'preview'],
      location: { libraryId: library.folderId, path: oldRel, filename: 'IMG_0333.JPG' },
    });

    await runTick();

    expect(location(library, id).path).toBe('2026/France/Paris');
    expect(assetRow(library.db, id)!.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
    expect(
      await fs.readFile(path.join(library.root, '2026/France/Paris/IMG_0333.JPG'), 'utf8'),
    ).toBe('pixels');
    await expect(fs.stat(path.join(library.root, oldRel))).rejects.toThrow();
  });

  it('moves a flagged screenshot into year/Screenshot', async () => {
    using library = await createBackupLibrary('refile-shot-');
    const oldRel = '2024/03';
    await writeFiles(library, oldRel, { 'Screenshot 2024-03-15.png': 'pixels' });

    const id = seedAsset(library.db, {
      mapleId: 'refile-shot-id',
      phassetDevices: ['dev'],
      isScreenshot: true,
      exif: { captured_year: 2024 },
      stages: ['thumb', 'preview'],
      location: {
        libraryId: library.folderId,
        path: oldRel,
        filename: 'Screenshot 2024-03-15.png',
      },
    });

    await runTick();

    expect(location(library, id).path).toBe('2024/Screenshot');
    expect(
      await fs.readFile(
        path.join(library.root, '2024/Screenshot/Screenshot 2024-03-15.png'),
        'utf8',
      ),
    ).toBe('pixels');
  });

  it('flattens an old MM-DD day-folder for a placeless backup', async () => {
    using library = await createBackupLibrary('refile-flatten-');
    const oldRel = '2024/Tokyo/03-15';
    await writeFiles(library, oldRel, { 'IMG_E2E.HEIC': 'pixels' });

    const id = seedAsset(library.db, {
      mapleId: 'refile-flatten-id',
      phassetDevices: ['dev'],
      stages: ['thumb', 'preview'],
      location: { libraryId: library.folderId, path: oldRel, filename: 'IMG_E2E.HEIC' },
    });

    await runTick();

    expect(location(library, id).path).toBe('2024/Misc');
    expect(await fs.readFile(path.join(library.root, '2024/Misc/IMG_E2E.HEIC'), 'utf8')).toBe(
      'pixels',
    );
    await expect(fs.stat(path.join(library.root, oldRel))).rejects.toThrow();
  });

  it('stamps an already-correct asset without moving the file or resetting its caches', async () => {
    using library = await createBackupLibrary('refile-noop-');
    const rel = '2024/France/Paris';
    await writeFiles(library, rel, { 'IMG_OK.HEIC': 'pixels' });

    const id = seedAsset(library.db, {
      mapleId: 'refile-noop-id',
      phassetDevices: ['dev'],
      place: FRANCE,
      exif: { captured_year: 2024 },
      stages: ['thumb', 'preview', 'meili'],
      location: { libraryId: library.folderId, path: rel, filename: 'IMG_OK.HEIC' },
    });
    library.db.run(`UPDATE stage_state SET version = 4 WHERE asset_id = ?`, [id]);

    await runTick();

    expect(assetRow(library.db, id)!.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
    expect(location(library, id).path).toBe(rel);
    // Nothing moved, so the path-keyed caches are still valid.
    expect(stageRow(library.db, id, 'thumb')!.version).toBe(4);
    expect(stageRow(library.db, id, 'meili')!.version).toBe(4);
    expect(await fs.readFile(path.join(library.root, rel, 'IMG_OK.HEIC'), 'utf8')).toBe('pixels');
  });

  it('auto-disables its own toggle when the sweep completes', async () => {
    using library = await createBackupLibrary('refile-autodisable-');
    const oldRel = '2024/Tokyo';
    await writeFiles(library, oldRel, { 'IMG_AD.HEIC': 'pixels' });

    seedAsset(library.db, {
      mapleId: 'refile-ad-id',
      phassetDevices: ['dev'],
      place: JAPAN,
      exif: { captured_year: 2024 },
      stages: ['thumb', 'preview'],
      location: { libraryId: library.folderId, path: oldRel, filename: 'IMG_AD.HEIC' },
    });

    await runTick();

    // One tick clears the only candidate, so the worker marks it done AND flips
    // the operator toggle off — no "remember to disable it" caveat.
    const state = await loadMigrationState(MIGRATION_ID);
    expect(state.status).toBe('done');
    expect(state.enabled).toBe(false);
  });

  it('stamps an asset whose source file is missing, so it cannot stall the batch', async () => {
    using library = await createBackupLibrary('refile-missing-');
    // Deliberately no file on disk → the move throws SourceMissingError. The
    // asset must still be stamped, or a batch of missing sources would
    // head-of-line-block the rest of the library every tick.
    const oldRel = '2024/Tokyo';
    const id = seedAsset(library.db, {
      mapleId: 'refile-missing-id',
      phassetDevices: ['dev'],
      place: JAPAN,
      exif: { captured_year: 2024 },
      location: { libraryId: library.folderId, path: oldRel, filename: 'GHOST.HEIC' },
    });

    await runTick();

    expect(assetRow(library.db, id)!.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
    expect(location(library, id).path).toBe(oldRel); // untouched (still missing)
    expect(await refileRemaining()).toBe(0);
  });
});

/** How much work the migration still reports, after a tick. */
async function refileRemaining(): Promise<number> {
  const { refileBackups } = await import('./refile-backups.ts');
  return refileBackups.countRemaining();
}
