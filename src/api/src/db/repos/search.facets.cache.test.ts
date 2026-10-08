/**
 * The short-lived facet cache (#4431): hits within the window, misses after
 * it, shares an in-flight computation, forgets a failure, stays bounded and
 * never crosses database handles.
 */

import { expect, test } from 'bun:test';
import {
  cachedFacets,
  FACET_CACHE_MAX_ENTRIES,
  FACET_CACHE_TTL_MS,
} from './search.facets.cache.ts';
import type { SqliteDb } from './db-handle.ts';

function handle(): SqliteDb {
  const refuse = () => Promise.reject(new Error('not used'));
  return { read: refuse, write: refuse, transaction: refuse };
}

function counter() {
  const calls = { n: 0 };
  const compute = () => Promise.resolve(++calls.n);
  return { calls, compute };
}

test('a repeat within the window is served from the cache; after it, recomputed', async () => {
  const db = handle();
  const { calls, compute } = counter();
  const now = 1_000_000;
  expect(await cachedFacets(db, { q: 'people' }, compute, now)).toBe(1);
  expect(await cachedFacets(db, { q: 'people' }, compute, now + FACET_CACHE_TTL_MS - 1)).toBe(1);
  expect(await cachedFacets(db, { q: 'people' }, compute, now + FACET_CACHE_TTL_MS)).toBe(2);
  expect(calls.n).toBe(2);
});

test('a different query or another handle is a miss', async () => {
  const db = handle();
  const { calls, compute } = counter();
  await cachedFacets(db, { q: 'people' }, compute, 0);
  await cachedFacets(db, { q: 'people', rating: '4' }, compute, 0);
  await cachedFacets(handle(), { q: 'people' }, compute, 0);
  expect(calls.n).toBe(3);
});

test('concurrent identical requests share one computation', async () => {
  const db = handle();
  let release: (value: string) => void = () => {};
  let started = 0;
  const compute = () => {
    started++;
    return new Promise<string>((resolve) => (release = resolve));
  };
  const first = cachedFacets(db, 'q', compute, 0);
  const second = cachedFacets(db, 'q', compute, 1);
  release('facets');
  expect(await Promise.all([first, second])).toEqual(['facets', 'facets']);
  expect(started).toBe(1);
});

test('a failed computation is not cached', async () => {
  const db = handle();
  const failed = cachedFacets(db, 'q', () => Promise.reject(new Error('boom')), 0);
  await expect(failed).rejects.toThrow('boom');
  expect(await cachedFacets(db, 'q', () => Promise.resolve('ok'), 1)).toBe('ok');
});

test('holds at most the bounded number of entries, oldest out first', async () => {
  const db = handle();
  const { calls, compute } = counter();
  for (let i = 0; i <= FACET_CACHE_MAX_ENTRIES; i++) await cachedFacets(db, i, compute, 0);
  expect(calls.n).toBe(FACET_CACHE_MAX_ENTRIES + 1);
  await cachedFacets(db, FACET_CACHE_MAX_ENTRIES, compute, 0);
  expect(calls.n).toBe(FACET_CACHE_MAX_ENTRIES + 1);
  await cachedFacets(db, 0, compute, 0);
  expect(calls.n).toBe(FACET_CACHE_MAX_ENTRIES + 2);
});

test('an answer the query did not ask for serves its waiters, then is forgotten', async () => {
  const db = handle();
  let release: (value: string) => void = () => {};
  const first = cachedFacets(
    db,
    'q',
    () => new Promise<string>((resolve) => (release = resolve)),
    0,
    (answer) => answer === 'external',
  );
  const waiting = cachedFacets(db, 'q', () => Promise.resolve('never'), 1);
  release('database');
  expect(await Promise.all([first, waiting])).toEqual(['database', 'database']);
  expect(
    await cachedFacets(
      db,
      'q',
      () => Promise.resolve('external'),
      2,
      (a) => a === 'external',
    ),
  ).toBe('external');
  expect(await cachedFacets(db, 'q', () => Promise.resolve('recomputed'), 3)).toBe('external');
});
