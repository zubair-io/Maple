/**
 * `POST /api/service/photos/search` and `GET /api/service/photos/:assetId`: filter semantics,
 * visibility, day buckets, the wire shape and pagination. The in-process engine is absent, so a
 * `query` is ranked by the database's full-text index, as it is while the engine loads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { setInProcessSearchForTests } from '../src/search/search-pool.ts';
import { fakeInProcessSearch } from '../src/search/search.test-helpers.ts';
import {
  createServiceFixture,
  search,
  serviceRequest,
  type ServiceFixture,
} from './helpers/service-photos-fixtures.ts';

let fx: ServiceFixture;

beforeEach(async () => {
  fx = await createServiceFixture();
  setInProcessSearchForTests(fakeInProcessSearch(null));
});

afterEach(() => {
  setInProcessSearchForTests(null);
  fx.close();
});

const ids = (body: { photos: Array<{ assetId: string }> }) =>
  body.photos.map((photo) => photo.assetId);

function placeDoc(fields: {
  locality: string | null;
  region: string | null;
  countryCode: string;
  country: string;
  displayName: string;
  extra?: Record<string, string>;
}) {
  return {
    source: 'nominatim',
    geocoder_version: 3,
    display_name: fields.displayName,
    address: {
      ...(fields.locality ? { town: fields.locality } : {}),
      ...(fields.region ? { state: fields.region } : {}),
      country: fields.country,
      country_code: fields.countryCode,
      ...fields.extra,
    },
    pois: [],
    rollups: { locality: fields.locality, region: fields.region, country_code: fields.countryCode },
    search_blob: '',
  };
}

const WINDHAM = placeDoc({
  locality: 'Windham',
  region: 'New York',
  countryCode: 'us',
  country: 'United States',
  displayName: 'Main Street, Windham, Greene County, New York, United States',
  extra: { county: 'Greene County', road: 'Main Street' },
});
const PARIS = placeDoc({
  locality: 'Paris',
  region: 'Île-de-France',
  countryCode: 'fr',
  country: 'France',
  displayName: 'Rue de Rivoli, Paris, Île-de-France, France métropolitaine, France',
});
const LYON = placeDoc({
  locality: 'Lyon',
  region: 'Auvergne-Rhône-Alpes',
  countryCode: 'fr',
  country: 'France',
  displayName: 'Lyon, Auvergne-Rhône-Alpes, France',
});
const PARISH = placeDoc({
  locality: 'Hudson',
  region: 'New York',
  countryCode: 'us',
  country: 'United States',
  displayName: 'Parish Road, Hudson, New York, United States',
});

describe('people filter', () => {
  it('requires every listed person to be in the photo', async () => {
    const both = fx.photo({ capturedAt: '2024-07-03T10:00:00.000Z', people: ['Ada', 'Grace'] });
    const adaOnly = fx.photo({ capturedAt: '2024-07-02T10:00:00.000Z', people: ['Ada'] });
    fx.photo({ capturedAt: '2024-07-01T10:00:00.000Z', people: ['Grace'] });
    const ada = fx.people.get('Ada')!;
    const grace = fx.people.get('Grace')!;

    expect(ids((await search(fx.key, { people: [ada] })).body)).toEqual([both, adaOnly]);
    const together = await search(fx.key, { people: [ada, grace] });
    expect(ids(together.body)).toEqual([both]);
    expect(together.body.total).toBe(1);
    expect(together.body.photos[0]!.people).toEqual([
      { id: ada, name: 'Ada' },
      { id: grace, name: 'Grace' },
    ]);
  });

  it('matches nothing for a hidden, excluded, merged or unknown person', async () => {
    fx.photo({ capturedAt: '2024-07-01T10:00:00.000Z', people: ['Hidden', 'Merged', 'Ada'] });
    const hidden = fx.people.get('Hidden')!;
    const merged = fx.people.get('Merged')!;
    run(fx.live.db, 'UPDATE people SET hidden = 1 WHERE id = ?', hidden);
    run(
      fx.live.db,
      'UPDATE people SET merged_into = ? WHERE id = ?',
      fx.people.get('Ada')!,
      merged,
    );

    for (const personId of [hidden, merged, '0123456789abcdef01234567']) {
      const result = await search(fx.key, { people: [personId] });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ total: 0, days: [], photos: [], nextCursor: null });
    }
  });

  it('keeps hidden people out of a photo’s people, and drops excluded people’s photos', async () => {
    const shown = fx.photo({ capturedAt: '2024-07-02T10:00:00.000Z', people: ['Ada', 'Hidden'] });
    fx.photo({ capturedAt: '2024-07-01T10:00:00.000Z', people: ['Ada', 'Excluded'] });
    run(fx.live.db, 'UPDATE people SET hidden = 1 WHERE id = ?', fx.people.get('Hidden')!);
    run(fx.live.db, 'UPDATE people SET excluded = 1 WHERE id = ?', fx.people.get('Excluded')!);

    const result = await search(fx.key, { people: [fx.people.get('Ada')!] });
    expect(ids(result.body)).toEqual([shown]);
    expect(result.body.photos[0]!.people.map((person) => person.name)).toEqual(['Ada']);
  });
});

describe('visibility', () => {
  it('excludes hidden, trashed, missing and non-image assets, and 404s them by id', async () => {
    const visible = fx.photo({ capturedAt: '2024-07-05T10:00:00.000Z' });
    const excluded = [
      fx.photo({ capturedAt: '2024-07-05T11:00:00.000Z', hidden: true }),
      fx.photo({ capturedAt: '2024-07-05T12:00:00.000Z', deletedAt: '2024-08-01T00:00:00.000Z' }),
      fx.photo({
        capturedAt: '2024-07-05T13:00:00.000Z',
        locationMissingSince: '2024-08-01T00:00:00.000Z',
      }),
      fx.photo({ capturedAt: '2024-07-05T14:00:00.000Z', mediaKind: 'video' }),
    ];
    const result = await search(fx.key, { from: '2024-07-05', to: '2024-07-05' });
    expect(ids(result.body)).toEqual([visible]);
    for (const id of excluded) {
      expect((await serviceRequest(`/photos/${id}`, fx.key)).status).toBe(404);
    }
  });
});

describe('place filter', () => {
  it('matches locality, country name and display name, ignoring case and diacritics', async () => {
    const windham = fx.photo({ capturedAt: '2024-07-04T10:00:00.000Z', placeDoc: WINDHAM });
    const paris = fx.photo({ capturedAt: '2024-07-03T10:00:00.000Z', placeDoc: PARIS });
    const lyon = fx.photo({ capturedAt: '2024-07-02T10:00:00.000Z', placeDoc: LYON });
    const parish = fx.photo({ capturedAt: '2024-07-01T10:00:00.000Z', placeDoc: PARISH });
    fx.photo({ capturedAt: '2024-07-04T11:00:00.000Z', placeDoc: WINDHAM }, fx.otherId);

    const matches = async (place: string) => ids((await search(fx.key, { place })).body);
    expect(await matches('windham')).toEqual([windham]);
    expect(await matches('WINDHAM, new york')).toEqual([windham]);
    expect(await matches('Greene County')).toEqual([windham]);
    expect(await matches('paris')).toEqual([paris]);
    expect(await matches('france')).toEqual([paris, lyon]);
    expect(await matches('ile de france')).toEqual([paris]);
    expect(await matches('Auvergne Rhone')).toEqual([lyon]);
    expect(await matches('new york')).toEqual([windham, parish]);
    expect(await matches('united states')).toEqual([windham, parish]);
    expect(await matches('nowhere')).toEqual([]);
  });

  it('matches a country by its English name when the stored name is in another language', async () => {
    const tokyo = fx.photo({
      capturedAt: '2024-07-04T10:00:00.000Z',
      placeDoc: placeDoc({
        locality: '東京',
        region: null,
        countryCode: 'jp',
        country: '日本',
        displayName: '東京, 日本',
      }),
    });
    expect(ids((await search(fx.key, { place: 'Japan' })).body)).toEqual([tokyo]);
  });

  it('reports the place on each photo', async () => {
    fx.photo({
      capturedAt: '2024-07-04T10:00:00.000Z',
      placeDoc: WINDHAM,
      gps: { lat: 42.3, lng: -74.25 },
    });
    const [photo] = (await search(fx.key, { place: 'windham' })).body.photos;
    expect(photo).toMatchObject({
      capturedAt: '2024-07-04T10:00:00.000Z',
      place: {
        label: 'Windham, New York',
        locality: 'Windham',
        region: 'New York',
        countryCode: 'us',
      },
      lat: 42.3,
      lng: -74.25,
      people: [],
    });
  });
});

describe('capture-date range and day buckets', () => {
  it('is inclusive at the precision given', async () => {
    const morning = fx.photo({ capturedAt: '2024-07-04T08:00:00.000Z' });
    const evening = fx.photo({ capturedAt: '2024-07-04T23:59:59.000Z' });
    const next = fx.photo({ capturedAt: '2024-07-05T00:00:00.000Z' });
    fx.photo({ capturedAt: '2024-07-03T23:59:59.999Z' });
    fx.photo({ capturedAt: null });

    expect(ids((await search(fx.key, { from: '2024-07-04', to: '2024-07-04' })).body)).toEqual([
      evening,
      morning,
    ]);
    expect(
      ids((await search(fx.key, { from: '2024-07-04T08:00', to: '2024-07-05T00:00:00' })).body),
    ).toEqual([next, evening, morning]);
    expect(ids((await search(fx.key, { from: '2024-07-04T08:00:01Z' })).body)).toEqual([
      next,
      evening,
    ]);
  });

  it('buckets every match by day, newest first, with the most common place', async () => {
    fx.photo({ capturedAt: '2024-07-04T10:00:00.000Z', placeDoc: WINDHAM });
    fx.photo({ capturedAt: '2024-07-04T11:00:00.000Z', placeDoc: WINDHAM });
    fx.photo({ capturedAt: '2024-07-04T12:00:00.000Z', placeDoc: PARIS });
    fx.photo({ capturedAt: '2024-07-02T09:00:00.000Z' });
    fx.photo({ capturedAt: '2024-06-30T09:00:00.000Z', placeDoc: LYON });

    const result = await search(fx.key, { from: '2024-06-01', limit: 1 });
    expect(result.body.total).toBe(5);
    expect(result.body.photos).toHaveLength(1);
    expect(result.body.days).toEqual([
      { date: '2024-07-04', count: 3, place: 'Windham, New York' },
      { date: '2024-07-02', count: 1, place: null },
      { date: '2024-06-30', count: 1, place: 'Lyon, Auvergne-Rhône-Alpes' },
    ]);
  });

  it('caps the buckets at the newest 366 days', async () => {
    const start = Date.UTC(2023, 0, 1);
    for (let day = 0; day < 370; day++) {
      fx.photo({ capturedAt: new Date(start + day * 86_400_000).toISOString() });
    }
    const result = await search(fx.key, { from: '2023-01-01' });
    expect(result.body.total).toBe(370);
    expect(result.body.days).toHaveLength(366);
    expect(result.body.days[0]!.date).toBe('2024-01-05');
    expect(result.body.days.at(-1)!.date).toBe('2023-01-05');
  });
});

describe('pagination', () => {
  it('walks every match newest first without repeats, and rejects a foreign cursor', async () => {
    const seeded = Array.from({ length: 7 }, (_, i) =>
      fx.photo({ capturedAt: `2024-07-0${i + 1}T10:00:00.000Z` }),
    );
    // Two photos in the same second: the id breaks the tie.
    seeded.push(fx.photo({ capturedAt: '2024-07-07T10:00:00.000Z' }));

    const served: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await search(fx.key, {
        from: '2024-07-01',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(8);
      served.push(...ids(page.body));
      cursor = page.body.nextCursor;
    } while (cursor !== null);

    expect(served).toHaveLength(8);
    expect(new Set(served).size).toBe(8);
    expect(served.slice(-1)).toEqual([seeded[0]!]);

    const first = await search(fx.key, { from: '2024-07-01', limit: 3 });
    const foreign = await search(fx.key, {
      from: '2024-07-02',
      limit: 3,
      cursor: first.body.nextCursor,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_cursor');
    expect((await search(fx.key, { from: '2024-07-01', cursor: 'garbage' })).status).toBe(400);
  });
});

describe('free-text query', () => {
  it('ranks by relevance alone, and pages through the ranked window', async () => {
    const strong = fx.photo({
      capturedAt: '2024-07-01T10:00:00.000Z',
      searchBlob: 'lighthouse lighthouse lighthouse coast',
    });
    const weak = fx.photo({
      capturedAt: '2024-07-02T10:00:00.000Z',
      searchBlob: 'lighthouse in the far distance behind many other words here',
    });
    fx.photo({ capturedAt: '2024-07-03T10:00:00.000Z', searchBlob: 'forest' });
    fx.photo({ capturedAt: '2024-07-03T11:00:00.000Z', searchBlob: 'lighthouse' }, fx.otherId);

    const first = await search(fx.key, { query: 'lighthouse', limit: 1 });
    expect(first.body.total).toBe(2);
    expect(ids(first.body)).toEqual([strong]);
    expect(first.body.days.map((day) => day.date)).toEqual(['2024-07-02', '2024-07-01']);
    const second = await search(fx.key, {
      query: 'lighthouse',
      limit: 1,
      cursor: first.body.nextCursor,
    });
    expect(ids(second.body)).toEqual([weak]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('sorts newest first once another filter is combined with the query', async () => {
    const older = fx.photo({
      capturedAt: '2024-07-01T10:00:00.000Z',
      searchBlob: 'lighthouse lighthouse lighthouse',
      people: ['Ada'],
    });
    const newer = fx.photo({
      capturedAt: '2024-07-02T10:00:00.000Z',
      searchBlob: 'lighthouse and other words',
      people: ['Ada'],
    });
    fx.photo({ capturedAt: '2024-07-03T10:00:00.000Z', searchBlob: 'lighthouse' });

    const result = await search(fx.key, { query: 'lighthouse', people: [fx.people.get('Ada')!] });
    expect(ids(result.body)).toEqual([newer, older]);
    expect(result.body.total).toBe(2);
  });
});

describe('GET /api/service/photos/:assetId', () => {
  it('returns one photo in the search shape', async () => {
    const id = fx.photo({
      capturedAt: '2024-07-04T10:00:00.000Z',
      placeDoc: PARIS,
      people: ['Ada', 'Person 3'],
    });
    const response = await serviceRequest(`/photos/${id}`, fx.key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assetId: id,
      capturedAt: '2024-07-04T10:00:00.000Z',
      place: {
        label: 'Paris, Île-de-France',
        locality: 'Paris',
        region: 'Île-de-France',
        countryCode: 'fr',
      },
      lat: null,
      lng: null,
      people: [
        { id: fx.people.get('Ada'), name: 'Ada' },
        { id: fx.people.get('Person 3'), name: 'Person 3' },
      ],
    });
    const [fromSearch] = (await search(fx.key, { place: 'paris' })).body.photos;
    expect(fromSearch).toEqual(
      (await (await serviceRequest(`/photos/${id}`, fx.key)).json()) as never,
    );
  });
});
