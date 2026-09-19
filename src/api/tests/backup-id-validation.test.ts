/**
 * The `maple_id` contract across the four backup upload routes.
 *
 * A malformed id must be refused before anything is written — no upload
 * session, no asset row — while a well-formed one in the wrong case is
 * normalised, so resume, retry and dedup all resolve to the same row.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for the test (#3787), with the library rooted at a tmp directory. The routes
 * are mounted on their own Elysia app because this test is about the id
 * contract, not about auth.
 */
import { test, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupIngestRoutes } from '../src/routes/backup-ingest.ts';
import { backupRenderedRoutes } from '../src/routes/backup-rendered.ts';
import { backupExistsRoutes } from '../src/routes/backup-exists.ts';
import { backupSidecarRoutes } from '../src/routes/backup-sidecar.ts';
import { createLiveTestDatabase } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedLibrary } from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';

test('invalid IDs never advance uploads; normalized IDs preserve resume, retry and dedup', async () => {
  const live = await createLiveTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'maple-id-upload-'));
  try {
    const libraryId = seedLibrary(live.db, { path: root, label: 'id-validation' });
    invalidateLibraryRoots();

    const countRows = (table: 'assets' | 'upload_sessions'): number =>
      (live.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const onlyRow = (table: 'assets' | 'upload_sessions'): Record<string, unknown> | null =>
      (live.db.query(`SELECT * FROM ${table}`).get() ?? null) as Record<string, unknown> | null;

    const app = new Elysia()
      .use(backupIngestRoutes)
      .use(backupRenderedRoutes)
      .use(backupExistsRoutes)
      .use(backupSidecarRoutes);
    const id = '01' + 'ab'.repeat(15);
    const send = (
      route: string,
      mapleId: string | undefined,
      range = 'bytes 0-3/4',
      phid = 'test-photo',
    ) =>
      app.handle(
        new Request(`http://localhost/api/libraries/${libraryId}/backup/${route}`, {
          method: 'POST',
          body: new Uint8Array([1, 2]),
          headers: {
            'content-type': 'application/octet-stream',
            'x-maple-device-id': 'id-contract',
            'x-maple-phasset-id': phid,
            'x-maple-capture-date': '2024-03-15T10:30:00Z',
            'x-maple-filename': 'photo.HEIC',
            'x-maple-target-rel-path': '2024/Misc/photo.HEIC',
            'x-maple-total-bytes': '4',
            'content-range': range,
            ...(mapleId === undefined
              ? {}
              : { 'x-maple-maple-id': mapleId, 'x-maple-id': mapleId }),
          },
        }),
      );
    for (const route of ['ingest', 'rendered', 'sidecar']) {
      expect((await send(route, '01' + '0g'.repeat(15))).status).toBe(400);
      expect(countRows('upload_sessions')).toBe(0);
      expect(countRows('assets')).toBe(0);
    }
    expect((await send('ingest', undefined, 'bytes 0-1/4')).status).toBe(202);
    expect(onlyRow('upload_sessions')?.received_bytes).toBe(2);
    for (const value of [undefined, '01' + 'f!'.repeat(15)]) {
      expect((await send('ingest', value, 'bytes 2-3/4')).status).toBe(400);
      expect(onlyRow('upload_sessions')?.received_bytes).toBe(2);
    }
    const finished = await send('ingest', id.toUpperCase(), 'bytes 2-3/4');
    expect(finished.status).toBe(200);
    const result = await finished.json();
    expect(result.maple_id).toBe(id);
    expect(onlyRow('assets')?.maple_id).toBe(id);
    expect(onlyRow('upload_sessions')?.maple_id).toBe(id);
    expect(await readFile(join(root, result.target_rel_path))).toEqual(Buffer.from([1, 2, 1, 2]));
    expect((await send('ingest', id.toUpperCase(), 'bytes 2-3/4')).status).toBe(200);
    expect((await send('ingest', undefined, 'bytes 0-1/4', 'duplicate-photo')).status).toBe(202);
    expect((await send('ingest', id.toUpperCase(), 'bytes 2-3/4', 'duplicate-photo')).status).toBe(
      200,
    );
    expect(countRows('assets')).toBe(1);
    for (const ids of [[id.toUpperCase()], ['bad']]) {
      const response = await app.handle(
        new Request(`http://localhost/api/libraries/${libraryId}/backup/exists`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ maple_ids: ids }),
        }),
      );
      expect(response.status).toBe(ids[0] === 'bad' ? 400 : 200);
      await assertMissingIds(response);
    }
  } finally {
    live.close();
    invalidateLibraryRoots();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

async function assertMissingIds(response: Response) {
  if (response.status === 200) expect(await response.json()).toEqual({ missing: [] });
}
