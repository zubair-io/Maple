/**
 * DELETE /api/assets/:id/xmp:
 *   - removes existing sidecar, 204
 *   - non-existent sidecar still returns 204 (idempotent)
 *   - never touches the paired RAW
 *
 * Real files in a private temp directory, and one real SQLite database
 * installed as the process-wide handle for the file (#3787) — the route
 * reaches `sqliteDb()` with no override, so the database has to be the
 * process's. Nothing external to reach, so nothing to skip on.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';
import { registerLibrary, seedRouteAsset } from './helpers/assets-route-fixtures.ts';

// The root has to exist before `withTestEnv` can scope the variable to it, and
// `withTestEnv` captures the prior value inside its own `beforeAll` — so the
// directory is minted at module load and the env write stays suite-scoped.
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp2-delete-')));
withTestEnv('MAPLE_ROOTS', ROOT);

const rawPath = path.join(ROOT, 'IMG_1.ARW');
const xmpPath = path.join(ROOT, 'IMG_1.xmp');

let live: LiveTestDatabase;
let assetId: string;

describe('DELETE /api/assets/:id/xmp', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, ROOT, 'xmp-delete');
    assetId = seedRouteAsset(live.db, {
      libraryId,
      path: '',
      filename: 'IMG_1.ARW',
    });
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
  });

  afterAll(async () => {
    live.close();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('removes an existing sidecar, returns 204, RAW untouched', async () => {
    await fs.writeFile(xmpPath, '<x:xmpmeta/>');
    const { assetsRoutes } = await import('../src/routes/assets.ts');
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId}/xmp`, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);
    await expect(fs.access(xmpPath)).rejects.toThrow();
    await fs.access(rawPath); // RAW must still exist.
  });

  it('non-existent sidecar is idempotent (returns 204)', async () => {
    const { assetsRoutes } = await import('../src/routes/assets.ts');
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId}/xmp`, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);
  });
});
