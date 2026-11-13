/**
 * The discover sweep keeps `assets.stack_primary_id` (#5849): a visit pairs a
 * folder's same-stem RAW and JPEG and unpairs what no longer pairs, and the
 * migration's triggers unpair the moment either half leaves.
 */
import { describe, expect, it } from 'bun:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newObjectIdHex } from '../../db/object-id.ts';
import {
  createDiscoverLibrary,
  seedAsset,
  seedLocation,
  type DiscoverLibrary,
} from './discover.test-helpers.ts';
import * as frontier from './frontier.repo.ts';
import { visitDirectory } from './sweeper.ts';
import type { WatchEvent } from './types.ts';

/** A file on disk that an earlier sweep already catalogued. */
function catalogued(library: DiscoverLibrary, filename: string): string {
  writeFileSync(join(library.root, filename), 'x');
  const id = seedAsset(library.db, { id: newObjectIdHex() });
  seedLocation(library.db, { assetId: id, libraryId: library.folderId.toHexString(), filename });
  return id;
}

function primaryOf(library: DiscoverLibrary, id: string): string | null {
  const row = library.db
    .query<{ p: string | null }, [string]>('SELECT stack_primary_id AS p FROM assets WHERE id = ?')
    .get(id);
  return row?.p ?? null;
}

async function sweep(library: DiscoverLibrary, gen: number): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  await frontier.seedRoot(library.folderId, library.root, gen);
  const dir = await frontier.claimNextDir(library.folderId, gen, 60_000);
  await visitDirectory(dir!, library.root, {
    folderId: library.folderId,
    handleEvent: async (event) => {
      events.push(event);
    },
  });
  return events;
}

describe('visitDirectory pairs RAW+JPEG stacks', () => {
  it('points the JPEG at its RAW, and leaves ambiguous or lone files alone', async () => {
    using library = await createDiscoverLibrary('maple-stack-');
    const raw = catalogued(library, 'IMG_1.CR3');
    const jpeg = catalogued(library, 'img_1.JPG');
    const twinRaw = catalogued(library, 'b.CR3');
    const twinA = catalogued(library, 'b.jpg');
    const twinB = catalogued(library, 'b.jpeg');
    const lone = catalogued(library, 'c.JPG');

    expect(await sweep(library, 1)).toEqual([]);

    expect(primaryOf(library, jpeg)).toBe(raw);
    for (const id of [raw, twinRaw, twinA, twinB, lone]) expect(primaryOf(library, id)).toBeNull();
  });

  it('unpairs when a third file makes the stem ambiguous', async () => {
    using library = await createDiscoverLibrary('maple-stack-');
    const raw = catalogued(library, 'IMG_1.CR3');
    const jpeg = catalogued(library, 'IMG_1.JPG');
    await sweep(library, 1);
    expect(primaryOf(library, jpeg)).toBe(raw);

    catalogued(library, 'IMG_1.jpeg');
    await sweep(library, 2);

    expect(primaryOf(library, jpeg)).toBeNull();
  });

  it('a RAW whose file vanished unpairs its JPEG as the sweep tags it missing', async () => {
    using library = await createDiscoverLibrary('maple-stack-');
    const raw = catalogued(library, 'IMG_1.CR3');
    const jpeg = catalogued(library, 'IMG_1.JPG');
    await sweep(library, 1);
    expect(primaryOf(library, jpeg)).toBe(raw);

    unlinkSync(join(library.root, 'IMG_1.CR3'));
    library.db.run(
      `UPDATE asset_locations SET missing_since = '2026-11-12T00:00:00.000Z' WHERE asset_id = ?`,
      [raw],
    );

    expect(primaryOf(library, jpeg)).toBeNull();
  });

  it('trashing either half unpairs at once, without waiting for a sweep', async () => {
    using library = await createDiscoverLibrary('maple-stack-');
    const raw = catalogued(library, 'IMG_1.CR3');
    const jpeg = catalogued(library, 'IMG_1.JPG');
    await sweep(library, 1);

    library.db.run(`UPDATE assets SET deleted_at = '2026-11-12T00:00:00.000Z' WHERE id = ?`, [raw]);
    expect(primaryOf(library, jpeg)).toBeNull();

    library.db.run(`UPDATE assets SET deleted_at = NULL WHERE id = ?`, [raw]);
    await sweep(library, 2);
    expect(primaryOf(library, jpeg)).toBe(raw);
  });

  it('renaming the JPEG away from the stem unpairs it', async () => {
    using library = await createDiscoverLibrary('maple-stack-');
    const raw = catalogued(library, 'IMG_1.CR3');
    const jpeg = catalogued(library, 'IMG_1.JPG');
    await sweep(library, 1);
    expect(primaryOf(library, jpeg)).toBe(raw);

    library.db.run(`UPDATE asset_locations SET filename = 'Trip.JPG' WHERE asset_id = ?`, [jpeg]);

    expect(primaryOf(library, jpeg)).toBeNull();
  });

  it('deleting the RAW row unpairs its JPEG', async () => {
    using library = await createDiscoverLibrary('maple-stack-');
    const raw = catalogued(library, 'IMG_1.CR3');
    const jpeg = catalogued(library, 'IMG_1.JPG');
    await sweep(library, 1);

    library.db.run('DELETE FROM assets WHERE id = ?', [raw]);

    expect(primaryOf(library, jpeg)).toBeNull();
  });
});
