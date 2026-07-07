// Pure-function tests for the client-side Year -> Month -> folder folding
// logic that replaces the /api/search/buckets aggregation. See
// docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md.

import { describe, it, expect } from 'vitest';
import { SearchResult } from '../../api/search.service';
import {
  buildGroups,
  countInMonth,
  foldPage,
  folderNameFor,
  monthKey,
} from './timeline-view.utils';

function makeResult(id: string, absPath: string, capturedAt: string | null): SearchResult {
  return {
    id,
    _id: id,
    folder_id: 'f1',
    abs_path: absPath,
    filename: absPath.split('/').pop()!,
    size: 100,
    mtime: 0,
    captured_at: capturedAt,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focal_length: null,
    rating: 0,
    flag: 0,
    color_label: '',
  };
}

describe('folderNameFor', () => {
  it('returns "." for a photo directly in the scoped folder', () => {
    expect(folderNameFor('/Lib/2026/photo.dng', '/Lib/2026/')).toBe('.');
  });

  it('returns the immediate subfolder name for a nested photo', () => {
    expect(folderNameFor('/Lib/2026/vacation/photo.dng', '/Lib/2026/')).toBe('vacation');
  });

  it('falls back to the first path segment when the prefix does not match', () => {
    expect(folderNameFor('/Other/photo.dng', '/Lib/2026/')).toBe('Other');
  });
});

describe('foldPage', () => {
  it('opens a new year and month group on the first page', () => {
    const r = makeResult('a', '/Lib/2026/photo.dng', '2026-05-10T00:00:00.000Z');
    const years = foldPage([], [r], '/Lib/', new Map());
    expect(years).toHaveLength(1);
    expect(years[0]!.year).toBe(2026);
    expect(years[0]!.months).toHaveLength(1);
    expect(years[0]!.months[0]!.month).toBe(5);
    expect(countInMonth(years[0]!.months[0]!)).toBe(1);
  });

  it('extends the trailing month when the next result continues it', () => {
    const r1 = makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z');
    const r2 = makeResult('b', '/Lib/2026/b.dng', '2026-05-05T00:00:00.000Z');
    const years = foldPage([], [r1, r2], '/Lib/', new Map());
    expect(years).toHaveLength(1);
    expect(years[0]!.months).toHaveLength(1);
    expect(countInMonth(years[0]!.months[0]!)).toBe(2);
  });

  it('opens a new month group when a page spans a month boundary', () => {
    const r1 = makeResult('a', '/Lib/2026/a.dng', '2026-05-01T00:00:00.000Z');
    const r2 = makeResult('b', '/Lib/2026/b.dng', '2026-04-30T00:00:00.000Z');
    const years = foldPage([], [r1, r2], '/Lib/', new Map());
    expect(years).toHaveLength(1);
    expect(years[0]!.months.map((m) => m.month)).toEqual([5, 4]);
  });

  it('opens a new year group when a page spans a year boundary', () => {
    const r1 = makeResult('a', '/Lib/2026/a.dng', '2026-01-05T00:00:00.000Z');
    const r2 = makeResult('b', '/Lib/2025/b.dng', '2025-12-20T00:00:00.000Z');
    const years = foldPage([], [r1, r2], '/Lib/', new Map());
    expect(years.map((y) => y.year)).toEqual([2026, 2025]);
  });

  it('extends an already-accumulated structure across two fold calls (page 0 then page 1)', () => {
    const page0 = [makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z')];
    const page1 = [makeResult('b', '/Lib/2026/b.dng', '2026-05-01T00:00:00.000Z')];
    const afterPage0 = foldPage([], page0, '/Lib/', new Map());
    const afterPage1 = foldPage(afterPage0, page1, '/Lib/', new Map());
    expect(afterPage1).toHaveLength(1);
    expect(countInMonth(afterPage1[0]!.months[0]!)).toBe(2);
  });

  it('does not mutate a snapshot taken from a prior fold', () => {
    const page0 = [makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z')];
    const afterPage0 = foldPage([], page0, '/Lib/2026/', new Map());
    const snapshotMonth = afterPage0[0]!.months[0]!;
    const page1 = [makeResult('b', '/Lib/2026/b.dng', '2026-05-01T00:00:00.000Z')];
    foldPage(afterPage0, page1, '/Lib/2026/', new Map());
    expect(snapshotMonth.groups.get('.')).toHaveLength(1);
  });

  it('skips a result with no captured_at', () => {
    const r = makeResult('a', '/Lib/2026/a.dng', null);
    const years = foldPage([], [r], '/Lib/', new Map());
    expect(years).toHaveLength(0);
  });

  it('seeds thumbUrl from the thumb cache when present', () => {
    // Prefix reaches all the way to the scoped folder itself, so the photo
    // is directly in scope (bucket '.') rather than under a subfolder —
    // keep this prefix in sync with the photo's own parent directory, or
    // the assertion below targets the wrong folder-group key.
    const r = makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z');
    const cache = new Map([['/Lib/2026/a.dng', 'blob:cached']]);
    const years = foldPage([], [r], '/Lib/2026/', cache);
    expect(years[0]!.months[0]!.groups.get('.')![0]!.thumbUrl).toBe('blob:cached');
  });

  it('leaves thumbUrl null when the thumb cache has no entry', () => {
    const r = makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z');
    const years = foldPage([], [r], '/Lib/2026/', new Map());
    expect(years[0]!.months[0]!.groups.get('.')![0]!.thumbUrl).toBeNull();
  });

  it('groups by the real folder name even when it looks like a year that does not match the photo', () => {
    // Regression test: folderNameFor must use the literal scope prefix,
    // never a synthetic prefix derived from the photo's own capture year.
    const r = makeResult('a', '/Lib/2019-trip/photo.dng', '2026-05-10T00:00:00.000Z');
    const years = foldPage([], [r], '/Lib/', new Map());
    expect(years[0]!.months[0]!.groups.has('2019-trip')).toBe(true);
  });
});

describe('buildGroups', () => {
  it('sorts folder groups by most-recent photo descending', () => {
    const older = makeResult('a', '/Lib/2026/old-folder/a.dng', '2026-05-01T00:00:00.000Z');
    const newer = makeResult('b', '/Lib/2026/new-folder/b.dng', '2026-05-15T00:00:00.000Z');
    const years = foldPage([], [newer, older], '/Lib/2026/', new Map());
    const groups = buildGroups(years[0]!.months[0]!);
    expect(groups.map((g) => g.folderName)).toEqual(['new-folder', 'old-folder']);
  });
});

describe('monthKey', () => {
  it('formats a stable, unique key per year/month', () => {
    expect(monthKey(2026, 5)).toBe('2026-5');
    expect(monthKey(2026, 5)).not.toBe(monthKey(2025, 5));
  });
});
