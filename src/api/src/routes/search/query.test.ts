import { describe, it, expect } from 'bun:test';
import {
  applyLiveFilter,
  buildFilter,
  parsePlaceLabels,
  peopleNames,
  placeLabelClause,
  SEARCHABLE_COLOR_LABELS,
} from './query.ts';
import { COLOR_LABELS as XMP_COLOR_LABELS } from '../../xmp/color-label.ts';

/**
 * Search visibility requires a *resolvable* primary location: at least one
 * fileinfo entry that is neither `deleted_at` nor `missing_since`. A
 * `missing_since`-only asset has no primary the projection can resolve
 * (`assetPrimaryFileInfo` → null), so `projectAsset` emits `id: "fs:"` with an
 * empty `abs_path`/`filename`/`folder_id` — a blank tile that renders no
 * thumbnail (the FE builds `/api/fs/thumb?path=` from the empty path) and opens
 * nothing on click (the editor id is empty). Gating search on the same liveness
 * predicate the projection uses keeps those rows out of results until the
 * missing-reaper re-stats the file (clearing the tag on a present file, or
 * hard-deleting a genuinely-gone one). These assert the shape of the fileinfo
 * `$elemMatch` in both the plain and `$text` code paths.
 */
describe('applyLiveFilter — search hides assets with no resolvable primary', () => {
  it('gates on BOTH deleted_at and missing_since (plain filter)', () => {
    const clause = applyLiveFilter({}) as unknown as { $and: Array<Record<string, unknown>> };
    const live = clause.$and.find((c) => c.fileinfo) as
      | { fileinfo: { $elemMatch: Record<string, unknown> } }
      | undefined;
    expect(live).toBeDefined();
    const elem = live!.fileinfo.$elemMatch;
    expect(elem.deleted_at).toEqual({ $in: [null] });
    expect(elem.missing_since).toEqual({ $in: [null] });
  });

  it('gates on BOTH deleted_at and missing_since (in the $text branch)', () => {
    const clause = applyLiveFilter({ $text: { $search: 'lake' } } as never) as unknown as {
      $and: Array<Record<string, unknown>>;
    };
    const live = clause.$and.find((c) => c.fileinfo) as
      | { fileinfo: { $elemMatch: Record<string, unknown> } }
      | undefined;
    expect(live).toBeDefined();
    const elem = live!.fileinfo.$elemMatch;
    expect(elem.deleted_at).toEqual({ $in: [null] });
    expect(elem.missing_since).toEqual({ $in: [null] });
  });
});

/**
 * #1657: the XMP/batch writers and the search `color` filter must agree on
 * the color-label vocabulary — a label the writers can persist that the
 * search filter rejects (or vice versa) silently orphans data. This is the
 * invariant that rotted (`orange` was writable but unfilterable; `purple`
 * was filterable but unreachable from the writers).
 */
describe('search color filter — vocabulary parity with the XMP writers (#1657)', () => {
  it('SEARCHABLE_COLOR_LABELS (plus the empty/no-label sentinel) is a superset of every XMP-writable color', () => {
    for (const color of XMP_COLOR_LABELS) {
      expect(SEARCHABLE_COLOR_LABELS.has(color)).toBe(true);
    }
  });

  it('every XMP-writable color, and only those colors, passes buildFilter({ color })', () => {
    for (const color of XMP_COLOR_LABELS) {
      const result = buildFilter({ color });
      expect('error' in result).toBe(false);
      expect((result as { color_label?: string }).color_label).toBe(color);
    }
  });

  it.each(['orange', 'purple'] as const)(
    'color=%s is filterable (regression coverage for #1657)',
    (color) => {
      const result = buildFilter({ color });
      expect('error' in result).toBe(false);
      expect((result as { color_label?: string }).color_label).toBe(color);
    },
  );

  it('rejects a color outside the six-color vocabulary', () => {
    const result = buildFilter({ color: 'magenta' });
    expect(result).toEqual({ error: 'Invalid color: magenta' });
  });
});

/**
 * #2864 — the unified-search structured filters. `place` labels round-trip
 * through the exact inverse of the facets endpoint's `placeLabel` rule, and
 * the `people` clause consumes caller-resolved person ids (names never reach
 * `buildFilter`). Both are OR within the field, AND against other filters.
 */
describe('place filter — label parsing and clause shape (#2864)', () => {
  it('splits the wire param on | and trims blanks', () => {
    expect(parsePlaceLabels('Portland, OR|Kyoto, Japan')).toEqual(['Portland, OR', 'Kyoto, Japan']);
    expect(parsePlaceLabels(' Portland, OR | ')).toEqual(['Portland, OR']);
    expect(parsePlaceLabels(undefined)).toEqual([]);
    expect(parsePlaceLabels('  ')).toEqual([]);
  });

  it('parses "locality, region" back into the rollup tuple on the LAST comma', () => {
    expect(placeLabelClause('Portland, OR')).toEqual({
      'place.rollups.locality': 'Portland',
      'place.rollups.region': 'OR',
    });
    // A locality that itself contains ", " keeps everything before the last
    // separator — the label was built by joining exactly one ", ".
    expect(placeLabelClause('San Miguel, de Allende, GTO')).toEqual({
      'place.rollups.locality': 'San Miguel, de Allende',
      'place.rollups.region': 'GTO',
    });
  });

  it('matches a bare label against either half of the tuple, other half blank (null OR "")', () => {
    const blank = { $in: [null, ''] };
    expect(placeLabelClause('Portland')).toEqual({
      $or: [
        { 'place.rollups.locality': 'Portland', 'place.rollups.region': blank },
        { 'place.rollups.locality': blank, 'place.rollups.region': 'Portland' },
      ],
    });
  });

  it('one selected place becomes a top-level $or group', () => {
    const f = buildFilter({ place: 'Portland, OR' }) as Record<string, unknown>;
    expect(f.$or).toEqual([{ 'place.rollups.locality': 'Portland', 'place.rollups.region': 'OR' }]);
  });

  it('multiple places OR together; a free-text q demotes both groups into $and', () => {
    const f = buildFilter({ q: 'DJI', place: 'Portland, OR|Kyoto' }) as {
      $and?: Array<Record<string, unknown>>;
      $or?: unknown;
    };
    expect(f.$or).toBeUndefined();
    expect(f.$and).toHaveLength(2);
    const placeGroup = f.$and!.find((c) =>
      JSON.stringify(c).includes('place.rollups.locality'),
    ) as { $or: unknown[] };
    expect(placeGroup.$or).toHaveLength(2);
  });
});

describe('people filter — resolved-id clause (#2864)', () => {
  it('null (no people requested) adds no faces clause', () => {
    const f = buildFilter({}, [], null) as Record<string, unknown>;
    expect(f.faces).toBeUndefined();
  });

  it('resolved ids match any face assigned to any selected person', () => {
    const f = buildFilter({}, [], ['aaa', 'bbb']) as Record<string, unknown>;
    expect(f.faces).toEqual({ $elemMatch: { person_id: { $in: ['aaa', 'bbb'] } } });
  });

  it('names that resolved to no live person match NOTHING (empty $in), not everything', () => {
    const f = buildFilter({}, [], []) as Record<string, unknown>;
    expect(f.faces).toEqual({ $elemMatch: { person_id: { $in: [] } } });
  });

  it('composes with excludeHiddenPeople on the same field path instead of being clobbered', () => {
    const f = buildFilter({ excludeHiddenPeople: 'true' }, ['hidden1'], ['aaa']) as Record<
      string,
      unknown
    >;
    expect(f.faces).toEqual({
      $elemMatch: { person_id: { $in: ['aaa'] } },
      $not: { $elemMatch: { person_id: { $in: ['hidden1'] } } },
    });
  });
});

describe('peopleNames — wire parsing (#2864)', () => {
  it('splits on commas, trims, drops blanks', () => {
    expect(peopleNames('Priya Patel, Alex Chen ,')).toEqual(['Priya Patel', 'Alex Chen']);
    expect(peopleNames(undefined)).toEqual([]);
    expect(peopleNames('   ')).toEqual([]);
  });
});
