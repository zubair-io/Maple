/**
 * Pure unit tests for `toSearchQuery` — the single place a stored generated
 * query becomes a live `/api/search` query.
 *
 * Both the worker (measuring a proposal) and the read API (serving the
 * widget and the TV shelf) go through this, so the server-forced constraints
 * cannot drift between "what the count said" and "what the widget shows".
 *
 * The forcing is applied at EXECUTION time, not stamped at generation time.
 * That distinction is the whole point: a row written by an earlier version of
 * the worker, or edited straight in the database, still cannot surface a
 * soft-hidden person on an unattended living-room screen.
 */

import { describe, it, expect } from 'bun:test';
import { toSearchQuery } from './execute.ts';
import { buildSearchWhere } from '../../db/repos/search.where.ts';

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

/**
 * The end-to-end half: a forced query is only worth anything if the search
 * layer that runs it honours the forcing. These push `toSearchQuery`'s output
 * through the real where-builder — the same one `/api/search` uses — rather
 * than trusting that setting the flag is enough.
 */
describe('toSearchQuery — composed with the search where-builder', () => {
  it('produces a WHERE that excludes assets showing a hidden person', () => {
    const where = buildSearchWhere(toSearchQuery({ placeQuery: 'beach' }, LIB), [HIDDEN]);
    if ('error' in where) throw new Error(where.error);

    // The exclusion is a negated sub-query over `faces`; the person id it
    // binds is the hidden one the caller resolved.
    const excluded = where.clauses.find((clause) => clause.startsWith('NOT ('));
    expect(excluded).toBeDefined();
    expect(excluded).toContain('FROM faces f');
    expect(where.params).toContain(HIDDEN);

    // Hidden ASSETS are a separate, always-on filter — an ambient surface
    // must not show either kind.
    expect(where.clauses).toContain('assets.hidden = 0');
  });

  it('produces a month filter that survives into the query', () => {
    const where = buildSearchWhere(toSearchQuery({ month: '8' }, LIB));
    if ('error' in where) throw new Error(where.error);

    expect(where.clauses).toContain('assets.captured_month = ?');
    expect(where.params).toContain(8);
  });
});
