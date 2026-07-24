import { describe, it, expect } from 'bun:test';
import { applyLiveFilter, buildFilter, SEARCH_COLOR_LABELS } from './query.ts';
import { COLOR_LABELS as CANONICAL_COLOR_LABELS } from '../../xmp/color-labels.ts';

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
 * #1657 — the color vocabulary was inconsistent: the batch/XMP path
 * recognised red|orange|yellow|green|blue (no purple) while search
 * recognised red|yellow|green|blue|purple (no orange). The canonical set is
 * the six-value union, single-sourced from `xmp/color-labels.ts`. These
 * assert `buildFilter`'s `q.color` validation accepts every canonical value
 * and rejects anything outside it.
 */
describe('buildFilter — color filter accepts the canonical six-value vocabulary (#1657)', () => {
  it('accepts every canonical color label', () => {
    for (const color of CANONICAL_COLOR_LABELS) {
      const result = buildFilter({ color });
      expect('error' in result).toBe(false);
      expect((result as Record<string, unknown>).color_label).toBe(color);
    }
  });

  it("accepts the empty string and filters for unlabeled assets (the indexer's '' default)", () => {
    const result = buildFilter({ color: '' });
    expect('error' in result).toBe(false);
    // `''` is a real predicate, not "no filter": it matches the empty-string
    // `color_label` the discover worker writes for never-labeled assets.
    expect((result as Record<string, unknown>).color_label).toBe('');
  });

  it('rejects a color outside the canonical set', () => {
    const result = buildFilter({ color: 'magenta' }) as { error: string };
    expect(result.error).toBe('Invalid color: magenta');
  });

  it('orange (batch/XMP-only historically) and purple (search-only historically) are both valid', () => {
    expect(SEARCH_COLOR_LABELS.has('orange')).toBe(true);
    expect(SEARCH_COLOR_LABELS.has('purple')).toBe(true);
  });
});
