/**
 * Integration tests for `buildDigest` — the per-run aggregation that turns
 * the live library into the small block of facts the prompt shows the model.
 *
 * The people rules carry the most weight here. A name reaching the prompt is
 * a name the model may build a collection around and put on an unattended
 * living-room screen, so this asserts the roster is filtered the same way
 * `stages/meili.ts` filters searchable names: hidden people out (soft-hide
 * must hold), excluded people out (#2894), merged rows out, and
 * auto-generated `Person N` clusters out.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, getDb } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';
import { buildDigest } from './build-digest.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_search_digest_${process.pid}`);

let db: Db;
const LIB = new ObjectId('507f1f77bcf86cd799439011');
const OTHER_LIB = new ObjectId('507f1f77bcf86cd799439012');

beforeAll(async () => {
  db = await getDb();
});
afterAll(async () => {
  await db.dropDatabase();
  await closeDb();
});
/**
 * Clear only this suite's fixtures. Deliberately NOT a root-level
 * `beforeEach`: a root hook is not confined to this file, so wiping shared
 * collections there tears state out from under every other suite in the
 * process. Each `describe` opts in instead.
 */
async function reset(): Promise<void> {
  await Promise.all([
    db.collection('assets').deleteMany({}),
    db.collection('people').deleteMany({}),
    db.collection('generated_searches').deleteMany({}),
  ]);
}

/** `n` assets in one year/month for a library. */
async function seedAssets(year: number, month: number, n: number, library = LIB) {
  const docs = Array.from({ length: n }, (_, i) => ({
    maple_id: `${library.toHexString()}-${year}-${month}-${i}`,
    fileinfo: [{ library_id: library, path: `/p/${year}/${i}.jpg` }],
    exif: {
      captured_at: `${year}-${String(month).padStart(2, '0')}-15T12:00:00.000Z`,
      captured_year: year,
      captured_month: month,
    },
  }));
  await db.collection('assets').insertMany(docs as never);
}

async function seedPerson(name: string, flags: Record<string, unknown> = {}) {
  await db
    .collection('people')
    .insertOne({ _id: new ObjectId(), name, merged_into: null, ...flags } as never);
}

const NOW = new Date('2026-08-17T12:00:00.000Z');

describe('buildDigest — people roster', () => {
  beforeEach(reset);

  it('includes ordinary named people', async () => {
    await seedPerson('Zoe');
    await seedPerson('Greyson');
    const digest = await buildDigest(LIB.toHexString(), NOW);
    expect([...digest.people].sort()).toEqual(['Greyson', 'Zoe']);
  });

  it('withholds soft-hidden people entirely', async () => {
    // Not merely filtered from results later — the model never learns the
    // name exists, so it cannot theme on them in the first place.
    await seedPerson('Zoe');
    await seedPerson('Secret', { hidden: true });
    expect((await buildDigest(LIB.toHexString(), NOW)).people).toEqual(['Zoe']);
  });

  it('withholds excluded people (#2894)', async () => {
    await seedPerson('Zoe');
    await seedPerson('Excluded', { excluded: true });
    expect((await buildDigest(LIB.toHexString(), NOW)).people).toEqual(['Zoe']);
  });

  it('withholds merged-away rows', async () => {
    await seedPerson('Zoe');
    await seedPerson('Dupe', { merged_into: new ObjectId() });
    expect((await buildDigest(LIB.toHexString(), NOW)).people).toEqual(['Zoe']);
  });

  it('withholds auto-generated Person N clusters', async () => {
    await seedPerson('Zoe');
    await seedPerson('Person 12');
    expect((await buildDigest(LIB.toHexString(), NOW)).people).toEqual(['Zoe']);
  });
});

describe('buildDigest — coverage', () => {
  beforeEach(reset);

  it('reports only years with credible volume', async () => {
    await seedAssets(2017, 3, 60);
    await seedAssets(1992, 3, 2); // thin junk tail
    const digest = await buildDigest(LIB.toHexString(), NOW);
    expect(digest.coverageYears).toEqual([2017]);
  });

  it('drops the 1899 epoch sentinel even at high volume', async () => {
    await seedAssets(1899, 3, 200);
    await seedAssets(2017, 3, 60);
    expect((await buildDigest(LIB.toHexString(), NOW)).coverageYears).toEqual([2017]);
  });

  it('counts only the requested library', async () => {
    await seedAssets(2017, 3, 60);
    await seedAssets(2018, 3, 60, OTHER_LIB);
    expect((await buildDigest(LIB.toHexString(), NOW)).coverageYears).toEqual([2017]);
  });
});

describe('buildDigest — this month, by year', () => {
  beforeEach(reset);

  it('counts assets in the current month across years', async () => {
    await seedAssets(2017, 8, 60);
    await seedAssets(2018, 8, 55);
    await seedAssets(2018, 3, 60); // different month, must not count
    const digest = await buildDigest(LIB.toHexString(), NOW);
    expect(digest.onThisMonthByYear).toEqual([
      { year: 2017, count: 60 },
      { year: 2018, count: 55 },
    ]);
  });
});

describe('buildDigest — recent themes', () => {
  beforeEach(reset);

  it('lists themes from recent runs so the model does not repeat them', async () => {
    await db.collection('generated_searches').insertMany([
      { library_id: LIB.toHexString(), theme: 'autumn colours', generated_at: '2026-08-16T06:00:00.000Z' },
      { library_id: LIB.toHexString(), theme: 'dogs at the lake', generated_at: '2026-08-15T06:00:00.000Z' },
    ] as never);
    const digest = await buildDigest(LIB.toHexString(), NOW);
    expect([...digest.recentThemes].sort()).toEqual(['autumn colours', 'dogs at the lake']);
  });

  it('ignores themes older than the lookback window', async () => {
    await db.collection('generated_searches').insertOne({
      library_id: LIB.toHexString(),
      theme: 'ancient history',
      generated_at: '2026-01-01T06:00:00.000Z',
    } as never);
    expect((await buildDigest(LIB.toHexString(), NOW)).recentThemes).toEqual([]);
  });
});
