/** Pure tests for the timeout classification — the wiring in `list.ts` and
 * `total-cache.ts` stands on this predicate recognising Mongo's
 * MaxTimeMSExpired (code 50) and nothing else. */
import { describe, it, expect } from 'bun:test';
import { isMaxTimeExpired } from './query-timeout.ts';

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
