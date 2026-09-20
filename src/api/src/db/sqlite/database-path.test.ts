/**
 * Where the library lives, and whether anyone chose it.
 *
 * The second question is the one with teeth. `ensureSchemaAtBoot` creates the
 * database when it is absent, which is right for a first install and dangerous
 * in exactly one combination: a first boot on the built-in default, which is a
 * relative path. In a container that resolves inside the container, so the
 * library it creates is discarded with the container and the next boot makes
 * another empty one — a server that works, has no photos, and never errored.
 * The warning that names this is gated on {@link sqliteDatabasePathIsDefault},
 * so the predicate is worth pinning rather than assuming.
 */

import { afterAll, beforeAll, afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_SQLITE_PATH,
  sqliteDatabasePath,
  sqliteDatabasePathIsDefault,
} from './database-path.ts';

let previous: string | undefined;

beforeAll(() => {
  previous = process.env.MAPLE_SQLITE_PATH;
});

afterEach(() => {
  delete process.env.MAPLE_SQLITE_PATH;
});

afterAll(() => {
  if (previous === undefined) delete process.env.MAPLE_SQLITE_PATH;
  else process.env.MAPLE_SQLITE_PATH = previous;
});

describe('the library database path', () => {
  test('falls back to the built-in default when nothing set it', () => {
    expect(sqliteDatabasePath()).toBe(DEFAULT_SQLITE_PATH);
    expect(sqliteDatabasePathIsDefault()).toBe(true);
  });

  test('uses the operator’s path when one is set', () => {
    process.env.MAPLE_SQLITE_PATH = '/srv/maple/library.sqlite';
    expect(sqliteDatabasePath()).toBe('/srv/maple/library.sqlite');
    expect(sqliteDatabasePathIsDefault()).toBe(false);
  });

  test('treats a deliberate choice of the default as a choice', () => {
    // Setting the variable to the same string the default holds is an
    // operator who has read the documentation and meant it. The two functions
    // have to agree on that or the warning fires at someone who already knows.
    process.env.MAPLE_SQLITE_PATH = DEFAULT_SQLITE_PATH;
    expect(sqliteDatabasePath()).toBe(DEFAULT_SQLITE_PATH);
    expect(sqliteDatabasePathIsDefault()).toBe(false);
  });

  test('an empty value is a set value, not an absent one', () => {
    // `??` falls back on null and undefined only, so an empty string reaches
    // the caller as a path. Whatever that does downstream, the two functions
    // must not disagree about it — a path of `''` that reported itself as the
    // default would warn about a container risk it does not have.
    process.env.MAPLE_SQLITE_PATH = '';
    expect(sqliteDatabasePath()).toBe('');
    expect(sqliteDatabasePathIsDefault()).toBe(false);
  });

  test('the default is relative, which is the whole reason for the warning', () => {
    expect(DEFAULT_SQLITE_PATH.startsWith('/')).toBe(false);
  });
});
