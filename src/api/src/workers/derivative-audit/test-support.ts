/**
 * Shared harness for the derivative-audit tests (config repo, scan pass, and the
 * routes suite in `routes/derivative-audit.test.ts`).
 *
 * All three drive code that reaches the database with no handle of its own — a
 * route handler, a worker tick — so they need the process-wide handle pointed at
 * a throwaway database for the duration of the block. That is exactly what
 * {@link createLiveTestDatabase} does, and it is re-exported here rather than
 * wrapped so a test imports its whole harness from one place, the way the Mongo
 * `setupAuditMongo` this replaces used to be a single entry point.
 *
 * Not a `*.test.ts` file, so bun never runs it as a suite.
 */

import type { Database } from 'bun:sqlite';
import { insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';

export { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';

/**
 * Register `root` as a library and return its id, as the hex string the
 * `library_id` of a location is.
 *
 * The invalidation is the part that is easy to forget and expensive to debug:
 * `loadLibraryRoots()` / `loadLibraryIdToSlug()` cache their map at module
 * scope for the whole process, so without it a second test in the same file
 * resolves its assets against the first test's — now closed — database and every
 * path comes out either wrong or unresolvable.
 */
export function addLibrary(db: Database, root: string, slug?: string): string {
  const id = insertFolder(db, { path: root, slug: slug ?? `audit-${root.split('/').pop()}` });
  invalidateLibraryRoots();
  return id;
}
