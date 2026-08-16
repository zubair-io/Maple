/**
 * Pure unit tests for `buildFilter`'s excluded-person handling (and the
 * always-on hidden-IMAGE default it complements). No Mongo — `buildFilter` is
 * deliberately pure, taking the person ids to drop as a parameter so the
 * async lookups stay in the route handlers. Since #2894 the OPT-IN decision
 * lives in the callers too: they always include `excludedPersonIds()` and add
 * `hiddenPersonIds()` only when the request carries `excludeHiddenPeople=true`;
 * `buildFilter` itself unconditionally applies whatever ids it is handed.
 * Mirrors the fixture-only pattern in `project.test.ts` / `nl-date.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { buildFilter, type SearchQuery } from './query.ts';

/** `buildFilter` returns a filter or an `{ error }`; unwrap for assertions. */
function filterFor(q: SearchQuery, hiddenIds: string[] = []): Record<string, unknown> {
  const result = buildFilter(q, hiddenIds);
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return result as Record<string, unknown>;
}

const HIDDEN_A = '651f1e4a2b3c4d5e6f708192';
const HIDDEN_B = '651f1e4a2b3c4d5e6f708193';

describe('buildFilter — hidden images (always on by default)', () => {
  it('excludes hidden images when the caller says nothing', () => {
    expect(filterFor({}).hidden).toEqual({ $ne: true });
  });

  it('returns only hidden images for hidden=only', () => {
    expect(filterFor({ hidden: 'only' }).hidden).toBe(true);
  });

  it('drops the hidden constraint entirely for hidden=all', () => {
    expect(filterFor({ hidden: 'all' }).hidden).toBeUndefined();
  });
});

describe('buildFilter — excluded-person ids (#2894: applied unconditionally)', () => {
  it('applies supplied ids regardless of any request flag — the caller owns the opt-in', () => {
    // Excluded people reach every route's id list unconditionally, so
    // `buildFilter` must not second-guess the flag.
    expect(filterFor({}, [HIDDEN_A]).faces).toEqual({
      $not: { $elemMatch: { person_id: { $in: [HIDDEN_A] } } },
    });
    expect(filterFor({ excludeHiddenPeople: 'false' }, [HIDDEN_A]).faces).toEqual({
      $not: { $elemMatch: { person_id: { $in: [HIDDEN_A] } } },
    });
  });

  it('adds no faces constraint when the id list is empty', () => {
    // Guards the wasted-`$not` case: an empty id list must not produce
    // `person_id: { $in: [] }`, which would match nothing and empty the feed.
    expect(filterFor({ excludeHiddenPeople: 'true' }, []).faces).toBeUndefined();
    expect(filterFor({}, []).faces).toBeUndefined();
  });

  it('excludes assets carrying a face of any listed person', () => {
    const filter = filterFor({ excludeHiddenPeople: 'true' }, [HIDDEN_A, HIDDEN_B]);
    expect(filter.faces).toEqual({
      $not: { $elemMatch: { person_id: { $in: [HIDDEN_A, HIDDEN_B] } } },
    });
  });

  it('ANDs with scope=people instead of overwriting its presence check', () => {
    // `scope=people` sets the dotted key `faces.0`; the exclusion sets the
    // top-level `faces`. Both must survive — losing either would silently
    // widen the People scope or drop the hidden-person exclusion.
    const filter = filterFor({ scope: 'people', excludeHiddenPeople: 'true' }, [HIDDEN_A]);
    expect(filter['faces.0']).toEqual({ $exists: true });
    expect(filter.faces).toEqual({
      $not: { $elemMatch: { person_id: { $in: [HIDDEN_A] } } },
    });
  });

  it('composes with the hidden-image default rather than replacing it', () => {
    const filter = filterFor({ excludeHiddenPeople: 'true' }, [HIDDEN_A]);
    expect(filter.hidden).toEqual({ $ne: true });
    expect(filter.faces).toBeDefined();
  });
});
