import { describe, it, expect } from 'bun:test';
import { applyLiveFilter, buildFilter, COLOR_LABELS } from './query.ts';
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
  it('COLOR_LABELS (plus the empty/no-label sentinel) is a superset of every XMP-writable color', () => {
    for (const color of XMP_COLOR_LABELS) {
      expect(COLOR_LABELS.has(color)).toBe(true);
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
