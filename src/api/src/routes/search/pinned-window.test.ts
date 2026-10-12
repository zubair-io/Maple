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
let libraryId: string;
const ranked: string[] = [];

interface ListBody {
  total: number;
  more: boolean;
  capped?: boolean;
  results: Array<{ filename: string }>;
  rankPin?: string;
  rankedBy?: unknown;
  code?: string;
}

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { slug: 'pinned', path: '/lib' });
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

async function page(index: number, pin?: string, query = 'greyson'): Promise<ListBody> {
  const pinned = pin === undefined ? '' : `&rankPin=${encodeURIComponent(pin)}`;
  const { status, body } = await request(`placeQuery=${query}&limit=100&page=${index}${pinned}`);
  expect(status).toBe(200);
  return body;
}

/** A pin's engine and steps, without the search fingerprint every pin ends with. */
function ranking(pin: string | undefined): string {
  return (pin ?? '').split(':').slice(0, 2).join(':');
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
    expect(ranking((await page(0)).rankPin)).toBe('in-process:100');
  });

  it('names the database while the child is down', async () => {
    setInProcessSearchForTests(fakeInProcessSearch(null));
    expect(ranking((await page(0)).rankPin)).toBe('database:100');
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
    expect(ranking(second.rankPin)).toBe('in-process:100,400');
    expect(ranking(third.rankPin)).toBe('in-process:100,400');
    expect(engine.ks).toEqual([100, 100, 400, 100, 400]);
    expect(second.rankedBy).toEqual({ engine: 'in-process', semanticHits: 100 });
  });

  it('answers 409 when the child fails a deeper step the page has to widen to', async () => {
    const forward = fakeInProcessSearch(ranked);
    setInProcessSearchForTests({
      status: forward.status,
      search: async (query, k) => (k < 400 ? (await forward.search(query, k))!.slice(0, k) : null),
    });
    const first = await page(0);

    const { status, body } = await request(
      `placeQuery=greyson&limit=100&page=1&rankPin=${encodeURIComponent(first.rankPin!)}`,
    );

    expect({ status, code: body.code }).toEqual({ status: 409, code: RANK_ENGINE_CHANGED });
  });

  for (const [hits, capped] of [
    [6_000, true],
    [5_000, false],
  ] as const) {
    it(`replays the cap's lookahead: ${hits} hits ${capped ? 'are' : 'are not'} capped`, async () => {
      const gone = Array.from({ length: hits - ranked.length }, (_, index) => `gone${index}`);
      const forward = fakeInProcessSearch([...ranked, ...gone]);
      setInProcessSearchForTests({
        status: forward.status,
        search: async (query, k) => (await forward.search(query, k))!.slice(0, k),
      });
      const read = async (index: number, pin?: string) => {
        const pinned = pin === undefined ? '' : `&rankPin=${encodeURIComponent(pin)}`;
        return (await request(`placeQuery=greyson&limit=500&page=${index}${pinned}`)).body;
      };

      const first = await read(0);
      const second = await read(1, first.rankPin);

      expect(ranking(first.rankPin)).toBe('in-process:5000');
      expect(first).toMatchObject({ total: 300, more: false, capped });
      expect(second).toMatchObject({ total: 300, more: false, capped, results: [] });
    });
  }

  it('answers 409 when the pin was minted for another search', async () => {
    setInProcessSearchForTests(depthSensitive(ranked));
    const other = await page(0, undefined, 'xxxxx');

    const { status } = await request(
      `placeQuery=greyson&limit=100&page=1&rankPin=${encodeURIComponent(other.rankPin!)}`,
    );

    expect(status).toBe(409);
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
    expect(ranking(restarted.rankPin)).toBe('database:100');
    expect(restarted.rankedBy).toBeUndefined();
  });
});

describe('paging a pinned search over copies of one shot (#4557)', () => {
  it('never shows on page 1 a copy of a shot page 0 already showed', async () => {
    const shots: string[] = [];
    const copies: string[] = [];
    for (let index = 1; index <= 150; index++) {
      const frame = `IMG_${String(index).padStart(4, '0')}`;
      const capturedAt = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
      for (const [ids, mapleId, filename] of [
        [shots, `shot${index}`, `${frame}.dng`],
        [copies, `copy${index}`, `${frame}(2).dng`],
      ] as const) {
        ids.push(mapleId);
        seedSearchAsset(live.db, libraryId, { mapleId, filename, capturedAt, searchBlob: 'coast' });
      }
    }
    setInProcessSearchForTests(depthSensitive([...shots, ...copies]));

    const first = await page(0, undefined, 'coast');
    const second = await page(1, first.rankPin, 'coast');
    const frames = (body: ListBody) =>
      body.results.map((row) => row.filename.replace('(2)', '').replace('.dng', ''));

    expect(frames(first)).toHaveLength(100);
    expect(frames(second).filter((frame) => frames(first).includes(frame))).toEqual([]);
    expect(second).toMatchObject({ total: 150, more: false });
    expect(new Set([...frames(first), ...frames(second)]).size).toBe(150);
  });
});

describe('a pinned page at the cap (#4557)', () => {
  for (const [last, capped] of [
    ['copy', false],
    ['photo001', true],
  ] as const) {
    it(`is ${capped ? '' : 'not '}capped when the hit past the cap is ${last}`, async () => {
      const capturedAt = '2021-05-01T10:00:00.000Z';
      seedSearchAsset(live.db, libraryId, {
        mapleId: 'shot',
        filename: 'IMG_9999.dng',
        capturedAt,
        searchBlob: 'greyson',
      });
      seedSearchAsset(live.db, libraryId, {
        mapleId: 'copy',
        filename: 'IMG_9999(2).dng',
        capturedAt,
        searchBlob: 'greyson',
      });
      const gone = Array.from({ length: 4_999 }, (_, index) => `gone${index}`);
      const forward = fakeInProcessSearch(['shot', ...gone, last]);
      setInProcessSearchForTests({
        status: forward.status,
        search: async (query, k) => (await forward.search(query, k))!.slice(0, k),
      });
      const read = async (index: number, pin?: string) => {
        const pinned = pin === undefined ? '' : `&rankPin=${encodeURIComponent(pin)}`;
        return (await request(`placeQuery=greyson&limit=500&page=${index}${pinned}`)).body;
      };

      const first = await read(0);
      const second = await read(1, first.rankPin);

      expect(ranking(first.rankPin)).toBe('in-process:5000');
      expect([first.capped, second.capped]).toEqual([capped, capped]);
    });
  }
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
    expect(ranking(second.rankPin)).toBe('database:100,400');
    expect(new Set(served).size).toBe(200);
  });
});

describe('the rankPin a request carries', () => {
  it('is a 400 when this server could not have minted it', async () => {
    setInProcessSearchForTests(depthSensitive(ranked));
    const search = (await page(0)).rankPin!.split(':')[2];
    const forged = ['meili:100', 'in-process:150', 'in-process:400,100', 'in-process:100,1600'];
    const malformed = ['in-process:0100', 'in-process:100,5000', 'in-process:', ' ', ''];
    for (const steps of [...forged, ...malformed]) {
      const pin = steps.trim() === '' ? steps : `${steps}:${search}`;
      const { status } = await request(
        `placeQuery=greyson&page=1&rankPin=${encodeURIComponent(pin)}`,
      );
      expect({ pin, status }).toEqual({ pin, status: 400 });
    }
  });

  it('is a 400 on a first page, which never takes one', async () => {
    setInProcessSearchForTests(depthSensitive(ranked));
    const pin = (await page(0)).rankPin!;
    const { status } = await request(
      `placeQuery=greyson&page=0&rankPin=${encodeURIComponent(pin)}`,
    );
    expect(status).toBe(400);
  });

  it('round-trips through its wire form', () => {
    const pin = {
      engine: 'in-process' as const,
      steps: [100, 400, 1_600, 5_000],
      search: 'abcDEF012-_x',
    };
    expect(decodeRankPin(encodeRankPin(pin))).toEqual(pin);
    expect(decodeRankPin('database:1600,5000:abcDEF012-_x')).toEqual({
      engine: 'database',
      steps: [1_600, 5_000],
      search: 'abcDEF012-_x',
    });
    expect(decodeRankPin('database:400')).toBeNull();
    expect(decodeRankPin('database:400:short')).toBeNull();
    expect(decodeRankPin('database:1e2:abcDEF012-_x')).toBeNull();
    expect(decodeRankPin('database:5000,20000:abcDEF012-_x')).toBeNull();
  });
});
