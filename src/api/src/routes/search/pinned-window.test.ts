/**
 * Every page of one free-text search comes from one ranking (#4542): the first page's `rankPin`
 * pins the engine and window steps of the pages after it, and a page whose engine is gone answers
 * 409 `rank_engine_changed` instead of being ranked by another engine.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { listRoute } from './list.ts';
import { RANK_ENGINE_CHANGED } from './list-ranked.ts';
import { decodeRankPin, encodeRankPin } from './pinned-window.ts';
import { _resetCacheForTests } from './total-cache.ts';
import { seedSearchAsset } from '../../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { setInProcessSearchForTests, type InProcessSearch } from '../../search/search-pool.ts';
import { fakeInProcessSearch } from '../../search/search.test-helpers.ts';

let live: LiveTestDatabase;
const ranked: string[] = [];

interface ListBody {
  total: number;
  more: boolean;
  results: Array<{ filename: string }>;
  rankPin?: string;
  rankedBy?: unknown;
  code?: string;
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'pinned', path: '/lib' });
  ranked.length = 0;
  for (let rank = 1; rank <= 300; rank++) {
    const mapleId = `photo${String(rank).padStart(3, '0')}`;
    ranked.push(mapleId);
    seedSearchAsset(live.db, libraryId, {
      mapleId,
      filename: `${mapleId}.dng`,
      searchBlob: `greyson ${'x'.repeat(rank)}`,
    });
  }
  _resetCacheForTests();
});

afterEach(() => {
  setInProcessSearchForTests(null);
  _resetCacheForTests();
  live.close();
});

async function request(query: string): Promise<{ status: number; body: ListBody }> {
  const res = await new Elysia().use(listRoute).handle(new Request(`http://localhost/?${query}`));
  return { status: res.status, body: (await res.json()) as ListBody };
}

async function page(index: number, pin?: string): Promise<ListBody> {
  const pinned = pin === undefined ? '' : `&rankPin=${encodeURIComponent(pin)}`;
  const { status, body } = await request(`placeQuery=greyson&limit=100&page=${index}${pinned}`);
  expect(status).toBe(200);
  return body;
}

/**
 * A child whose fused order depends on how deep it is asked, as the real one's does: below 400 it
 * ranks `ids` as given, from 400 on it ranks them in reverse.
 */
function depthSensitive(ids: readonly string[]): InProcessSearch & { ks: number[] } {
  const ks: number[] = [];
  const forward = fakeInProcessSearch(ids);
  const reverse = fakeInProcessSearch([...ids].reverse());
  return {
    ks,
    status: forward.status,
    async search(query, k) {
      ks.push(k);
      const hits = await (k >= 400 ? reverse : forward).search(query, k);
      return hits?.slice(0, k) ?? null;
    },
  };
}

describe('a first page', () => {
  it('names the in-process engine and the step it ranked at', async () => {
    setInProcessSearchForTests(depthSensitive(ranked));
    expect((await page(0)).rankPin).toBe('in-process:100');
  });

  it('names the database while the child is down', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    expect((await page(0)).rankPin).toBe('database:100');
  });
});

describe('paging a pinned in-process search', () => {
  it('serves every match once even though a deeper ranking reorders the shallow one', async () => {
    const engine = depthSensitive(ranked);
    setInProcessSearchForTests(engine);

    const first = await page(0);
    const second = await page(1, first.rankPin);
    const third = await page(2, second.rankPin);
    const served = [first, second, third].flatMap((body) => body.results.map((r) => r.filename));

    expect(served.slice(0, 100)).toEqual(ranked.slice(0, 100).map((id) => `${id}.dng`));
    expect(new Set(served).size).toBe(300);
    expect(second.rankPin).toBe('in-process:100,400');
    expect(third.rankPin).toBe('in-process:100,400');
  });

  it('answers 409 rank_engine_changed when the child goes down between pages', async () => {
    setInProcessSearchForTests(depthSensitive(ranked));
    const first = await page(0);

    setInProcessSearchForTests(fakeInProcessSearch(null));
    const { status, body } = await request(
      `placeQuery=greyson&limit=100&page=1&rankPin=${encodeURIComponent(first.rankPin!)}`,
    );

    expect(status).toBe(409);
    expect(body.code).toBe(RANK_ENGINE_CHANGED);
  });

  it('ranks a restarted first page with whichever engine answers', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const restarted = await page(0);
    expect(restarted.rankPin).toBe('database:100');
    expect(restarted.rankedBy).toBeUndefined();
  });
});

describe('paging a pinned database search', () => {
  it('stays on the database when the child comes back mid-scroll', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    const first = await page(0);
    const engine = depthSensitive([...ranked].reverse());
    setInProcessSearchForTests(engine);

    const second = await page(1, first.rankPin);
    const served = [first, second].flatMap((body) => body.results.map((r) => r.filename));

    expect(engine.ks).toEqual([]);
    expect(second.rankedBy).toBeUndefined();
    expect(second.rankPin).toBe('database:100,400');
    expect(new Set(served).size).toBe(200);
  });
});

describe('the rankPin a request carries', () => {
  it('is a 400 when this server could not have minted it', async () => {
    setInProcessSearchForTests(depthSensitive(ranked));
    for (const pin of ['meili:100', 'in-process:150', 'in-process:400,100', 'in-process:']) {
      const { status } = await request(
        `placeQuery=greyson&page=1&rankPin=${encodeURIComponent(pin)}`,
      );
      expect({ pin, status }).toEqual({ pin, status: 400 });
    }
  });

  it('round-trips through its wire form', () => {
    const pin = { engine: 'in-process' as const, steps: [100, 400, 1_600, 5_000] };
    expect(decodeRankPin(encodeRankPin(pin))).toEqual(pin);
    expect(decodeRankPin('database:400')).toEqual({ engine: 'database', steps: [400] });
    expect(decodeRankPin('database:400:1')).toBeNull();
    expect(decodeRankPin('database:1e2')).toBeNull();
  });
});
