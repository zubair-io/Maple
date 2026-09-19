/**
 * The person-name rule (#2877) — the pure predicate.
 *
 * The repository guards that enforce the same rule are exercised against the
 * real store in `db/repos/people.names.test.ts`, which is where every
 * other naming behaviour (the case-insensitive uniqueness, the merge on
 * collision) already lives.
 */

import { describe, it, expect } from 'bun:test';
import { personNameError } from './person-name.ts';

describe('personNameError', () => {
  it('accepts an ordinary name', () => {
    expect(personNameError('Priya Patel')).toBeNull();
  });

  it('rejects blank / whitespace-only names', () => {
    expect(personNameError('')).toBe('name must not be empty');
    expect(personNameError('   ')).toBe('name must not be empty');
  });

  // Search's `people` filter param is comma-separated on the wire, so a
  // comma would split one name into two that resolve to nobody — and an
  // unresolved name matches NOTHING, so the filter would silently return
  // zero results.
  it('rejects a name containing a comma, anywhere in it', () => {
    expect(personNameError('Doe, Jane')).toBe('name must not contain a comma');
    expect(personNameError(',leading')).toBe('name must not contain a comma');
    expect(personNameError('trailing,')).toBe('name must not contain a comma');
  });

  it('validates the TRIMMED name, so surrounding space is not a loophole', () => {
    expect(personNameError('  Smith,Bob  ')).toBe('name must not contain a comma');
  });
});
