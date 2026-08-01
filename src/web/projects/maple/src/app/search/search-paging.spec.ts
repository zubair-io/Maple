// Tests for the `/search` pagination bookkeeping (#2129).

import { describe, it, expect } from 'vitest';
import type { SearchResponse } from '@maple-common';
import { nextPagingState } from './search-paging';

function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return { total: 9000, page: 0, limit: 100, results: [], ...over };
}

describe('nextPagingState — page counter', () => {
  it('adopts the server page in skip mode', () => {
    const s = nextPagingState(response({ page: 7 }), false, 800, 6);
    expect(s.page).toBe(7);
  });

  it('keeps the local counter in seek mode', () => {
    // A seek request echoes `page: 0`; adopting it would rewind the
    // fallback counter mid-scroll.
    const s = nextPagingState(response({ page: 0 }), true, 800, 6);
    expect(s.page).toBe(6);
  });
});

describe('nextPagingState — cursor', () => {
  it('carries the next cursor through', () => {
    expect(nextPagingState(response({ nextCursor: 'abc' }), false, 100, 0).nextCursor).toBe('abc');
  });

  it('normalises an absent cursor to null', () => {
    expect(nextPagingState(response(), false, 100, 0).nextCursor).toBeNull();
    expect(nextPagingState(response({ nextCursor: null }), false, 100, 0).nextCursor).toBeNull();
  });
});

describe('nextPagingState — total', () => {
  it('clamps a stale total once the seek chain is exhausted', () => {
    // The regression: `total` is a 30s server-side cache and can overstate
    // the set. Believing 9000 here keeps `canLoadMore` true and sends the
    // grid back to deep `page + 1` SKIP paging.
    const s = nextPagingState(
      response({ total: 9000, cursorPaging: true, nextCursor: null }),
      true,
      342,
      3,
    );
    expect(s.total).toBe(342);
  });

  it('trusts the total while the chain continues', () => {
    const s = nextPagingState(
      response({ total: 9000, cursorPaging: true, nextCursor: 'more' }),
      true,
      342,
      3,
    );
    expect(s.total).toBe(9000);
  });

  it('trusts the total when seek pagination was never available', () => {
    // `cursorPaging: false` + null cursor means "use page", not "the end" —
    // clamping here would truncate the grid on the `name` / `rating` sorts
    // and the relevance-ranked placeQuery path.
    const s = nextPagingState(
      response({ total: 9000, cursorPaging: false, nextCursor: null }),
      false,
      100,
      0,
    );
    expect(s.total).toBe(9000);
  });

  it('trusts the total on a server predating cursorPaging', () => {
    const s = nextPagingState(response({ total: 9000 }), false, 100, 0);
    expect(s.total).toBe(9000);
  });

  it('clamps on a short first page of a seekable query', () => {
    const s = nextPagingState(
      response({ total: 9000, cursorPaging: true, nextCursor: null }),
      false,
      12,
      0,
    );
    expect(s.total).toBe(12);
  });
});
