/**
 * Shared fixtures for the imports suites.
 *
 * The Mongo version of this file registered connect / clear / teardown hooks at
 * module scope and handed back one scratch database that every case in a suite
 * shared. None of that survives the cutover (#3787): the SQLite harness gives
 * each test its own database, so there is no namespace to clear between cases,
 * no connection to tear down, and no "is Mongo reachable" flag to skip-pass on.
 *
 * What is left is the two pieces of data an imports test still needs — a
 * library row to import into, and a throwaway file entry.
 *
 * Named `.fixtures.ts` so bun's `*.test.ts` glob doesn't run it as a suite —
 * mirrors `workers/stages/describe.fixtures.ts`.
 */

import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import { insertFolder } from '../db/sqlite/test-sqlite.test-helpers.ts';
import type { ImportFileEntry } from '../db/schema.ts';

/** A throwaway pending file entry destined for `2024/03/<src>`. */
export function file(src: string): ImportFileEntry {
  return {
    src,
    dest: `2024/03/${src}`,
    size: 1,
    mtime: 0,
    kind: 'image',
    state: 'pending',
    error: null,
  };
}

/** The library an import is created against, in the shape `createImport` takes. */
export interface TestLibrary {
  id: ObjectId;
  root: string;
}

/**
 * Insert the library root an import needs.
 *
 * Not optional scaffolding the way the Mongo fixture's `lib` constant was:
 * `imports.library_id` is a foreign key onto `folders` now, so an import
 * created against an id nothing minted is rejected outright rather than stored
 * pointing at nothing.
 */
export function seedLibrary(db: Database): TestLibrary {
  const root = '/srv/lib';
  return { id: new ObjectId(insertFolder(db, { path: root })), root };
}
