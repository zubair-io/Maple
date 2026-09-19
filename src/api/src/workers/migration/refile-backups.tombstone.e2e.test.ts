/**
 * refile-backups against an asset whose first location is a tombstone (#1519).
 *
 * The defect: the migration took the location at array position zero as the
 * canonical one. A delete-then-readd asset carries a tombstone there with the
 * live entry behind it, so the move was attempted against a location that no
 * longer holds the file, failed, and — being unstampable — head-of-line-blocked
 * every unsorted batch. The fix is that both the candidate predicate and the
 * move itself read the first *live* entry.
 *
 * ## One half of the original fixture is now unrepresentable
 *
 * The Mongo reproduction put the tombstone and the live entry at the SAME
 * `(library, path, filename)`. `asset_locations_lib_path_name` is UNIQUE over
 * exactly that triple regardless of liveness, so two rows cannot claim one file
 * any more and that shape cannot be built. What survives — and what the defect
 * actually turned on — is a tombstone ahead of a live entry, which this seeds at
 * a different path.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stageRegistry } from '../registry.ts';
import { runMigrationTickOnce } from '../migration.ts';
import { BACKUP_LAYOUT_VERSION, refileBackups } from './refile-backups.ts';
import { resetMigrationState, setMigrationEnabled } from '../migration-config.repo.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import type { Place } from '../../db/schema.ts';
import {
  assetRow,
  createLibrary,
  locationsOf,
  seedAsset,
  seedLocation,
} from './migration.test-helpers.ts';

const MIGRATION_ID = 'refile-backups';

afterEach(() => {
  setLibraryRootsForTests(null);
  stageRegistry._resetForTests();
});

function parisPlace(): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-01-01T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: { country: 'France', country_code: 'fr', state: 'Île-de-France' } as Place['address'],
    pois: [{ name: 'Adam', category: 'tourism', type: 'artwork' }],
    rollups: { locality: 'Paris', region: 'Île-de-France', country_code: 'fr' },
    search_blob: '',
  };
}

describe('refile-backups — tombstone ahead of the live location (#1519)', () => {
  it('refiles the LIVE entry and stamps the asset, so the batch cannot clog', async () => {
    using library = await createLibrary('refile-tombstone-');
    setLibraryRootsForTests(new Map([[library.folderId.toHexString(), library.root]]));

    const staleRel = '2026/Adam';
    const deadRel = '2026/Adam-old';
    await fs.mkdir(path.join(library.root, ...staleRel.split('/')), { recursive: true });
    await fs.writeFile(path.join(library.root, staleRel, 'IDG_0001.JPG'), 'pixels');

    const id = seedAsset(library.db, {
      mapleId: 'refile-tombstone-id',
      phassetDevices: ['dev'],
      place: parisPlace(),
      exif: { captured_year: 2026 },
      stages: ['thumb', 'preview'],
    });
    // Position zero is a tombstone; the live entry is behind it.
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal: 0,
      path: deadRel,
      filename: 'IDG_0001.JPG',
      deletedAt: '2026-05-22T00:00:00.000Z',
    });
    seedLocation(library.db, {
      assetId: id,
      libraryId: library.folderId,
      ordinal: 1,
      path: staleRel,
      filename: 'IDG_0001.JPG',
    });

    await resetMigrationState(MIGRATION_ID);
    await setMigrationEnabled(MIGRATION_ID, true, new Date().toISOString());
    await runMigrationTickOnce(50, new Date().toISOString());

    const locations = locationsOf(library.db, id);
    const live = locations.find((row) => row.deleted_at === null);
    const tombstone = locations.find((row) => row.deleted_at !== null);
    expect(live?.path).toBe('2026/France/Paris');
    expect(tombstone?.path).toBe(deadRel); // untouched

    // Stamped done → drops out of the candidate set.
    expect(assetRow(library.db, id)!.backup_layout_version).toBe(BACKUP_LAYOUT_VERSION);
    expect(await refileBackups.countRemaining()).toBe(0);

    // And the file actually moved.
    expect(
      await fs.readFile(path.join(library.root, '2026/France/Paris/IDG_0001.JPG'), 'utf8'),
    ).toBe('pixels');
    await expect(fs.stat(path.join(library.root, staleRel))).rejects.toThrow();
  });
});
