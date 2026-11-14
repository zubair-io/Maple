/**
 * RAW+JPEG stacks in the service photo API, held to one rule: a photo returned or counted for a
 * filter is the one that matches it, and a pair folds into its RAW only when the RAW matches too.
 * That holds for the text (`foldRankedStacks`), the place, the people and the people listing,
 * and every photo a search returns can be read by id.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SeedAsset } from '../src/db/repos/search.test-helpers.ts';
import { run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { setInProcessSearchForTests } from '../src/search/search-pool.ts';
import { fakeInProcessSearch } from '../src/search/search.test-helpers.ts';
import {
  createServiceFixture,
  placeDoc,
  search,
  serviceRequest,
  type ServiceFixture,
} from './helpers/service-photos-fixtures.ts';

const DAY = '2024-07-04';
const PARIS = placeDoc({
  locality: 'Paris',
  region: 'Île-de-France',
  countryCode: 'fr',
  country: 'France',
  displayName: 'Rue de Rivoli, Paris, Île-de-France, France',
});

let fx: ServiceFixture;

beforeEach(async () => {
  fx = await createServiceFixture();
  setInProcessSearchForTests(fakeInProcessSearch(null));
});

afterEach(() => {
  setInProcessSearchForTests(null);
  fx.close();
});

/** A RAW and its JPEG, shot at the same moment; returns their ids. */
function pair(rawSeed: SeedAsset = {}, jpegSeed: SeedAsset = {}) {
  const capturedAt = `${DAY}T10:00:00.000Z`;
  const raw = fx.photo({ filename: 'IMG_0001.dng', path: '', capturedAt, ...rawSeed });
  const jpeg = fx.photo({ filename: 'IMG_0001.jpg', path: '', capturedAt, ...jpegSeed });
  run(fx.live.db, 'UPDATE assets SET stack_primary_id = ? WHERE id = ?', raw, jpeg);
  return { raw, jpeg };
}

/** `ids`, `total` and `days` of one search, which must all describe the same photos. */
async function answer(body: unknown) {
  const result = await search(fx.key, body);
  return {
    ids: result.body.photos.map((photo) => photo.assetId),
    total: result.body.total,
    days: result.body.days,
  };
}

async function people() {
  const response = await serviceRequest('/people', fx.key);
  return ((await response.json()) as { people: Array<Record<string, unknown>> }).people;
}

describe('text', () => {
  it('folds the JPEG into its RAW when no text is searched', async () => {
    const { raw } = pair();
    expect(await answer({ from: DAY, to: DAY })).toEqual({
      ids: [raw],
      total: 1,
      days: [{ date: DAY, count: 1, place: null }],
    });
  });

  it('keeps a JPEG that alone matched the text, consistently across the response', async () => {
    const { jpeg } = pair({ searchBlob: 'forest' }, { searchBlob: 'lighthouse' });
    for (const body of [{ query: 'lighthouse' }, { query: 'lighthouse', from: DAY, to: DAY }]) {
      expect(await answer(body)).toEqual({
        ids: [jpeg],
        total: 1,
        days: [{ date: DAY, count: 1, place: null }],
      });
    }
    expect((await serviceRequest(`/photos/${jpeg}`, fx.key)).status).toBe(200);
  });
});

describe('place', () => {
  it('finds a JPEG whose place its RAW lacks, with and without text', async () => {
    const { jpeg } = pair(
      { searchBlob: 'lighthouse' },
      { searchBlob: 'lighthouse', placeDoc: PARIS },
    );
    const days = [{ date: DAY, count: 1, place: 'Paris, Île-de-France' }];
    expect(await answer({ place: 'paris' })).toEqual({ ids: [jpeg], total: 1, days });
    expect(await answer({ place: 'paris', query: 'lighthouse' })).toEqual({
      ids: [jpeg],
      total: 1,
      days,
    });
    expect((await serviceRequest(`/photos/${jpeg}`, fx.key)).status).toBe(200);
  });

  it('still folds the pair when the RAW has the place too', async () => {
    const { raw } = pair({ placeDoc: PARIS }, { placeDoc: PARIS });
    expect((await answer({ place: 'paris' })).ids).toEqual([raw]);
  });
});

describe('people', () => {
  it('lists and finds a person seen only on the JPEG, counting and covering with it', async () => {
    const { jpeg } = pair({}, { people: ['Ada'] });
    const ada = fx.people.get('Ada')!;
    expect(await people()).toEqual([
      { id: ada, name: 'Ada', autoNamed: false, photoCount: 1, coverAssetId: jpeg },
    ]);
    expect(await answer({ people: [ada] })).toEqual({
      ids: [jpeg],
      total: 1,
      days: [{ date: DAY, count: 1, place: null }],
    });
  });

  it('counts a pair once, as its RAW, when both halves show the person', async () => {
    const { raw, jpeg } = pair({ people: ['Ada'] }, { people: ['Ada'] });
    const newer = fx.photo({ capturedAt: '2024-07-05T10:00:00.000Z', people: ['Ada'] });
    const ada = fx.people.get('Ada')!;
    // A chosen cover on the JPEG is served as the RAW the person's search returns, not replaced.
    run(fx.live.db, 'UPDATE people SET cover_asset_id = ? WHERE id = ?', jpeg, ada);
    expect(await people()).toEqual([
      { id: ada, name: 'Ada', autoNamed: false, photoCount: 2, coverAssetId: raw },
    ]);
    expect(await answer({ people: [ada] })).toMatchObject({ ids: [newer, raw], total: 2 });
  });

  it('counts each half for the person it alone shows', async () => {
    const { raw, jpeg } = pair({ people: ['Ada'] }, { people: ['Grace'] });
    const listed = await people();
    expect(listed.map((person) => [person.name, person.photoCount, person.coverAssetId])).toEqual([
      ['Ada', 1, raw],
      ['Grace', 1, jpeg],
    ]);
  });

  it('leaves out a person whose only photo is a stack its hidden RAW hides', async () => {
    const { raw } = pair({ people: ['Ada'] }, { people: ['Ada'] });
    run(fx.live.db, 'UPDATE assets SET hidden = 1 WHERE id = ?', raw);
    expect(await people()).toEqual([]);
    expect((await answer({ people: [fx.people.get('Ada')!] })).total).toBe(0);
  });
});
