/**
 * The worker's own contract for `generated_searches` — the daily themed
 * collections it invents — and the door through which it stores them.
 *
 * The two interfaces stay here because they are the worker's vocabulary, not
 * the storage layer's: `runProposalLoop` assembles a `GeneratedSearchInput`
 * and carries it through validation and result-counting long before anything
 * is written, and the three consumers of a stored collection (Settings →
 * Workers, the Maple TV shelf, the Apple widget) read a `GeneratedSearchDoc`.
 *
 * The storage itself moved to SQLite (#3787) and lives in
 * `db/sqlite/repos/generated-searches.repo.ts`. The three functions are
 * re-exported from there rather than being re-implemented or having their call
 * sites rewritten, so `run.ts` keeps the import it has always had and the
 * engine swap is invisible above this line.
 *
 * The two modules naming each other is deliberate and is not a runtime cycle:
 * the repository imports only *types* from here, which erase at compile time,
 * while values travel the other way — out of the repository and through this
 * re-export.
 *
 * `query` is a plain parameter bag rather than a stored database filter, which
 * is the load-bearing decision in this shape: it is replayed through the same
 * `buildFilter` as `/api/search` on every read, so the server-forced
 * constraints (`libraryId`, `excludeHiddenPeople`, `isScreenshot`) are applied
 * at execution time and can never go stale in written data.
 */

import type { ObjectId } from 'mongodb';
import type { GeneratedQuery } from './validate.ts';

/** A collection as written by the worker. */
export interface GeneratedSearchInput {
  library_id: string;
  /** Local day this run targeted, `YYYY-MM-DD`. */
  generated_for: string;
  /** ISO 8601 write time. */
  generated_at: string;
  /** Provenance — which model proposed it. */
  model: string;
  /** How many proposal rounds it took to clear the result floor. */
  attempts: number;
  theme: string;
  title: string;
  subtitle: string | null;
  query: GeneratedQuery;
  result_count: number;
  cover_asset_id: string | null;
}

export interface GeneratedSearchDoc extends GeneratedSearchInput {
  _id: ObjectId;
}

export {
  saveGeneratedSearches,
  pruneGeneratedSearches,
} from '../../db/sqlite/repos/generated-searches.repo.ts';
