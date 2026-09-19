/**
 * Integration tests for the search adapter — the loop's `runSearch`
 * dependency, running against a real database.
 *
 * The adapter has to agree with `GET /api/search` exactly, because the worker
 * uses it to decide whether a collection is worth keeping and the read API
 * uses the same stored query to render it. If they disagree, a collection
 * measured at 40 photos shows up on a widget with four.
 *
 * The last two tests here are the ones that matter most: they prove a
 * soft-hidden and an excluded person are kept out through the WHOLE chain —
 * `toSearchQuery` forcing the flag, `personIdsToDrop` resolving the ids,
 * `buildSearchWhere` emitting the clause — rather than asserting any single
 * link in isolation.
 *
 * `createLiveTestDatabase` rather than an override handle: `runGeneratedSearch`
 * reaches `sqliteDb()` through four layers (the person lookups, the count and
 * the page), and threading an override through all of them would be test
 * scaffolding in production code.
 */

import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { insertFace, insertPerson } from '../../db/repos/people.test-helpers.ts';
import { runGeneratedSearch } from './search-adapter.ts';
import { toSearchQuery } from './execute.ts';

interface SeedOptions {
  year?: number;
  month?: number;
  description?: string | null;
  personId?: string;
}

/**
 * Deterministic id per seed so an assertion can name the expected cover.
 *
 * `cover_asset_id` stores the asset's own hex id — the identity
 * `/api/assets/:id/*` accepts — NOT `SearchResult.id`, which is the
 * editor-facing `fs:<absPath>` form and useless against those routes.
 */
function oidFor(id: string): string {
  return id
    .padEnd(24, '0')
    .split('')
    .map((c) => c.charCodeAt(0).toString(16).slice(-1))
    .join('')
    .slice(0, 24);
}

function seedAsset(db: Database, libraryId: string, id: string, opts: SeedOptions = {}): string {
  const year = opts.year ?? 2018;
  const month = opts.month ?? 8;
  const assetId = insertAsset(db, {
    id: oidFor(id),
    exif: JSON.stringify({
      captured_at: `${year}-${String(month).padStart(2, '0')}-15T12:00:00.000Z`,
      captured_year: year,
      captured_month: month,
    }),
  });
  // `is_screenshot` is set explicitly, and that is not incidental. Every query
  // this worker builds carries a forced `isScreenshot: 'false'` (a screenshot
  // inside a themed collection is always wrong), and the SQLite translation of
  // that is `assets.is_screenshot = 0`. The column is nullable on purpose —
  // "never classified" is a third state the describe stage resolves (#3761) —
  // so a freshly-discovered asset holds NULL and `= 0` does not match it.
  // Leaving it unset here would make every case below count zero for a reason
  // that has nothing to do with the adapter.
  run(
    db,
    `UPDATE assets SET maple_id = ?, is_screenshot = 0 WHERE id = ?`,
    id.padEnd(32, '0'),
    assetId,
  );
  insertLocation(db, { assetId, libraryId, path: 'p', filename: `${id}.jpg` });
  if (opts.description !== undefined && opts.description !== null) {
    run(
      db,
      `INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)`,
      assetId,
      opts.description,
    );
  }
  if (opts.personId) insertFace(db, { assetId, personId: opts.personId });
  return assetId;
}

/** A library whose id the forced query scopes to. */
function seedLibrary(db: Database): string {
  return insertFolder(db);
}

describe('runGeneratedSearch — counting', () => {
  it('counts the assets a stored query matches', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    seedAsset(live.db, libraryId, 'a');
    seedAsset(live.db, libraryId, 'b');
    seedAsset(live.db, libraryId, 'c', { month: 3 });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect(outcome.count).toBe(2);
  });

  it('reports zero without throwing when nothing matches', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    seedAsset(live.db, libraryId, 'a', { month: 3 });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect(outcome.count).toBe(0);
    expect(outcome.captions).toEqual([]);
    expect(outcome.coverAssetId).toBeNull();
  });

  it('answers the count and the page from one translated query', async () => {
    // They are built from the same `SearchWhere` now, where the Mongo version
    // ran a `countDocuments` and a `find` over separately-wrapped filters and
    // depended on both call sites remembering `applyLiveFilter`. A collection
    // whose count and grid disagree is the failure this shape removes.
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    seedAsset(live.db, libraryId, 'a', { description: 'One' });
    const trashed = seedAsset(live.db, libraryId, 'b', { description: 'Two' });
    run(live.db, `UPDATE assets SET deleted_at = ? WHERE id = ?`, '2026-01-01T00:00:00Z', trashed);

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect(outcome.count).toBe(1);
    expect(outcome.captions).toEqual(['One']);
  });
});

describe('runGeneratedSearch — evidence for titling', () => {
  it('samples the captions of matched assets', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    seedAsset(live.db, libraryId, 'a', { description: 'A child runs across a wet lawn.' });
    seedAsset(live.db, libraryId, 'b', { description: 'Two kids laugh under a hose.' });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect([...outcome.captions].sort()).toEqual([
      'A child runs across a wet lawn.',
      'Two kids laugh under a hose.',
    ]);
  });

  it('omits assets that have no caption rather than emitting blanks', async () => {
    // Phase 3 reads these as evidence; a list of empty strings would let it
    // invent a title from nothing.
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    seedAsset(live.db, libraryId, 'a', { description: 'A child runs across a wet lawn.' });
    seedAsset(live.db, libraryId, 'b', { description: null });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect(outcome.captions).toEqual(['A child runs across a wet lawn.']);
  });

  it('names a cover asset by its own id, the identity /api/assets accepts', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    seedAsset(live.db, libraryId, 'a');

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect(outcome.coverAssetId).toBe(oidFor('a'));
  });
});

describe('runGeneratedSearch — hidden people, end to end', () => {
  it('excludes assets showing a soft-hidden person', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    const hidden = insertPerson(live.db, { name: 'Hidden Person', hidden: true });
    seedAsset(live.db, libraryId, 'visible');
    seedAsset(live.db, libraryId, 'has-hidden-face', { personId: hidden });

    // Nothing in this call mentions the hidden person: the exclusion has to
    // come from toSearchQuery forcing the flag and the search path honouring
    // it. That is the guarantee an ambient screen depends on.
    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));

    expect(outcome.count).toBe(1);
    expect(outcome.coverAssetId).toBe(oidFor('visible'));
  });

  it('excludes assets showing an excluded person (#2894)', async () => {
    using live = await createLiveTestDatabase();
    const libraryId = seedLibrary(live.db);
    const excluded = insertPerson(live.db, { name: 'Excluded Person', excluded: true });
    seedAsset(live.db, libraryId, 'visible');
    seedAsset(live.db, libraryId, 'has-excluded-face', { personId: excluded });

    const outcome = await runGeneratedSearch(toSearchQuery({ month: '8' }, libraryId));
    expect(outcome.count).toBe(1);
  });
});
