import { describe, it, expect } from 'bun:test';
import {
  parsePlaceLabels,
  peopleNames,
  placeLabelClause,
  SEARCHABLE_COLOR_LABELS,
} from './query.ts';
import { COLOR_LABELS as XMP_COLOR_LABELS } from '../../xmp/color-label.ts';

/**
 * #1657: the XMP/batch writers and the search `color` filter must agree on
 * the color-label vocabulary — a label the writers can persist that the
 * search filter rejects (or vice versa) silently orphans data. This is the
 * invariant that rotted (`orange` was writable but unfilterable; `purple`
 * was filterable but unreachable from the writers).
 *
 * `SEARCHABLE_COLOR_LABELS` is the whole gate: `buildSearchWhere` rejects any
 * `color` outside it with `Invalid color: <value>`, so membership here is
 * exactly "the search filter accepts this label".
 */
describe('search color filter — vocabulary parity with the XMP writers (#1657)', () => {
  it('SEARCHABLE_COLOR_LABELS (plus the empty/no-label sentinel) is a superset of every XMP-writable color', () => {
    for (const color of XMP_COLOR_LABELS) {
      expect(SEARCHABLE_COLOR_LABELS.has(color)).toBe(true);
    }
  });

  it.each(['orange', 'purple'] as const)(
    'color=%s is filterable (regression coverage for #1657)',
    (color) => {
      expect(SEARCHABLE_COLOR_LABELS.has(color)).toBe(true);
    },
  );

  it('does not admit a color outside the six-color vocabulary', () => {
    expect(SEARCHABLE_COLOR_LABELS.has('magenta')).toBe(false);
  });
});

/**
 * #2864 — the unified-search structured filters. `place` labels round-trip
 * through the exact inverse of the facets endpoint's `placeLabel` rule, and
 * the `people` param carries names the caller resolves to person ids before
 * any query is built. These cover the wire-side parsing only; how the
 * resulting labels and ids become SQL is `search.where.test.ts`.
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
});

describe('peopleNames — wire parsing (#2864)', () => {
  it('splits on commas, trims, drops blanks', () => {
    expect(peopleNames('Priya Patel, Alex Chen ,')).toEqual(['Priya Patel', 'Alex Chen']);
    expect(peopleNames(undefined)).toEqual([]);
    expect(peopleNames('   ')).toEqual([]);
  });
});
