/**
 * Corpus integrity for the relevance gate (#2384). Runs offline in CI — no
 * Meilisearch, no Ollama.
 *
 * Why this exists: every id in `queries.json` is a string, and a typo'd one
 * would make its guard reference a document that does not exist. `mustBeInTop`
 * would then fail loudly (fine), but a mistyped `relevantIds` entry would
 * quietly drag Recall@10 to 0 and look like a ranking regression, while a
 * mistyped `observeIds` entry would silently report `null` forever. Checking
 * referential integrity here keeps the expensive gate honest.
 */

import { describe, expect, it } from 'bun:test';
import corpus from './fixtures/search-relevance/corpus.json';
import queries from './fixtures/search-relevance/queries.json';
import budgets from './fixtures/search-relevance/budgets.json';

interface CorpusDoc {
  id: string;
  filename?: string;
  mediaType?: string;
  description?: string | null;
  transcript?: string | null;
  ocrText?: string | null;
  placeText?: string | null;
  people?: string[] | null;
  searchBlob?: string;
}

interface QueryCase {
  query: string;
  relevantIds: string[];
  mustBeInTop?: { id: string; k: number };
  observeIds?: string[];
}

const docs = corpus as CorpusDoc[];
const cases = queries as QueryCase[];
const ids = new Set(docs.map((doc) => doc.id));

describe('relevance corpus integrity', () => {
  it('is large enough that a single query cannot dominate the aggregate', () => {
    expect(docs.length).toBeGreaterThanOrEqual(30);
  });

  it('has unique document ids', () => {
    expect(ids.size).toBe(docs.length);
  });

  it('gives every document the fields the embedder template dereferences', () => {
    for (const doc of docs) {
      expect(typeof doc.id).toBe('string');
      expect(typeof doc.filename).toBe('string');
      expect(typeof doc.searchBlob).toBe('string');
    }
  });

  it('resolves every id referenced by a query', () => {
    for (const testCase of cases) {
      for (const id of testCase.relevantIds) {
        expect(ids, `relevantIds of "${testCase.query}"`).toContain(id);
      }
      for (const id of testCase.observeIds ?? []) {
        expect(ids, `observeIds of "${testCase.query}"`).toContain(id);
      }
      if (testCase.mustBeInTop) {
        expect(ids, `mustBeInTop of "${testCase.query}"`).toContain(testCase.mustBeInTop.id);
      }
    }
  });

  it('keeps every mustBeInTop target inside its own relevant set', () => {
    for (const testCase of cases) {
      if (!testCase.mustBeInTop) continue;
      expect(testCase.relevantIds).toContain(testCase.mustBeInTop.id);
    }
  });

  it('covers more than one query family so the gate cannot be overfit', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    const asserted = cases.filter((c) => c.mustBeInTop);
    expect(asserted.length).toBeGreaterThanOrEqual(3);
  });

  it('holds the #2384 fixture case verbatim', () => {
    // The query string is part of the contract — the issue forbids rewriting
    // it, so a "helpful" edit to this fixture is itself the regression.
    const hvac = cases.find((c) => c.query === 'HVAC air conditioning installation');
    expect(hvac).toBeDefined();
    expect(hvac!.mustBeInTop).toEqual({ id: '010045ca68ac1f7f7e8b3aa02f72ac80', k: 5 });
    const target = docs.find((d) => d.id === '010045ca68ac1f7f7e8b3aa02f72ac80');
    expect(target!.filename).toBe('IMG_4185.MOV');
    expect(target!.mediaType).toBe('video');
    expect(target!.transcript).toContain('heat pumps installed');
  });

  it('keeps competing HVAC-captioned photos in the corpus', () => {
    // Without the distractors the #2384 case would pass trivially. These are
    // the documents that currently outrank the video in production.
    const distractors = docs.filter(
      (d) =>
        d.id !== '010045ca68ac1f7f7e8b3aa02f72ac80' &&
        /hvac|air conditioning/i.test(d.description ?? ''),
    );
    expect(distractors.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the named-person guard falsifiable', () => {
    // A transcript that says "Greyson" with no person tag must exist, or the
    // Greyson guard proves nothing about attribute ordering.
    const untagged = docs.find((d) => d.id === 'mentions-greyson-untagged');
    expect(untagged!.people).toBeNull();
    expect(untagged!.transcript).toContain('Greyson');
    const tagged = docs.find((d) => d.id === 'person-greyson-1');
    expect(tagged!.people).toContain('Greyson Smith');
    expect(tagged!.description ?? '').not.toContain('Greyson');
  });

  it('leaves the #2386 name/common-noun case unasserted', () => {
    const rose = cases.find((c) => c.query === 'Rose');
    expect(rose).toBeDefined();
    expect(rose!.relevantIds).toEqual([]);
    expect(rose!.mustBeInTop).toBeUndefined();
    expect(rose!.observeIds).toEqual(['person-rose-1', 'flowers-roses-1']);
  });

  it('keeps the budget floors within [0, 1]', () => {
    for (const floor of [budgets.minRecallAt10, budgets.minMrr]) {
      expect(floor).toBeGreaterThanOrEqual(0);
      expect(floor).toBeLessThanOrEqual(1);
    }
    expect(budgets.semanticRatio).toBeGreaterThanOrEqual(0);
    expect(budgets.semanticRatio).toBeLessThanOrEqual(1);
  });
});
