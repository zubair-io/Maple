import { describe, expect, test } from 'bun:test';
import type { MetadataOverride, Place } from '../db/schema.ts';
import { geoSegmentsFromOverride } from '../routes/library-relocate-helper.ts';
import { backupLocationSegments } from './location-segments.ts';

type Fields = NonNullable<MetadataOverride['place_text']>;
const override = (fields: Fields): MetadataOverride => ({
  edited_at: '2026-09-16T00:00:00Z',
  touched_fields: ['place_text'],
  place_text: fields,
});
const place = (fields: Fields): Place => ({
  source: 'nominatim',
  geocoder_version: 1,
  geocoded_at: '2026-09-16T00:00:00Z',
  lat: 0,
  lon: 0,
  display_name: null,
  address: {
    country_code: fields.country_code ?? undefined,
    state: fields.state ?? undefined,
    country: fields.country ?? undefined,
  },
  rollups: { locality: fields.city ?? null, region: null, country_code: null },
  pois: [],
  search_blob: '',
});

const cases: { name: string; fields: Fields; expected: string[] }[] = [
  { name: 'missing fields', fields: {}, expected: [] },
  { name: 'city without region', fields: { city: 'London' }, expected: [] },
  { name: 'whitespace fields', fields: { state: ' ', country: '\t', city: 'Paris' }, expected: [] },
  { name: 'country only', fields: { country: 'Japan', city: ' ' }, expected: ['Japan'] },
  {
    name: 'US missing state',
    fields: { country_code: 'us', country: 'USA', city: 'Washington' },
    expected: ['USA', 'Washington'],
  },
  {
    name: 'non-US missing country',
    fields: { country_code: 'de', state: 'Bavaria', city: 'Munich' },
    expected: ['Bavaria', 'Munich'],
  },
  {
    name: 'normalized US NYC',
    fields: {
      country_code: ' US ',
      state: ' New York ',
      country: 'USA',
      city: ' City of New York ',
    },
    expected: ['New York', 'New York City'],
  },
  {
    name: 'non-US New York',
    fields: { country_code: 'gb', state: 'England', country: 'UK', city: 'New York' },
    expected: ['UK', 'New York'],
  },
  {
    name: 'US New York outside NY',
    fields: { country_code: 'us', state: 'Florida', city: 'New York' },
    expected: ['Florida', 'New York'],
  },
  {
    name: 'town prefix',
    fields: { country: 'USA', city: 'Town of Cary' },
    expected: ['USA', 'Cary'],
  },
  {
    name: 'village prefix',
    fields: { country: 'USA', city: 'Village of Oak Park' },
    expected: ['USA', 'Oak Park'],
  },
  {
    name: 'case-insensitive civic prefix',
    fields: { country: 'UK', city: 'CITY OF London' },
    expected: ['UK', 'London'],
  },
  {
    name: 'prefix-like name',
    fields: { country: 'Australia', city: 'Townsville' },
    expected: ['Australia', 'Townsville'],
  },
  {
    name: 'prefix-only name',
    fields: { country: 'USA', city: ' City of ' },
    expected: ['USA', 'City of'],
  },
];

describe('backup and relocation location policy', () => {
  for (const { name, fields, expected } of cases) {
    test(name, () => {
      expect(backupLocationSegments(place(fields))).toEqual(expected);
      expect(geoSegmentsFromOverride(override(fields))).toEqual(expected);
    });
  }

  test('Place rollups fill blank address fields before shared naming', () => {
    const source = place({ country_code: ' ', state: ' ', country: 'USA', city: 'New York' });
    expect(
      backupLocationSegments({
        ...source,
        rollups: { ...source.rollups, country_code: 'US', region: 'New York' },
      }),
    ).toEqual(['New York', 'New York City']);
  });

  test('address country/state take precedence over conflicting rollups', () => {
    const source = place({ country_code: 'gb', state: 'England', country: 'UK', city: 'New York' });
    expect(
      backupLocationSegments({
        ...source,
        rollups: { ...source.rollups, country_code: 'us', region: 'New York' },
      }),
    ).toEqual(['UK', 'New York']);
  });

  test('only Place falls back to POI, without civic or NYC rewriting', () => {
    for (const name of ['City of Rocks', 'New York']) {
      const fields = { country_code: 'us', state: 'New York', city: ' ', sublocation: name };
      const source = { ...place(fields), pois: [{ name, category: 'natural', type: 'landmark' }] };
      expect(backupLocationSegments(source)).toEqual(['New York', name]);
      expect(geoSegmentsFromOverride(override(fields))).toEqual(['New York']);
      expect(backupLocationSegments({ ...source, address: {} })).toEqual([]);
    }
  });
});
