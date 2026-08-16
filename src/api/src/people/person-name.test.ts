/**
 * The person-name rule (#2877) — the pure predicate, plus the repo guards
 * that enforce it.
 *
 * Lives in its own file rather than `people.repo.test.ts`: that file is at
 * the 570-line headroom threshold, and this is a self-contained concern.
 * Real Mongo for the repo cases, skip-pass when unreachable (same harness).
 */

import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import type { PersonDoc } from '../db/schema.ts';
import { setupMongoHarness } from './people-repo.test-helpers.ts';
import { personNameError } from './person-name.ts';

// The repo's `getDb()` singleton reads MAPLE_MONGO_DB when this file's
// `it` bodies dynamically import it. Set it inside a hook and restore it
// afterwards: Bun runs every module body during the import phase, so a
// module-scope assignment would leak this database name into whichever
// suite happens to run next (#2783).
const TEST_DB = `maple_test_person_name_${process.pid}`;
let prevMongoDb: string | undefined;

beforeAll(() => {
  prevMongoDb = process.env.MAPLE_MONGO_DB;
  process.env.MAPLE_MONGO_DB = TEST_DB;
});

const h = setupMongoHarness(TEST_DB);

afterAll(() => {
  if (prevMongoDb === undefined) delete process.env.MAPLE_MONGO_DB;
  else process.env.MAPLE_MONGO_DB = prevMongoDb;
});

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

describe('people.repo — name rule enforcement', () => {
  it('createPerson rejects a comma', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    await expect(createPerson('Doe, Jane')).rejects.toThrow(/comma/);
  });

  it('renamePerson rejects a comma and leaves the stored name untouched', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, renamePerson } = await import('./people.repo.ts');
    const p = await createPerson('Frank');
    await expect(renamePerson(p._id, 'Frank, Jr')).rejects.toThrow(/comma/);
    const row = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(row?.name).toBe('Frank');
  });
});
