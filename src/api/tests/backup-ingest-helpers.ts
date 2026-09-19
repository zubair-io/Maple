/**
 * Shared fixtures for the `backup-ingest-*.test.ts` files. Split out so each
 * test file stays under the file-size budget (#114).
 *
 * Exposes:
 * - `setupBackupIngestSuite(opts)` — the setup/teardown pair a `describe`
 *   block installs. Each call mints a tmp library directory and a private
 *   SQLite database installed as the process-wide handle (#3787), seeds the
 *   library row, and — when opted in via `withTokyoGeocode` — primes the
 *   geocode cache so the happy-path GPS test resolves
 *   `(35.68, 139.69) → Japan/Tokyo`.
 * - `makeIngestRequest(handle)` — request builder bound to a suite handle. It
 *   reads the library id at call time, because the library is seeded by the
 *   setup above rather than minted when the module loads.
 *
 * There is no cross-suite cleanup any more. The old beforeAll deleted this
 * suite's device rows out of a shared Mongo before it started and the afterAll
 * deleted them again afterwards; a private database that goes away with the
 * block makes both unnecessary, so what is left is the tmp directory and the
 * library-roots cache.
 */

import type { Database } from 'bun:sqlite';
import type { ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { setCachedPlace } from '../src/db/sqlite/repos/geocode-cache.repo.ts';
import { quantizedKey } from '../src/enrichment/coordinate-cache.ts';
import { GEOCODE_HANDLER_VERSION } from '../src/workers/stages/geocode.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { seedLibrary } from './helpers/sqlite-fixtures.ts';
import type { Place } from '../src/db/schema.ts';

/** The coordinate the happy-path GPS test sends, and the place it resolves to.
 * Warm in the cache, so the route never reaches for a live geocoder. */
const TOKYO_LAT = 35.68;
const TOKYO_LON = 139.69;

const TOKYO_PLACE: Place = {
  source: 'nominatim',
  geocoder_version: GEOCODE_HANDLER_VERSION,
  geocoded_at: '2024-03-15T10:30:00.000Z',
  lat: TOKYO_LAT,
  lon: TOKYO_LON,
  display_name: 'Tokyo, Japan',
  address: { country: 'Japan', country_code: 'jp' },
  pois: [{ name: 'Tokyo', category: 'place', type: 'city' }],
  rollups: { locality: 'Tokyo', region: null, country_code: 'jp' },
  search_blob: 'Tokyo Japan',
};

/** What a test reaches for between `setup` and `teardown`. Every member is a
 * getter so using one before the setup ran is a named error rather than an
 * undefined that surfaces three assertions later. */
export interface BackupIngestSuiteHandle {
  /** The library every request in the suite addresses. */
  readonly libId: ObjectId;
  /** Absolute path to the suite's tmp library directory. */
  readonly tmpLib: string;
  /** The suite's private database, for row assertions. */
  readonly db: Database;
}

export interface BackupIngestSuite {
  readonly handle: BackupIngestSuiteHandle;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
}

export interface BackupIngestSetupOptions {
  /** Whether to prime the Tokyo geocode entry the happy-path GPS test relies
   * on. Defaults to false so the other suites don't pay for it. */
  readonly withTokyoGeocode?: boolean;
}

/** Build an `ingest()` helper bound to a suite handle. The returned function
 * constructs a `Request` to `POST /api/libraries/:id/backup/ingest` with
 * `application/octet-stream` plus whatever headers the caller supplies. */
export function makeIngestRequest(handle: BackupIngestSuiteHandle) {
  return (body: Buffer, headers: Record<string, string>): Request =>
    new Request(`http://localhost/api/libraries/${handle.libId.toHexString()}/backup/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body: new Uint8Array(body),
    });
}

/** Wire up the standard backup-ingest fixtures for a `describe` block. */
export function setupBackupIngestSuite(opts: BackupIngestSetupOptions = {}): BackupIngestSuite {
  let live: LiveTestDatabase | null = null;
  let libId: ObjectId | null = null;
  let tmpLib = '';

  const notReady = (): never => {
    throw new Error('backup-ingest suite: setup() has not run');
  };

  const handle: BackupIngestSuiteHandle = {
    get libId() {
      return libId ?? notReady();
    },
    get tmpLib() {
      return tmpLib.length > 0 ? tmpLib : notReady();
    },
    get db() {
      return live?.db ?? notReady();
    },
  };

  return {
    handle,
    setup: async () => {
      tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-ingest-test-'));
      live = await createLiveTestDatabase();
      libId = seedLibrary(live.db, { path: tmpLib, label: 'ingest-test' });
      // The library-roots cache memoises folder rows; drop it so the freshly
      // seeded library resolves, and again on teardown so it doesn't outlive
      // the database it was read from.
      invalidateLibraryRoots();
      if (opts.withTokyoGeocode) {
        await setCachedPlace(
          quantizedKey(TOKYO_LAT, TOKYO_LON),
          TOKYO_PLACE,
          GEOCODE_HANDLER_VERSION,
        );
      }
    },
    teardown: async () => {
      live?.close();
      live = null;
      libId = null;
      invalidateLibraryRoots();
      // Guard against a setup that threw before `mkdtemp` returned — an
      // unguarded `fs.rm('')` would mask the original failure.
      const dir = tmpLib;
      tmpLib = '';
      if (dir.length === 0) return;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
