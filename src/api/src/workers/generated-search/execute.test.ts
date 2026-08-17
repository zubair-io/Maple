/**
 * Pure unit tests for `toSearchQuery` — the single place a stored generated
 * query becomes a live `/api/search` query.
 *
 * Both the worker (measuring a proposal) and the read API (serving the
 * widget and the TV shelf) go through this, so the server-forced constraints
 * cannot drift between "what the count said" and "what the widget shows".
 *
 * The forcing is applied at EXECUTION time, not stamped at generation time.
 * That distinction is the whole point: a doc written by an earlier version of
 * the worker, or hand-edited in Mongo, still cannot surface a soft-hidden
 * person on an unattended living-room screen.
 */

import { describe, it, expect } from 'bun:test';
import { toSearchQuery } from './execute.ts';
import { buildFilter } from '../../routes/search/query.ts';

const LIB = '507f1f77bcf86cd799439011';
const HIDDEN = '651f1e4a2b3c4d5e6f708192';

describe('toSearchQuery — forced constraints', () => {
  it('forces excludeHiddenPeople on even when the stored doc says otherwise', () => {
    const query = toSearchQuery(
      { placeQuery: 'beach', excludeHiddenPeople: 'false' } as never,
      LIB,
    );
    expect(query.excludeHiddenPeople).toBe('true');
  });

  it('forces excludeHiddenPeople on when the stored doc omits it entirely', () => {
    expect(toSearchQuery({ placeQuery: 'beach' }, LIB).excludeHiddenPeople).toBe('true');
  });

  it('excludes screenshots', () => {
    // Ambient surfaces show these unattended; a screenshot in a themed
    // collection is always wrong.
    expect(toSearchQuery({ placeQuery: 'beach' }, LIB).isScreenshot).toBe('false');
  });

  it('uses the caller-supplied library, never one from stored data', () => {
    const query = toSearchQuery(
      { placeQuery: 'beach', libraryId: 'attacker-supplied' } as never,
      LIB,
    );
    expect(query.libraryId).toBe(LIB);
  });

  it('does not let stored data reintroduce a rating floor', () => {
    // `rating` filters $gte, so a stray value would silently drop every
    // unrated photo. It is not in the model's surface, but stored docs are
    // the other way junk can arrive.
    const query = toSearchQuery({ placeQuery: 'beach', rating: '1' } as never, LIB);
    expect((query as Record<string, unknown>).rating).toBeUndefined();
  });
});

describe('toSearchQuery — passthrough', () => {
  it('carries every model-settable field through unchanged', () => {
    const query = toSearchQuery(
      {
        placeQuery: 'children on a beach',
        from: '2016-01-01',
        to: '2020-12-31',
        month: '8',
        people: 'Zoe,Greyson',
        sceneType: 'outdoor',
      },
      LIB,
    );

    expect(query.placeQuery).toBe('children on a beach');
    expect(query.from).toBe('2016-01-01');
    expect(query.to).toBe('2020-12-31');
    expect(query.month).toBe('8');
    expect(query.people).toBe('Zoe,Greyson');
    expect(query.sceneType).toBe('outdoor');
  });
});

describe('toSearchQuery — composed with buildFilter', () => {
  it('produces a filter that excludes assets showing a hidden person', () => {
    // The end-to-end guarantee, asserted against the real buildFilter rather
    // than trusting that the flag alone is enough.
    const query = toSearchQuery({ placeQuery: 'beach' }, LIB);
    const filter = buildFilter(query, [HIDDEN]) as Record<string, unknown>;

    expect(filter.faces).toEqual({
      $not: { $elemMatch: { person_id: { $in: [HIDDEN] } } },
    });
    expect(filter.hidden).toEqual({ $ne: true });
  });

  it('produces a month filter that survives into the Mongo query', () => {
    const filter = buildFilter(toSearchQuery({ month: '8' }, LIB), []) as Record<string, unknown>;
    expect(filter['exif.captured_month']).toBe(8);
  });
});
