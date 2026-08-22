/** Pure tests for the timeout classification — the wiring in `list.ts` and
 * `total-cache.ts` stands on this predicate recognising Mongo's
 * MaxTimeMSExpired (code 50) and nothing else. */
import { describe, it, expect } from 'bun:test';
import { isMaxTimeExpired, pageAndTotalOrTimeout } from './query-timeout.ts';

describe('isMaxTimeExpired', () => {
  it('recognises Mongo code 50', () => {
    expect(isMaxTimeExpired({ code: 50, message: 'operation exceeded time limit' })).toBe(true);
  });

  it('rejects other Mongo errors, plain errors, and junk', () => {
    expect(isMaxTimeExpired({ code: 2 })).toBe(false);
    expect(isMaxTimeExpired(new Error('boom'))).toBe(false);
    expect(isMaxTimeExpired(null)).toBe(false);
    expect(isMaxTimeExpired('50')).toBe(false);
  });
});

describe('pageAndTotalOrTimeout', () => {
  const maxTime = { code: 50, message: 'operation exceeded time limit' };

  it('returns both legs on success', async () => {
    const out = await pageAndTotalOrTimeout(Promise.resolve(['a']), Promise.resolve(7));
    expect(out).toEqual({ timedOut: false, docs: ['a'], total: 7 });
  });

  it('maps a timed-out find to the marker', async () => {
    const out = await pageAndTotalOrTimeout(Promise.reject(maxTime), Promise.resolve(7));
    expect(out).toEqual({ timedOut: true });
  });

  it('maps a timed-out count to the marker', async () => {
    const out = await pageAndTotalOrTimeout(Promise.resolve(['a']), Promise.reject(maxTime));
    expect(out).toEqual({ timedOut: true });
  });

  it('rethrows anything that is not a time bound', async () => {
    await expect(
      pageAndTotalOrTimeout(Promise.reject(new Error('boom')), Promise.resolve(7)),
    ).rejects.toThrow('boom');
  });
});
