/**
 * Unit tests for the pure logic behind the `refile-legacy-daydir` script —
 * the candidate path shape, and the corrected-directory computation that
 * (unlike `refile-backups`'s `computeCanonicalDir`) trusts EXIF/filename over
 * whatever year the asset's stale path segment claims. No DB. The
 * Mongo-gated batch runner is covered by `refile-legacy-daydir.e2e.test.ts`.
 */
import { describe, test, expect } from 'bun:test';
import {
  LEGACY_DAYDIR_WITH_LOCATION_RE,
  LEGACY_DAYDIR_NO_LOCATION_RE,
  LEGACY_DAYDIR_VERSION,
  isLegacyDaydirPath,
  legacyDaydirCandidateFilter,
  resolveLegacyCapturedYear,
  computeCorrectedDir,
} from './refile-legacy-daydir.ts';
import type { Place } from '../../db/schema.ts';

function place(p: {
  address?: Partial<Place['address']>;
  rollups?: Partial<Place['rollups']>;
  pois?: Place['pois'];
}): Place {
  return {
    source: 'nominatim',
    geocoder_version: 1,
    geocoded_at: '2024-01-01T00:00:00.000Z',
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

describe('LEGACY_DAYDIR_WITH_LOCATION_RE', () => {
  test('matches the old <year>/<location>/<MM-DD> layout', () => {
    expect(LEGACY_DAYDIR_WITH_LOCATION_RE.test('2021/61st Street/01-05')).toBe(true);
  });

  test('does not match the already-flattened <year>/<location> layout', () => {
    expect(LEGACY_DAYDIR_WITH_LOCATION_RE.test('2021/61st Street')).toBe(false);
  });

  test('does not match a bare top-level folder that merely looks like a date', () => {
    expect(LEGACY_DAYDIR_WITH_LOCATION_RE.test('01-05')).toBe(false);
  });

  test('does not match the separate no-location <year>/<MM>/<DD> shape', () => {
    expect(LEGACY_DAYDIR_WITH_LOCATION_RE.test('2021/01/05')).toBe(false);
  });
});

describe('LEGACY_DAYDIR_NO_LOCATION_RE', () => {
  test('matches the old <year>/<MM>/<DD> layout', () => {
    expect(LEGACY_DAYDIR_NO_LOCATION_RE.test('2021/01/05')).toBe(true);
  });

  test('does not match the already-flattened <year>/<MM> layout', () => {
    expect(LEGACY_DAYDIR_NO_LOCATION_RE.test('2021/01')).toBe(false);
  });

  test('does not match the with-location dash shape', () => {
    expect(LEGACY_DAYDIR_NO_LOCATION_RE.test('2021/61st Street/01-05')).toBe(false);
  });
});

describe('isLegacyDaydirPath', () => {
  test('true for either old day-dir shape', () => {
    expect(isLegacyDaydirPath('2021/61st Street/01-05')).toBe(true);
    expect(isLegacyDaydirPath('2021/01/05')).toBe(true);
  });

  test('false for the current (flattened) layouts', () => {
    expect(isLegacyDaydirPath('2021/61st Street')).toBe(false);
    expect(isLegacyDaydirPath('2021/Misc')).toBe(false);
    expect(isLegacyDaydirPath('2021/01')).toBe(false);
  });
});

describe('legacyDaydirCandidateFilter', () => {
  test('scopes the Mongo query to a live fileinfo entry matching either old day-dir shape', () => {
    const filter = legacyDaydirCandidateFilter() as {
      fileinfo: { $elemMatch: Record<string, unknown> };
      legacy_daydir_version: Record<string, unknown>;
    };
    const elemMatch = filter.fileinfo.$elemMatch;
    const patterns = (elemMatch.path as { $in: RegExp[] }).$in;
    const matchesAny = (p: string) => patterns.some((re) => re.test(p));
    expect(matchesAny('2021/61st Street/01-05')).toBe(true);
    expect(matchesAny('2021/01/05')).toBe(true);
    expect(matchesAny('2021/61st Street')).toBe(false);
    expect(matchesAny('2021/01')).toBe(false);
    expect(elemMatch.deleted_at).toEqual({ $in: [null] });
    expect(elemMatch.missing_since).toEqual({ $in: [null] });
  });

  test('excludes assets already stamped done, so a re-run does not re-select them', () => {
    const filter = legacyDaydirCandidateFilter() as {
      legacy_daydir_version: Record<string, unknown>;
    };
    expect(filter.legacy_daydir_version).toEqual({ $ne: LEGACY_DAYDIR_VERSION });
  });
});

describe('resolveLegacyCapturedYear', () => {
  test('prefers EXIF captured_year when present', () => {
    const year = resolveLegacyCapturedYear(
      { exif: { captured_year: 2021 } },
      'IMG_20170930_121056_345.jpg',
    );
    expect(year).toBe(2021);
  });

  test('falls back to the filename date when EXIF is absent', () => {
    const year = resolveLegacyCapturedYear({ exif: null }, 'IMG_20170930_121056_345.jpg');
    expect(year).toBe(2017);
  });

  test('returns null when EXIF is absent and the filename does not encode a date', () => {
    const year = resolveLegacyCapturedYear({ exif: null }, 'DSC_0001.jpg');
    expect(year).toBeNull();
  });
});

describe('computeCorrectedDir', () => {
  test('screenshot wins, using the filename-derived year', () => {
    const dir = computeCorrectedDir(
      { exif: null, is_screenshot: true, place: null },
      'IMG_20170930_121056_345.jpg',
    );
    expect(dir).toBe('2017/Screenshot');
  });

  test('resolved location, filename year overrides the stale path year', () => {
    const dir = computeCorrectedDir(
      {
        exif: null,
        place: place({
          address: { state: 'California', country: 'United States', country_code: 'us' },
          rollups: { locality: 'Emeryville', country_code: 'us' },
        }),
      },
      'IMG_20170930_121056_345.jpg',
    );
    expect(dir).toBe('2017/California/Emeryville');
  });

  test('no location falls back to <year>/Misc', () => {
    const dir = computeCorrectedDir({ exif: null, place: null }, 'IMG_20170930_121056_345.jpg');
    expect(dir).toBe('2017/Misc');
  });

  test('EXIF year takes priority over a disagreeing filename date', () => {
    const dir = computeCorrectedDir(
      { exif: { captured_year: 2021 }, place: null },
      'IMG_20170930_121056_345.jpg',
    );
    expect(dir).toBe('2021/Misc');
  });

  test('returns null when the year cannot be resolved at all', () => {
    const dir = computeCorrectedDir({ exif: null, place: null }, 'DSC_0001.jpg');
    expect(dir).toBeNull();
  });
});
