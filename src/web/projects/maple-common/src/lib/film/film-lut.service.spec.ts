// FilmLutService unit tests (epic #2683, Task 12).
//
// Uses `InMemoryFilmLutCache` (no real IndexedDB in this vitest run — see
// `util/idb.spec.ts`'s header note) + a stubbed `global.fetch`, following
// the pattern in `network/lan-switch.service.spec.ts`.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { FilmLutService, filmLutKey } from './film-lut.service';
import { FILM_LUT_CACHE, InMemoryFilmLutCache } from './film-lut-idb-cache';
import { FILM_CATALOG } from '../generated/film-catalog.generated';

function bytesFetch(payload: ArrayBuffer, status = 200): typeof fetch {
  return vi.fn(async () => new Response(payload, { status })) as unknown as typeof fetch;
}

function bufferOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe('FilmLutService.getLattice', () => {
  let service: FilmLutService;
  let cache: InMemoryFilmLutCache;

  beforeEach(() => {
    cache = new InMemoryFilmLutCache();
    TestBed.configureTestingModule({
      providers: [{ provide: FILM_LUT_CACHE, useValue: cache }],
    });
    service = TestBed.inject(FilmLutService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null without touching the cache or network for an empty lookId', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const result = await service.getLattice('');

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches /film-luts/<id>.mlut on a cache miss and caches the result', async () => {
    const bytes = bufferOf('mlut-v1-bytes');
    const fetchImpl = bytesFetch(bytes);
    vi.stubGlobal('fetch', fetchImpl);

    const result = await service.getLattice('slide_fuji_velvia_50');

    expect(fetchImpl).toHaveBeenCalledWith('/film-luts/slide_fuji_velvia_50.mlut');
    expect(result).not.toBeNull();
    expect(new Uint8Array(result!)).toEqual(new Uint8Array(bytes));
    await expect(cache.get('slide_fuji_velvia_50')).resolves.not.toBeNull();
  });

  it('returns the cached bytes on a cache hit, without calling fetch', async () => {
    const bytes = bufferOf('cached-bytes');
    await cache.put('black_white_kodak_tri_x_400', bytes);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    const result = await service.getLattice('black_white_kodak_tri_x_400');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(new Uint8Array(result!)).toEqual(new Uint8Array(bytes));
  });

  it('resolves null (never throws) and warns on a 404', async () => {
    const fetchImpl = bytesFetch(new ArrayBuffer(0), 404);
    vi.stubGlobal('fetch', fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.getLattice('retired_catalog_id');

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resolves null (never throws) when fetch itself rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.getLattice('slide_fuji_velvia_50');

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('filmLutKey', () => {
  it('is deterministic for the same id', () => {
    expect(filmLutKey('slide_fuji_velvia_50')).toBe(filmLutKey('slide_fuji_velvia_50'));
  });

  it('differs for different ids (spot check, not exhaustive)', () => {
    expect(filmLutKey('slide_fuji_velvia_50')).not.toBe(filmLutKey('black_white_kodak_tri_x_400'));
  });

  it('is never 0 — the raw-core "no look loaded" sentinel', () => {
    for (const entry of FILM_CATALOG) {
      expect(filmLutKey(entry.id)).not.toBe(0);
    }
  });

  it('has no collisions across the full 100-entry catalog', () => {
    const keys = new Set(FILM_CATALOG.map((entry) => filmLutKey(entry.id)));
    expect(keys.size).toBe(FILM_CATALOG.length);
  });
});
