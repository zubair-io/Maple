/**
 * Pure unit tests for `validateProposal` — the gate between raw Ollama JSON
 * and a query the worker will actually execute.
 *
 * The model is grammar-constrained by a `format` schema, but that constraint
 * is best-effort: older Ollama versions ignore `format`, providers get
 * swapped, and a thinking model can route its output through a path that
 * bypasses the grammar (#2172). So this validator is the real boundary, not
 * a formality — the same defense-in-depth stance `parse-vision-json` takes
 * toward the describe stage's schema.
 *
 * Two rules here are security-shaped rather than correctness-shaped:
 * a person the model was never shown must never survive into a query
 * (soft-hidden people must not resurface on an ambient screen), and no
 * server-controlled key may be set by the model.
 *
 * No Mongo — mirrors `routes/search/hidden-people.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { validateProposal, type ValidationContext } from './validate.ts';

const CTX: ValidationContext = {
  allowedPeople: ['Zoe', 'Greyson', 'Jenn'],
  coverageYears: [2016, 2017, 2018, 2019, 2020],
};

/** Unwrap a success, failing loudly with the reason when it isn't one. */
function accepted(raw: unknown, ctx: ValidationContext = CTX) {
  const result = validateProposal(raw, ctx);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.reason}`);
  return result.value;
}

const GOOD = {
  theme: 'summer sprinklers',
  query: {
    placeQuery: 'children running through sprinklers',
    from: '2017-06-01',
    to: '2017-08-31',
    month: null,
    people: null,
    sceneType: 'outdoor',
  },
};

describe('validateProposal — shape', () => {
  it('accepts a well-formed proposal', () => {
    const value = accepted(GOOD);
    expect(value.theme).toBe('summer sprinklers');
    expect(value.query.placeQuery).toBe('children running through sprinklers');
    expect(value.query.sceneType).toBe('outdoor');
  });

  it('rejects a non-object', () => {
    expect(validateProposal('nope', CTX).ok).toBe(false);
    expect(validateProposal(null, CTX).ok).toBe(false);
  });

  it('rejects a proposal with no theme', () => {
    expect(validateProposal({ query: GOOD.query }, CTX).ok).toBe(false);
  });

  it('rejects a proposal whose query has no usable filter at all', () => {
    // Every field null would execute as "the entire library" — which always
    // clears the result floor and is never a collection.
    const result = validateProposal(
      {
        theme: 'everything',
        query: {
          placeQuery: null,
          from: null,
          to: null,
          month: null,
          people: null,
          sceneType: null,
        },
      },
      CTX,
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateProposal — server-controlled keys', () => {
  it('drops keys the model has no business setting', () => {
    // `rating` filters `$gte`, so a volunteered `rating: 1` would exclude
    // every unrated photo. `excludeHiddenPeople` and `hidden` are forced at
    // execution time and must not be overridable from stored data.
    const value = accepted({
      theme: 'sneaky',
      query: {
        ...GOOD.query,
        rating: 1,
        hidden: 'all',
        excludeHiddenPeople: 'false',
        isScreenshot: 'true',
        libraryId: '507f1f77bcf86cd799439011',
      },
    });
    const keys = Object.keys(value.query);
    for (const forbidden of [
      'rating',
      'hidden',
      'excludeHiddenPeople',
      'isScreenshot',
      'libraryId',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('validateProposal — people', () => {
  it('accepts a person the model was shown', () => {
    expect(accepted({ theme: 't', query: { ...GOOD.query, people: 'Greyson' } }).query.people).toBe(
      'Greyson',
    );
  });

  it('rejects a person the model was never shown', () => {
    // The digest withholds hidden people, so a name outside the roster is
    // either a hallucination or a hidden person the model guessed. Both must
    // fail closed rather than silently querying for them.
    const result = validateProposal(
      { theme: 't', query: { ...GOOD.query, people: 'Mallory' } },
      CTX,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when any name in a multi-person list is unknown', () => {
    const result = validateProposal(
      { theme: 't', query: { ...GOOD.query, people: 'Zoe,Mallory' } },
      CTX,
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateProposal — dates', () => {
  it('rejects a date range outside the library coverage', () => {
    // Observed live: a model wrote `from: 2013-06-01` against a library whose
    // earliest credible year was 2016, and a 1899 sentinel year holds 1,931
    // assets that would clear any result-count floor.
    const result = validateProposal(
      { theme: 't', query: { ...GOOD.query, from: '2013-01-01', to: '2013-12-31' } },
      CTX,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(
      validateProposal({ theme: 't', query: { ...GOOD.query, from: 'last summer' } }, CTX).ok,
    ).toBe(false);
  });

  it('accepts a recurring month and drops an out-of-range one', () => {
    expect(accepted({ theme: 't', query: { ...GOOD.query, month: 8 } }).query.month).toBe('8');
    expect(validateProposal({ theme: 't', query: { ...GOOD.query, month: 13 } }, CTX).ok).toBe(
      false,
    );
  });
});

describe('validateProposal — sceneType', () => {
  it('rejects a scene type outside the closed enum', () => {
    expect(
      validateProposal({ theme: 't', query: { ...GOOD.query, sceneType: 'underwater' } }, CTX).ok,
    ).toBe(false);
  });
});
