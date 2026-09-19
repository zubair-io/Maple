/**
 * Integration tests for `buildDigest` — the per-run aggregation that turns
 * the live library into the small block of facts the prompt shows the model.
 *
 * The people rules carry the most weight here. A name reaching the prompt is
 * a name the model may build a collection around and put on an unattended
 * living-room screen, so this asserts the roster is filtered the same way the
 * search index filters searchable names: hidden people out (soft-hide must
 * hold), excluded people out (#2894), merged rows out, and auto-generated
 * `Person N` clusters out.
 *
 * `buildDigest` reaches its repositories with no override — it is a worker
 * function, not a repository one — so each test installs its own database
 * process-wide with `createLiveTestDatabase` rather than threading a handle
 * through the call.
 */

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { saveGeneratedSearches } from '../../db/sqlite/repos/generated-searches.repo.ts';
import { insertPerson } from '../../db/sqlite/repos/people.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { buildDigest } from './build-digest.ts';

const NOW = new Date('2026-08-17T12:00:00.000Z');

/**
 * `n` assets captured in one year/month, all in one library.
 *
 * `captured_year` and `captured_month` are generated columns over the `exif`
 * JSON, so seeding the JSON is what the year histograms actually read — there
 * is no separate column to set, and one written by hand would be ignored.
 */
function seedAssets(db: Database, libraryId: string, year: number, month: number, n: number): void {
  const exif = JSON.stringify({
    captured_at: `${year}-${String(month).padStart(2, '0')}-15T12:00:00.000Z`,
    captured_year: year,
    captured_month: month,
  });
  for (let i = 0; i < n; i += 1) {
    const assetId = insertAsset(db, { exif });
    insertLocation(db, { assetId, libraryId, path: `${year}/${month}`, filename: `${i}.dng` });
  }
}

/** One stored collection, for the recent-themes lookback. */
async function seedCollection(libraryId: string, theme: string, generatedAt: string) {
  await saveGeneratedSearches([
    {
      library_id: libraryId,
      generated_for: generatedAt.slice(0, 10),
      generated_at: generatedAt,
      model: 'qwen2.5',
      attempts: 1,
      theme,
      title: theme,
      subtitle: null,
      query: { placeQuery: theme },
      result_count: 12,
      cover_asset_id: null,
    },
  ]);
}

describe('buildDigest — people roster', () => {
  test('includes ordinary named people', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    insertPerson(live.db, { name: 'Zoe' });
    insertPerson(live.db, { name: 'Greyson' });

    const digest = await buildDigest(lib, NOW);
    expect([...digest.people].sort()).toEqual(['Greyson', 'Zoe']);
  });

  test('withholds soft-hidden people entirely', async () => {
    // Not merely filtered from results later — the model never learns the
    // name exists, so it cannot theme on them in the first place.
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    insertPerson(live.db, { name: 'Zoe' });
    insertPerson(live.db, { name: 'Secret', hidden: true });

    expect((await buildDigest(lib, NOW)).people).toEqual(['Zoe']);
  });

  test('withholds excluded people (#2894)', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    insertPerson(live.db, { name: 'Zoe' });
    insertPerson(live.db, { name: 'Excluded', excluded: true });

    expect((await buildDigest(lib, NOW)).people).toEqual(['Zoe']);
  });

  test('withholds merged-away rows', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    const survivor = insertPerson(live.db, { name: 'Zoe' });
    insertPerson(live.db, { name: 'Dupe', mergedInto: survivor });

    expect((await buildDigest(lib, NOW)).people).toEqual(['Zoe']);
  });

  test('withholds auto-generated Person N clusters', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    insertPerson(live.db, { name: 'Zoe' });
    insertPerson(live.db, { name: 'Person 12' });

    expect((await buildDigest(lib, NOW)).people).toEqual(['Zoe']);
  });
});

describe('buildDigest — coverage', () => {
  test('reports only years with credible volume', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    seedAssets(live.db, lib, 2017, 3, 60);
    seedAssets(live.db, lib, 1992, 3, 2); // thin junk tail

    expect((await buildDigest(lib, NOW)).coverageYears).toEqual([2017]);
  });

  test('drops the 1899 epoch sentinel even at high volume', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    seedAssets(live.db, lib, 1899, 3, 200);
    seedAssets(live.db, lib, 2017, 3, 60);

    expect((await buildDigest(lib, NOW)).coverageYears).toEqual([2017]);
  });

  test('counts only the requested library', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    const otherLib = insertFolder(live.db);
    seedAssets(live.db, lib, 2017, 3, 60);
    seedAssets(live.db, otherLib, 2018, 3, 60);

    expect((await buildDigest(lib, NOW)).coverageYears).toEqual([2017]);
  });
});

describe('buildDigest — this month, by year', () => {
  test('counts assets in the current month across years', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    seedAssets(live.db, lib, 2017, 8, 60);
    seedAssets(live.db, lib, 2018, 8, 55);
    seedAssets(live.db, lib, 2018, 3, 60); // different month, must not count

    expect((await buildDigest(lib, NOW)).onThisMonthByYear).toEqual([
      { year: 2017, count: 60 },
      { year: 2018, count: 55 },
    ]);
  });
});

describe('buildDigest — recent themes', () => {
  test('lists themes from recent runs so the model does not repeat them', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    await seedCollection(lib, 'autumn colours', '2026-08-16T06:00:00.000Z');
    await seedCollection(lib, 'dogs at the lake', '2026-08-15T06:00:00.000Z');

    const digest = await buildDigest(lib, NOW);
    expect([...digest.recentThemes].sort()).toEqual(['autumn colours', 'dogs at the lake']);
  });

  test('ignores themes older than the lookback window', async () => {
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    await seedCollection(lib, 'ancient history', '2026-01-01T06:00:00.000Z');

    expect((await buildDigest(lib, NOW)).recentThemes).toEqual([]);
  });

  test('ignores another library’s themes', async () => {
    // A leak here would hand the model somebody else's themes to avoid, which
    // is both useless and a disclosure of what that library has been shown.
    using live = await createLiveTestDatabase();
    const lib = insertFolder(live.db);
    const otherLib = insertFolder(live.db);
    await seedCollection(otherLib, 'their theme', '2026-08-16T06:00:00.000Z');

    expect((await buildDigest(lib, NOW)).recentThemes).toEqual([]);
  });
});
