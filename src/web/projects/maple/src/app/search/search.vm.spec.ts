// Tests for the pure VM module behind `search.component.ts`.
//
// Lives next to the component per the `*.vm.ts` co-location pattern
// (#190, slice 4). These tests pull plain functions, build minimal
// fixtures, and assert behaviour without spinning up TestBed — that's
// the whole point of the split.

import { describe, it, expect } from 'vitest';
import type { SearchFacets, SearchResult } from '@maple-common';
import {
  COLOR_LABELS,
  HIDDEN_OPTIONS,
  PAGE_SIZE,
  SCENE_TYPE_OPTIONS,
  SORT_LABEL,
  SORT_OPTIONS,
  buildSearchParams,
  cameraLabel,
  hasActiveFilters,
  numOrEmpty,
  numString,
  parseColor,
  parseCsvSet,
  parseFlag,
  parseHidden,
  parseRating,
  parseSceneType,
  parseScreenshot,
  parseSort,
  presetDateRange,
  sceneTypeCount,
  sortLabel,
  toResultViewModel,
  toggleCsv,
} from './search.vm';

// ── Fixture helpers ───────────────────────────────────────────────────────

/** Minimal `ParamMap`-shaped reader for `hasActiveFilters`. */
function reader(record: Record<string, string>) {
  return {
    keys: Object.keys(record),
    get(key: string): string | null {
      return key in record ? record[key] : null;
    },
  };
}

// ── Constants ─────────────────────────────────────────────────────────────

describe('constants', () => {
  it('PAGE_SIZE is 100 — matches the server default page', () => {
    expect(PAGE_SIZE).toBe(100);
  });

  it('SORT_LABEL covers every SearchSort key', () => {
    expect(Object.keys(SORT_LABEL).sort()).toEqual(
      ['captured_asc', 'captured_desc', 'name', 'rating'].sort(),
    );
  });

  it('SORT_OPTIONS is derived from SORT_LABEL', () => {
    expect(SORT_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(SORT_LABEL).sort());
    for (const o of SORT_OPTIONS) {
      expect(o.label).toBe(SORT_LABEL[o.value]);
    }
  });

  it('SCENE_TYPE_OPTIONS leads with the empty/Any option', () => {
    expect(SCENE_TYPE_OPTIONS[0]).toEqual({ value: '', label: 'Any' });
  });

  it('COLOR_LABELS leads with the empty/Any option and a transparent swatch', () => {
    expect(COLOR_LABELS[0]).toEqual({ value: '', label: 'Any', swatch: 'transparent' });
  });

  it('COLOR_LABELS covers the full six-color vocabulary, including orange (#1657)', () => {
    expect(COLOR_LABELS.map((o) => o.value)).toEqual([
      '',
      'red',
      'orange',
      'yellow',
      'green',
      'blue',
      'purple',
    ]);
  });

  it('HIDDEN_OPTIONS leads with the default "hide hidden" option', () => {
    expect(HIDDEN_OPTIONS[0]).toEqual({ value: '', label: 'Hide hidden' });
    expect(HIDDEN_OPTIONS.map((o) => o.value)).toEqual(['', 'all', 'only']);
  });
});

// ── numOrEmpty / numString ────────────────────────────────────────────────

describe('numOrEmpty', () => {
  it('returns null for empty / nullish input', () => {
    expect(numOrEmpty('')).toBeNull();
    expect(numOrEmpty(null)).toBeNull();
    expect(numOrEmpty(undefined)).toBeNull();
  });

  it('parses finite numbers', () => {
    expect(numOrEmpty('100')).toBe(100);
    expect(numOrEmpty('1.5')).toBe(1.5);
    expect(numOrEmpty('-1')).toBe(-1);
    expect(numOrEmpty('0')).toBe(0);
  });

  it('returns null for non-finite strings', () => {
    expect(numOrEmpty('NaN')).toBeNull();
    expect(numOrEmpty('Infinity')).toBeNull();
    expect(numOrEmpty('abc')).toBeNull();
  });
});

describe('numString', () => {
  function ev(value: string): Event {
    return { target: { value } } as unknown as Event;
  }

  it('returns empty for an empty input', () => {
    expect(numString(ev(''))).toBe('');
  });

  it('returns the canonical numeric string for valid input', () => {
    expect(numString(ev('100'))).toBe('100');
    expect(numString(ev('1.50'))).toBe('1.5');
  });

  it('returns empty when the input is non-finite', () => {
    expect(numString(ev('abc'))).toBe('');
  });
});

// ── Enum coercion ─────────────────────────────────────────────────────────

describe('parseFlag', () => {
  it('accepts only the three real flag values', () => {
    expect(parseFlag('pick')).toBe('pick');
    expect(parseFlag('reject')).toBe('reject');
    expect(parseFlag('none')).toBe('none');
  });

  it('falls back to "" for anything else', () => {
    expect(parseFlag(null)).toBe('');
    expect(parseFlag(undefined)).toBe('');
    expect(parseFlag('')).toBe('');
    expect(parseFlag('garbage')).toBe('');
  });
});

describe('parseColor', () => {
  it('accepts only the six real color values', () => {
    for (const c of ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const) {
      expect(parseColor(c)).toBe(c);
    }
  });

  it('falls back to "" for anything else', () => {
    expect(parseColor(null)).toBe('');
    expect(parseColor('Red')).toBe('');
    expect(parseColor('magenta')).toBe('');
  });
});

describe('parseScreenshot', () => {
  it('accepts the two string-boolean literals', () => {
    expect(parseScreenshot('true')).toBe('true');
    expect(parseScreenshot('false')).toBe('false');
  });

  it('falls back to "" for anything else', () => {
    expect(parseScreenshot(null)).toBe('');
    expect(parseScreenshot('TRUE')).toBe('');
    expect(parseScreenshot('1')).toBe('');
  });
});

describe('parseHidden', () => {
  it('accepts the two non-default literals', () => {
    expect(parseHidden('all')).toBe('all');
    expect(parseHidden('only')).toBe('only');
  });

  it('falls back to "" (hide hidden, the default) for anything else', () => {
    expect(parseHidden(null)).toBe('');
    expect(parseHidden(undefined)).toBe('');
    expect(parseHidden('')).toBe('');
    expect(parseHidden('ALL')).toBe('');
    expect(parseHidden('garbage')).toBe('');
  });
});

describe('parseSort', () => {
  it('accepts every SearchSort key', () => {
    expect(parseSort('captured_desc')).toBe('captured_desc');
    expect(parseSort('captured_asc')).toBe('captured_asc');
    expect(parseSort('name')).toBe('name');
    expect(parseSort('rating')).toBe('rating');
  });

  it('falls back to captured_desc — the default newest-first view', () => {
    expect(parseSort(null)).toBe('captured_desc');
    expect(parseSort(undefined)).toBe('captured_desc');
    expect(parseSort('')).toBe('captured_desc');
    expect(parseSort('garbage')).toBe('captured_desc');
  });
});

describe('parseSceneType', () => {
  it('accepts every defined scene type', () => {
    for (const s of ['indoor', 'outdoor', 'aerial', 'macro', 'studio', 'mixed'] as const) {
      expect(parseSceneType(s)).toBe(s);
    }
  });

  it('falls back to "" for anything else', () => {
    expect(parseSceneType(null)).toBe('');
    expect(parseSceneType('Indoor')).toBe('');
    expect(parseSceneType('night')).toBe('');
  });
});

describe('parseRating', () => {
  it('parses numeric input', () => {
    expect(parseRating('3')).toBe(3);
    expect(parseRating('5')).toBe(5);
  });

  it('falls back to 0 for nullish / invalid input', () => {
    expect(parseRating(null)).toBe(0);
    expect(parseRating(undefined)).toBe(0);
    expect(parseRating('')).toBe(0);
    // 'abc' → Number('abc') is NaN; isFinite(NaN) false → 0
    expect(parseRating('abc')).toBe(0);
  });
});

// ── CSV set plumbing ──────────────────────────────────────────────────────

describe('parseCsvSet', () => {
  it('returns an empty set for nullish / empty input', () => {
    expect(parseCsvSet('').size).toBe(0);
    expect(parseCsvSet(null).size).toBe(0);
    expect(parseCsvSet(undefined).size).toBe(0);
  });

  it('splits, trims, and drops empty tokens', () => {
    const set = parseCsvSet(' a , b ,, c ');
    expect([...set].sort()).toEqual(['a', 'b', 'c']);
  });

  it('lowercases when opts.lower is true', () => {
    const set = parseCsvSet('DNG,Cr3,Arw', { lower: true });
    expect([...set].sort()).toEqual(['arw', 'cr3', 'dng']);
  });

  it('preserves case by default (used for subject names)', () => {
    const set = parseCsvSet('Cat,Dog,Bird');
    expect([...set].sort()).toEqual(['Bird', 'Cat', 'Dog']);
  });
});

describe('toggleCsv', () => {
  it('adds a value when absent', () => {
    expect(toggleCsv('', 'dng')).toBe('dng');
    expect(toggleCsv('arw', 'dng')).toBe('arw,dng');
  });

  it('removes a value when present', () => {
    expect(toggleCsv('arw,dng', 'arw')).toBe('dng');
    expect(toggleCsv('dng', 'dng')).toBe('');
  });

  it('returns a sorted CSV so the URL is stable across toggle order', () => {
    const a = toggleCsv(toggleCsv('', 'b'), 'a');
    const b = toggleCsv(toggleCsv('', 'a'), 'b');
    expect(a).toBe(b);
    expect(a).toBe('a,b');
  });

  it('treats nullish input as an empty set', () => {
    expect(toggleCsv(null, 'dng')).toBe('dng');
    expect(toggleCsv(undefined, 'dng')).toBe('dng');
  });
});

// ── hasActiveFilters ──────────────────────────────────────────────────────

describe('hasActiveFilters', () => {
  it('returns false for null / empty readers', () => {
    expect(hasActiveFilters(null)).toBe(false);
    expect(hasActiveFilters(undefined)).toBe(false);
    expect(hasActiveFilters(reader({}))).toBe(false);
  });

  it('ignores q / sort / page / limit', () => {
    expect(hasActiveFilters(reader({ q: 'hello' }))).toBe(false);
    expect(hasActiveFilters(reader({ sort: 'name' }))).toBe(false);
    expect(hasActiveFilters(reader({ page: '2' }))).toBe(false);
    expect(hasActiveFilters(reader({ limit: '100' }))).toBe(false);
  });

  it('returns true when any structured filter is set', () => {
    expect(hasActiveFilters(reader({ camera: 'Sony' }))).toBe(true);
    expect(hasActiveFilters(reader({ rating: '3' }))).toBe(true);
    expect(hasActiveFilters(reader({ q: 'x', color: 'red' }))).toBe(true);
  });

  it('ignores empty-string filter values', () => {
    expect(hasActiveFilters(reader({ camera: '' }))).toBe(false);
  });
});

// ── buildSearchParams ─────────────────────────────────────────────────────

describe('buildSearchParams', () => {
  function emptyState() {
    return {
      q: '',
      libraryId: '',
      camera: '',
      lens: '',
      isoMin: null,
      isoMax: null,
      apertureMin: null,
      apertureMax: null,
      focalMin: null,
      focalMax: null,
      from: '',
      to: '',
      rating: 0,
      flag: '' as const,
      color: '' as const,
      extCsv: '',
      sceneType: '' as const,
      activity: '',
      subjects: new Set<string>(),
      isScreenshot: '' as const,
      hidden: '' as const,
      sort: 'captured_desc' as const,
    };
  }

  it('collapses every empty/nullish field to undefined except sort', () => {
    const p = buildSearchParams(emptyState());
    expect(p.placeQuery).toBeUndefined();
    expect(p.libraryId).toBeUndefined();
    expect(p.camera).toBeUndefined();
    expect(p.isoMin).toBeUndefined();
    expect(p.rating).toBeUndefined();
    expect(p.flag).toBeUndefined();
    expect(p.color).toBeUndefined();
    expect(p.ext).toBeUndefined();
    expect(p.sceneType).toBeUndefined();
    expect(p.subjects).toBeUndefined();
    expect(p.isScreenshot).toBeUndefined();
    expect(p.sort).toBe('captured_desc');
  });

  it('threads non-empty fields through verbatim', () => {
    const p = buildSearchParams({
      ...emptyState(),
      q: 'sunset',
      camera: 'Sony',
      isoMin: 100,
      isoMax: 1600,
      rating: 4,
      flag: 'pick',
      color: 'red',
      extCsv: 'arw,dng',
      sceneType: 'outdoor',
      subjects: new Set(['Cat', 'Dog']),
      sort: 'rating',
    });
    expect(p.placeQuery).toBe('sunset');
    expect(p.camera).toBe('Sony');
    expect(p.isoMin).toBe(100);
    expect(p.isoMax).toBe(1600);
    expect(p.rating).toBe(4);
    expect(p.flag).toBe('pick');
    expect(p.color).toBe('red');
    expect(p.ext).toBe('arw,dng');
    expect(p.sceneType).toBe('outdoor');
    expect(p.subjects?.sort()).toEqual(['Cat', 'Dog']);
    expect(p.sort).toBe('rating');
  });

  it('collapses rating <= 0 to undefined', () => {
    expect(buildSearchParams({ ...emptyState(), rating: 0 }).rating).toBeUndefined();
    expect(buildSearchParams({ ...emptyState(), rating: -1 }).rating).toBeUndefined();
  });

  it('maps the tri-state screenshot filter to a boolean / undefined', () => {
    expect(buildSearchParams({ ...emptyState(), isScreenshot: 'true' }).isScreenshot).toBe(true);
    expect(buildSearchParams({ ...emptyState(), isScreenshot: 'false' }).isScreenshot).toBe(false);
    expect(buildSearchParams({ ...emptyState(), isScreenshot: '' }).isScreenshot).toBeUndefined();
  });

  it('maps the tri-state hidden filter to the backend param / undefined', () => {
    expect(buildSearchParams({ ...emptyState(), hidden: 'all' }).hidden).toBe('all');
    expect(buildSearchParams({ ...emptyState(), hidden: 'only' }).hidden).toBe('only');
    expect(buildSearchParams({ ...emptyState(), hidden: '' }).hidden).toBeUndefined();
  });
});

// ── presetDateRange ───────────────────────────────────────────────────────

describe('presetDateRange', () => {
  it('last7 — exactly seven days back, "to" is today', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    expect(presetDateRange('last7', now)).toEqual({
      from: '2026-05-14',
      to: '2026-05-21',
    });
  });

  it('last30 — thirty days back', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    expect(presetDateRange('last30', now)).toEqual({
      from: '2026-04-21',
      to: '2026-05-21',
    });
  });

  it('thisYear — Jan 1 of the current year', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    expect(presetDateRange('thisYear', now)).toEqual({
      from: '2026-01-01',
      to: '2026-05-21',
    });
  });

  it('does not mutate the input Date', () => {
    const now = new Date('2026-05-21T12:00:00Z');
    const before = now.getTime();
    presetDateRange('last7', now);
    expect(now.getTime()).toBe(before);
  });
});

// ── Label helpers ─────────────────────────────────────────────────────────

describe('cameraLabel', () => {
  it('joins make and model with " · "', () => {
    expect(cameraLabel({ make: 'Sony', model: 'A7R V' })).toBe('Sony · A7R V');
  });

  it('drops the missing half', () => {
    expect(cameraLabel({ make: 'Sony', model: null })).toBe('Sony');
    expect(cameraLabel({ make: null, model: 'A7R V' })).toBe('A7R V');
  });

  it('falls back to "Unknown" when both are nullish', () => {
    expect(cameraLabel({ make: null, model: null })).toBe('Unknown');
  });
});

describe('sceneTypeCount', () => {
  const facets: SearchFacets = {
    cameras: [],
    lenses: [],
    extensions: [],
    scene_types: [
      { value: 'indoor', count: 12 },
      { value: 'outdoor', count: 7 },
    ],
    subjects: [],
    activities: [],
  } as unknown as SearchFacets;

  it('returns the bucket count for a present value', () => {
    expect(sceneTypeCount(facets, 'indoor')).toBe(12);
  });

  it('returns null for a missing bucket', () => {
    expect(sceneTypeCount(facets, 'mixed')).toBeNull();
  });

  it('returns null when facets is null / missing scene_types', () => {
    expect(sceneTypeCount(null, 'indoor')).toBeNull();
    expect(sceneTypeCount(undefined, 'indoor')).toBeNull();
    expect(sceneTypeCount({} as SearchFacets, 'indoor')).toBeNull();
  });
});

describe('sortLabel', () => {
  it('returns the human label for known sorts', () => {
    expect(sortLabel('captured_desc')).toBe('Newest first');
    expect(sortLabel('captured_asc')).toBe('Oldest first');
    expect(sortLabel('name')).toBe('Name');
    expect(sortLabel('rating')).toBe('Rating');
  });
});

// ── toResultViewModel ─────────────────────────────────────────────────────

describe('toResultViewModel', () => {
  function result(): SearchResult {
    return {
      id: 'fs:/a/b.dng',
      abs_path: '/a/b.dng',
      filename: 'b.dng',
      ext: 'dng',
      captured_at: '2026-01-01',
      camera: { make: 'Sony', model: 'A7R V' },
    } as unknown as SearchResult;
  }

  it('threads the cached blob URL into thumbUrl and marks loading false', () => {
    const vm = toResultViewModel(result(), 'blob:http://x/123');
    expect(vm.thumbUrl).toBe('blob:http://x/123');
    expect(vm.thumbLoading).toBe(false);
  });

  it('marks loading true when there is no cached URL', () => {
    const vm = toResultViewModel(result(), null);
    expect(vm.thumbUrl).toBeNull();
    expect(vm.thumbLoading).toBe(true);
  });

  it('does not drop fields from the source result', () => {
    const r = result();
    const vm = toResultViewModel(r, null);
    expect(vm.id).toBe(r.id);
    expect(vm.abs_path).toBe(r.abs_path);
    expect(vm.filename).toBe(r.filename);
  });
});
