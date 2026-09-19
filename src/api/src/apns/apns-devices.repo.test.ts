/**
 * `normalizeDeviceToken` is the only thing left in this module that is not a
 * re-export: the database verbs moved to
 * `db/repos/apns-devices.repo.ts` (#3787) and are covered, case for
 * case, by that module's own suite. Keeping a second copy of those tests here
 * would only assert that a re-export forwards.
 */

import { describe, expect, it } from 'bun:test';
import { normalizeDeviceToken } from './apns-devices.repo.ts';

describe('normalizeDeviceToken', () => {
  const VALID = 'a1'.repeat(32); // 64 lowercase hex chars

  it('accepts a valid lowercase hex token unchanged', () => {
    expect(normalizeDeviceToken(VALID)).toBe(VALID);
  });

  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeDeviceToken(`  ${VALID.toUpperCase()}\n`)).toBe(VALID);
  });

  it('rejects a token that is too short', () => {
    expect(normalizeDeviceToken('a1b2')).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(normalizeDeviceToken('z'.repeat(64))).toBeNull();
    expect(normalizeDeviceToken('not-a-real-token')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(normalizeDeviceToken('')).toBeNull();
    expect(normalizeDeviceToken('   ')).toBeNull();
  });
});
