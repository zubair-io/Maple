import { describe, expect, it } from 'vitest';
import { appendPage } from './search-paging';
import type { SearchResponse, SearchResult } from '../api/search.service';

function rows(prefix: string, count: number): SearchResult[] {
  return Array.from(
    { length: count },
    (_, i) => ({ id: `${prefix}${i}`, filename: `${prefix}${i}.dng` }) as SearchResult,
  );
}

function response(over: Partial<SearchResponse>): SearchResponse {
  return { total: 0, page: 1, limit: 30, results: [], ...over };
}

describe('appendPage', () => {
  it('keeps the server total and its more flag while rows keep landing', () => {
    const next = appendPage(
      rows('a', 30),
      30,
      response({ total: 60, more: true, results: rows('b', 30) }),
      true,
    );
    expect(next).toMatchObject({ total: 60, more: true, capped: false, widened: true });
    expect(next.results).toHaveLength(60);
  });

  it('ends the set at the rows held when a page comes back empty', () => {
    const next = appendPage(rows('a', 30), 60, response({ total: 60, more: true }), true);
    expect(next).toMatchObject({ total: 30, more: false, widened: false });
  });

  it('ends the set at the rows held when a seek chain is exhausted', () => {
    const next = appendPage(
      rows('a', 30),
      90,
      response({ total: 90, results: rows('b', 10), cursorPaging: true, nextCursor: null }),
      false,
    );
    expect(next).toMatchObject({ total: 40, nextCursor: null, widened: false });
  });

  it('carries the cap, and widens only for free text whose total changed', () => {
    const capped = appendPage(
      rows('a', 30),
      5000,
      response({ total: 5000, capped: true, results: rows('b', 30) }),
      true,
    );
    expect(capped).toMatchObject({ capped: true, more: false, widened: false });
    const structured = appendPage(
      rows('a', 30),
      30,
      response({ total: 90, results: rows('b', 30) }),
      false,
    );
    expect(structured.widened).toBe(false);
  });
});
