import { describe, test, expect } from 'bun:test';
import { backupLocationSegments } from './location-segments.ts';
import type { Place } from '../db/schema.ts';

/** Build a minimal Place with just the fields the deriver reads. */
function place(p: {
  address?: Partial<Place['address']>;
  rollups?: Partial<Place['rollups']>;
  pois?: Place['pois'];
}): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-03-15T00:00:00.000Z',
    lat: 0,
    lon: 0,
    display_name: null,
    address: (p.address ?? {}) as Place['address'],
    pois: p.pois ?? [],
    rollups: {
      locality: null,
      region: null,
      country_code: null,
      ...(p.rollups ?? {}),
    },
    search_blob: '',
  };
}

describe('backupLocationSegments', () => {
  test('USA → [State, City] using full state name', () => {
    expect(
      backupLocationSegments(
        place({
          address: {
            state: 'California',
            state_code: 'CA',
            country: 'United States',
            country_code: 'us',
          },
          rollups: { locality: 'San Francisco', region: 'California', country_code: 'us' },
        }),
      ),
    ).toEqual(['California', 'San Francisco']);
  });

  test('non-USA → [Country, City] using full country name', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Île-de-France', country: 'France', country_code: 'fr' },
          rollups: { locality: 'Paris', region: 'Île-de-France', country_code: 'fr' },
        }),
      ),
    ).toEqual(['France', 'Paris']);
  });

  test('country code is case-insensitive (US → state)', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'New York', country: 'United States', country_code: 'US' },
          rollups: { locality: 'Albany' },
        }),
      ),
    ).toEqual(['New York', 'Albany']);
  });

  test('Town/City || Place Name: locality preferred over POI', () => {
    expect(
      backupLocationSegments(
        place({
          address: { country: 'Japan', country_code: 'jp' },
          rollups: { locality: 'Kyoto' },
          pois: [{ name: 'Kinkaku-ji', category: 'tourism', type: 'attraction' }],
        }),
      ),
    ).toEqual(['Japan', 'Kyoto']);
  });

  test('Town/City || Place Name: falls back to POI when no locality', () => {
    expect(
      backupLocationSegments(
        place({
          address: { country: 'Japan', country_code: 'jp' },
          rollups: { locality: null },
          pois: [{ name: 'Mount Fuji', category: 'natural', type: 'peak' }],
        }),
      ),
    ).toEqual(['Japan', 'Mount Fuji']);
  });

  test('region but no locality/POI → single [top] segment', () => {
    expect(
      backupLocationSegments(
        place({ address: { state: 'Nevada', country: 'United States', country_code: 'us' } }),
      ),
    ).toEqual(['Nevada']);
  });

  test('USA with no state falls back to country as the top segment', () => {
    expect(
      backupLocationSegments(
        place({
          address: { country: 'United States', country_code: 'us' },
          rollups: { locality: 'Washington' },
        }),
      ),
    ).toEqual(['United States', 'Washington']);
  });

  test('non-USA with no country falls back to state as the top segment', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Bavaria', country_code: 'de' },
          rollups: { locality: 'Munich' },
        }),
      ),
    ).toEqual(['Bavaria', 'Munich']);
  });

  test('unresolved stub (no country/state) → [] (date fallback)', () => {
    expect(backupLocationSegments(place({}))).toEqual([]);
  });

  test('null place → []', () => {
    expect(backupLocationSegments(null)).toEqual([]);
  });

  test('reads country_code from rollups when address lacks it', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Texas' },
          rollups: { locality: 'Austin', region: 'Texas', country_code: 'us' },
        }),
      ),
    ).toEqual(['Texas', 'Austin']);
  });
});

describe('backupLocationSegments — city/town name overrides', () => {
  test('strips a leading "City of " prefix from the locality', () => {
    expect(
      backupLocationSegments(
        place({
          address: { country: 'United Kingdom', country_code: 'gb' },
          rollups: { locality: 'City of London' },
        }),
      ),
    ).toEqual(['United Kingdom', 'London']);
  });

  test('strips a leading "Town of " prefix from the locality', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'North Carolina', country: 'United States', country_code: 'us' },
          rollups: { locality: 'Town of Cary' },
        }),
      ),
    ).toEqual(['North Carolina', 'Cary']);
  });

  test('strips a leading "Village of " prefix from the locality', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Illinois', country: 'United States', country_code: 'us' },
          rollups: { locality: 'Village of Oak Park' },
        }),
      ),
    ).toEqual(['Illinois', 'Oak Park']);
  });

  test('prefix match is case-insensitive', () => {
    expect(
      backupLocationSegments(
        place({
          address: { country: 'United Kingdom', country_code: 'gb' },
          rollups: { locality: 'CITY OF Westminster' },
        }),
      ),
    ).toEqual(['United Kingdom', 'Westminster']);
  });

  test('does not strip a place whose name merely starts with City/Town/Village', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Queensland', country: 'Australia', country_code: 'au' },
          rollups: { locality: 'Townsville' },
        }),
      ),
    ).toEqual(['Australia', 'Townsville']);
  });

  test('a locality that is only the prefix is left intact (never emptied)', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Nevada', country: 'United States', country_code: 'us' },
          rollups: { locality: 'City of' },
        }),
      ),
    ).toEqual(['Nevada', 'City of']);
  });

  test('renames the city "New York" to "New York City" without touching the state', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'New York', country: 'United States', country_code: 'us' },
          rollups: { locality: 'New York', region: 'New York', country_code: 'us' },
        }),
      ),
    ).toEqual(['New York', 'New York City']);
  });

  test('"City of New York" → "New York City" (strip prefix, then rename)', () => {
    expect(
      backupLocationSegments(
        place({
          address: { state: 'New York', country: 'United States', country_code: 'us' },
          rollups: { locality: 'City of New York', region: 'New York', country_code: 'us' },
        }),
      ),
    ).toEqual(['New York', 'New York City']);
  });

  test('overrides apply to the locality only, not a POI fallback', () => {
    // "City of Rocks" is a natural landmark (POI), not a city — leave it alone.
    expect(
      backupLocationSegments(
        place({
          address: { state: 'Idaho', country: 'United States', country_code: 'us' },
          rollups: { locality: null },
          pois: [{ name: 'City of Rocks National Reserve', category: 'natural', type: 'reserve' }],
        }),
      ),
    ).toEqual(['Idaho', 'City of Rocks National Reserve']);
  });
});
