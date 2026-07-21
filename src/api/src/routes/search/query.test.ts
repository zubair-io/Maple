import { describe, it, expect } from 'bun:test';
import { applyLiveFilter } from './query.ts';

/**
 * The live-visibility wrapper must let `missing_since`-tagged assets stay in
 * search results (thumb/preview are cached; the missing-reaper is the removal
 * authority) while still hiding user-deleted content. These assert the shape of
 * the fileinfo `$elemMatch` in both the plain and `$text` code paths.
 */
describe('applyLiveFilter — missing_since no longer hides assets', () => {
  it('gates on deleted_at but NOT missing_since (plain filter)', () => {
    const clause = applyLiveFilter({}) as unknown as { $and: Array<Record<string, unknown>> };
    const live = clause.$and.find((c) => c.fileinfo) as
      | { fileinfo: { $elemMatch: Record<string, unknown> } }
      | undefined;
    expect(live).toBeDefined();
    const elem = live!.fileinfo.$elemMatch;
    expect(elem.deleted_at).toEqual({ $in: [null] });
    expect('missing_since' in elem).toBe(false);
  });

  it('gates on deleted_at but NOT missing_since (in the $text branch)', () => {
    const clause = applyLiveFilter({ $text: { $search: 'lake' } } as never) as unknown as {
      $and: Array<Record<string, unknown>>;
    };
    const live = clause.$and.find((c) => c.fileinfo) as
      | { fileinfo: { $elemMatch: Record<string, unknown> } }
      | undefined;
    expect(live).toBeDefined();
    const elem = live!.fileinfo.$elemMatch;
    expect(elem.deleted_at).toEqual({ $in: [null] });
    expect('missing_since' in elem).toBe(false);
  });
});
