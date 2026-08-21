/**
 * Integration tests for the search adapter — the loop's `runSearch`
 * dependency, running against real Mongo.
 *
 * The adapter has to agree with `GET /api/search` exactly, because the worker
 * uses it to decide whether a collection is worth keeping and the read API
 * uses the same stored query to render it. If they disagree, a collection
 * measured at 40 photos shows up on a widget with four.
 *
 * The last test here is the one that matters most: it proves a soft-hidden
 * person is excluded through the WHOLE chain — `toSearchQuery` forcing the
 * flag, `personIdsToDrop` resolving the ids, `buildFilter` emitting the
 * clause — rather than asserting any single link in isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { ObjectId, type Db } from 'mongodb';
import { getDb } from '../../db/client.ts';
import { withTestDb } from '../../db/test-db.test-helpers.ts';
import { runGeneratedSearch } from './search-adapter.ts';
import { toSearchQuery } from './execute.ts';

// Own database + explicit close (the repo-wide suite convention, #2783).
withTestDb(`maple_test_generated_search_adapter_${process.pid}`);

let db: Db;
const LIB = new ObjectId('507f1f77bcf86cd799439011');

beforeAll(async () => {
  db = await getDb();
});
afterAll(async () => {
  // Drop the handle captured in beforeAll. Deliberately NOT closeDb(): that
  // closes the shared client, and because withTestDb registers root-level
  // beforeAll hooks, by teardown the singleton points at another suite's
  // database — closing it here times out that suite's hooks.
  await db.dropDatabase();
});

/** Scoped per describe, never at the root — a root hook is not confined to
 * this file and would wipe collections other suites depend on. */
async function reset(): Promise<void> {
  await Promise.all([
    db.collection('assets').deleteMany({}),
    db.collection('people').deleteMany({}),
  ]);
}

interface SeedOptions {
  year?: number;
  month?: number;
  description?: string | null;
  personId?: ObjectId;
}

/** Deterministic ObjectId per seed so assertions can name the expected
 * cover. `cover_asset_id` stores the Mongo `_id` hex — the identity
 * `/api/assets/:id/*` accepts — NOT `SearchResult.id`, which is the
 * editor-facing `fs:<absPath>` form and useless against those routes. */
function oidFor(id: string): ObjectId {
  return new ObjectId(
    id
      .padEnd(24, '0')
      .split('')
      .map((c) => c.charCodeAt(0).toString(16).slice(-1))
      .join('')
      .slice(0, 24),
  );
}

async function seedAsset(id: string, opts: SeedOptions = {}) {
  const year = opts.year ?? 2018;
  const month = opts.month ?? 8;
  await db.collection('assets').insertOne({
    _id: oidFor(id),
    maple_id: id,
    fileinfo: [
      {
        library_id: LIB,
        path: `/p/${id}.jpg`,
        filename: `${id}.jpg`,
        deleted_at: null,
        missing_since: null,
      },
    ],
    deleted_at: null,
    size: 1,
    mtime: 1,
    exif: {
      captured_at: `${year}-${String(month).padStart(2, '0')}-15T12:00:00.000Z`,
      captured_year: year,
      captured_month: month,
    },
    description: opts.description ?? null,
    ...(opts.personId ? { faces: [{ person_id: opts.personId.toHexString() }] } : {}),
  } as never);
}

const LIB_HEX = LIB.toHexString();

describe('runGeneratedSearch — counting', () => {
  beforeEach(reset);

  it('counts the assets a stored query matches', async () => {
    await seedAsset('a');
    await seedAsset('b');
    await seedAsset('c', { month: 3 });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));
    expect(outcome.count).toBe(2);
  });

  it('reports zero without throwing when nothing matches', async () => {
    await seedAsset('a', { month: 3 });
    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));
    expect(outcome.count).toBe(0);
    expect(outcome.captions).toEqual([]);
    expect(outcome.coverAssetId).toBeNull();
  });
});

describe('runGeneratedSearch — evidence for titling', () => {
  beforeEach(reset);

  it('samples the captions of matched assets', async () => {
    await seedAsset('a', { description: 'A child runs across a wet lawn.' });
    await seedAsset('b', { description: 'Two kids laugh under a hose.' });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));
    expect([...outcome.captions].sort()).toEqual([
      'A child runs across a wet lawn.',
      'Two kids laugh under a hose.',
    ]);
  });

  it('omits assets that have no caption rather than emitting blanks', async () => {
    // Phase 3 reads these as evidence; a list of empty strings would let it
    // invent a title from nothing.
    await seedAsset('a', { description: 'A child runs across a wet lawn.' });
    await seedAsset('b', { description: null });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));
    expect(outcome.captions).toEqual(['A child runs across a wet lawn.']);
  });

  it('names a cover asset by its Mongo _id, the identity /api/assets accepts', async () => {
    await seedAsset('a');
    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));
    expect(outcome.coverAssetId).toBe(oidFor('a').toHexString());
  });
});

describe('runGeneratedSearch — hidden people, end to end', () => {
  beforeEach(reset);

  it('excludes assets showing a soft-hidden person', async () => {
    const hidden = new ObjectId();
    await db.collection('people').insertOne({
      _id: hidden,
      name: 'Hidden Person',
      merged_into: null,
      hidden: true,
    } as never);

    await seedAsset('visible');
    await seedAsset('has-hidden-face', { personId: hidden });

    // Nothing in this call mentions the hidden person: the exclusion has to
    // come from toSearchQuery forcing the flag and the search path honouring
    // it. That is the guarantee an ambient screen depends on.
    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));

    expect(outcome.count).toBe(1);
    expect(outcome.coverAssetId).toBe(oidFor('visible').toHexString());
  });

  it('excludes assets showing an excluded person (#2894)', async () => {
    const excluded = new ObjectId();
    await db.collection('people').insertOne({
      _id: excluded,
      name: 'Excluded Person',
      merged_into: null,
      excluded: true,
    } as never);

    await seedAsset('visible');
    await seedAsset('has-excluded-face', { personId: excluded });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, LIB_HEX));
    expect(outcome.count).toBe(1);
  });
});
