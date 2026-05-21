/**
 * Shared helpers for the `backup-ingest-*.test.ts` files. Split out so
 * each test file stays under the file-size budget (#114).
 *
 * Exposes:
 * - `makeIngestRequest(libId)`  — request builder bound to a library id.
 * - `setupBackupIngestSuite(opts)` — beforeAll/afterAll wiring for a
 *   single `describe` block. Creates a fresh tmp library directory, an
 *   accompanying `foldersCollection` doc, cleans the suite's deviceId
 *   from `assetsCollection` + `uploadSessionsCollection`, and (when
 *   opted in via `withTokyoGeocode`) primes the geocode cache so the
 *   happy-path GPS test can resolve `(35.68, 139.69) → "Tokyo"`.
 *
 * Each split test file should pick a UNIQUE `deviceId` so the suites can
 * run in parallel without wiping each other's `assetsCollection` rows
 * during their respective beforeAlls.
 */

import { ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assetsCollection,
  foldersCollection,
  geocodeCacheCollection,
  uploadSessionsCollection,
} from '../src/db/client.ts';
import { quantizedKey } from '../src/enrichment/coordinate-cache.ts';

export interface BackupIngestSuiteHandle {
  /** Library `_id` — used in the URL the request builder produces. */
  readonly libId: ObjectId;
  /** Absolute path to the per-suite tmp library directory. */
  tmpLib: string;
}

export interface BackupIngestSetupOptions {
  /** Per-suite device id. Pick something unique per file so parallel
   * suites don't clean each other's `assetsCollection` rows. */
  readonly deviceId: string;
  /** Whether to insert the Tokyo geocode entry the happy-path GPS test
   * relies on (`(35.68, 139.69) → "Tokyo"`). Defaults to false so the
   * other suites don't pay for it. */
  readonly withTokyoGeocode?: boolean;
}

/** Build an `ingest()` helper bound to a library id. The returned
 * function constructs a `Request` to `POST /api/libraries/:id/backup/ingest`
 * with `application/octet-stream` plus whatever headers the caller
 * supplies. */
export function makeIngestRequest(libId: ObjectId) {
  return (body: Buffer, headers: Record<string, string>): Request =>
    new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body,
    });
}

/** Wire up the standard backup-ingest suite fixtures into a `describe`
 * block. The returned handle's `libId` is frozen at first creation, so
 * tests can capture it eagerly — but `tmpLib` is populated lazily inside
 * the beforeAll. */
export function setupBackupIngestSuite(opts: BackupIngestSetupOptions): {
  handle: BackupIngestSuiteHandle;
  beforeAll: () => Promise<void>;
  afterAll: () => Promise<void>;
} {
  const libId = new ObjectId();
  const handle: BackupIngestSuiteHandle = { libId, tmpLib: '' };

  return {
    handle,
    beforeAll: async () => {
      handle.tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-ingest-test-'));
      const folders = await foldersCollection();
      await folders.insertOne({
        _id: libId,
        path: handle.tmpLib,
        label: 'test',
        created_at: new Date(),
        file_count: 0,
      } as never);

      const assets = await assetsCollection();
      await assets.deleteMany({ 'phasset_links.device_id': opts.deviceId });
      const sessions = await uploadSessionsCollection();
      await sessions.deleteMany({ device_id: opts.deviceId });

      if (opts.withTokyoGeocode) {
        const geo = await geocodeCacheCollection();
        await geo.deleteOne({ _id: quantizedKey(35.68, 139.69) });
        await geo.insertOne({
          _id: quantizedKey(35.68, 139.69),
          place: {
            address: {} as never,
            pois: [{ name: 'Tokyo', category: 'place', type: 'city' }],
            rollups: { locality: 'Tokyo' } as never,
            search_blob: 'Tokyo',
          } as never,
          fetched_at: new Date(),
          geocoder_version: 1,
        } as never);
      }
    },
    afterAll: async () => {
      // Guard against beforeAll having failed (or not run) — tmpLib stays
      // empty in that case, and `fs.rm('')` would throw and mask the
      // original failure with a misleading teardown error.
      if (!handle.tmpLib) return;
      try {
        await fs.rm(handle.tmpLib, { recursive: true, force: true });
      } catch {
        // Teardown is best-effort; the OS will reclaim the tmpdir.
      }
    },
  };
}
