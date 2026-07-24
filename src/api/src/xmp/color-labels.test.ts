/**
 * Drift guard for the color-label vocabulary (#1657).
 *
 * Before this ticket, `metadata-parser.ts`, `metadata-snapshots.ts`, and
 * `routes/search/query.ts` each hard-coded their own literal color set, and
 * two of the three sets disagreed (batch/XMP had `orange` but not `purple`;
 * search had `purple` but not `orange`). Now every module imports
 * `COLOR_LABELS` from this file instead of hard-coding its own list, so a
 * future edit that re-introduces a local literal set (or edits one without
 * the others) is what this test is meant to catch.
 */
import { describe, it, expect } from 'bun:test';
import { COLOR_LABELS, isColorLabel } from './color-labels.ts';
import { SEARCH_COLOR_LABELS } from '../routes/search/query.ts';

describe('color-label vocabulary drift guard (#1657)', () => {
  it('is exactly the six-value union agreed in #1657', () => {
    const sorted: string[] = [...COLOR_LABELS].sort();
    expect(sorted).toEqual(['blue', 'green', 'orange', 'purple', 'red', 'yellow']);
  });

  it("search's COLOR_LABELS set is canonical ∪ {''} — same source, no drift", () => {
    expect(SEARCH_COLOR_LABELS).toEqual(new Set(['', ...COLOR_LABELS]));
  });

  it('isColorLabel accepts every canonical value and rejects anything else', () => {
    for (const label of COLOR_LABELS) {
      expect(isColorLabel(label)).toBe(true);
    }
    expect(isColorLabel('magenta')).toBe(false);
    expect(isColorLabel('')).toBe(false);
    expect(isColorLabel('Red')).toBe(false);
  });
});
