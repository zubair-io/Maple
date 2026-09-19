/**
 * DELETE /api/assets/:id — the dual-mode trash / permanent-purge route.
 *
 * Drives the composed app, so the database has to be the process-wide one:
 * `createLiveTestDatabase()` installs a private in-memory SQLite database for
 * the file and puts the previous handle back on the way out (#3787). Real
 * files in a private temp directory; no external service, so nothing to skip
 * on.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { signAccessToken } from '../src/auth/tokens.ts';
import { newObjectIdHex } from '../src/db/object-id.ts';
import { setMeilisearchClientForTests } from '../src/enrichment/meilisearch-client.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';
import {
  assetRow,
  capturingMeili,
  failingMeili,
  primaryAbsPath,
  registerLibrary,
  seedRouteAsset,
} from './helpers/assets-route-fixtures.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`, which
// rules out `withTestEnv` here: its write happens in `beforeAll`, and the
// token below is signed while this module body runs.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const BEARER =
  'Bearer ' +
  (await signAccessToken(
    {
      file_access: true,
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
    },
    process.env.MAPLE_JWT_SECRET,
  ));

// Minted at module load so `withTestEnv` has a value to scope; removed in
// `afterAll`.
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp3-delete-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let libraryId: string;

/** One asset on disk and in the catalog, under `2024/`. */
async function makeAsset(
  filename: string,
  content: Buffer,
  opts?: { mapleId?: string },
): Promise<{ assetId: string; absPath: string }> {
  const absPath = path.join(ROOT, '2024', filename);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
  const assetId = seedRouteAsset(live.db, {
    libraryId,
    path: '2024',
    filename,
    size: content.byteLength,
    mapleId: opts?.mapleId ?? null,
  });
  return { assetId, absPath };
}

function del(assetId: string): Request {
  return new Request(`http://localhost/api/assets/${assetId}`, {
    method: 'DELETE',
    headers: { Authorization: BEARER },
  });
}

describe('DELETE /api/assets/:id (trash + permanent purge)', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    libraryId = registerLibrary(live.db, ROOT, 'delete-trash');
  });

  afterAll(async () => {
    live.close();
    setMeilisearchClientForTests(null);
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset the meili mock before every test so calls don't leak across
    // cases. Individual tests reinstall a capturing mock when needed.
    setMeilisearchClientForTests(null);
  });

  test('moves RAW + sidecar to trash; sets deleted_at + original_path', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId, absPath } = await makeAsset('IMG_1.ARW', Buffer.from('raw'));
    await fs.writeFile(absPath.replace(/\.ARW$/, '.xmp'), 'canon');
    await fs.writeFile(absPath.replace(/\.ARW$/, ' (conflict from Mac).xmp'), 'conflict');

    const res = await app.handle(del(assetId));
    expect(res.status).toBe(204);

    // Files gone from original.
    await expect(fs.stat(absPath)).rejects.toThrow();
    await expect(fs.stat(absPath.replace(/\.ARW$/, '.xmp'))).rejects.toThrow();
    await expect(fs.stat(absPath.replace(/\.ARW$/, ' (conflict from Mac).xmp'))).rejects.toThrow();

    // Files present in trash, mirrored relative path.
    const trashRaw = path.join(ROOT, '.maple', 'trash', '2024', 'IMG_1.ARW');
    await fs.stat(trashRaw);
    await fs.stat(path.join(ROOT, '.maple', 'trash', '2024', 'IMG_1.xmp'));
    await fs.stat(path.join(ROOT, '.maple', 'trash', '2024', 'IMG_1 (conflict from Mac).xmp'));

    // Catalog row flipped, and its location repointed at the trash copy.
    const row = assetRow(live.db, assetId);
    expect(row!.deleted_at).toBeTruthy();
    expect(row!.original_path).toBe(absPath);
    expect(primaryAbsPath(live.db, ROOT, assetId)).toBe(trashRaw);
  });

  test('DELETE on already-trashed asset permanently purges file + row', async () => {
    const { app } = await import('../src/index.ts');
    const { assetId } = await makeAsset('IMG_2.ARW', Buffer.from('raw'));
    await app.handle(del(assetId));

    const trashRaw = primaryAbsPath(live.db, ROOT, assetId)!;
    await fs.stat(trashRaw);

    const res = await app.handle(del(assetId));
    expect(res.status).toBe(204);

    await expect(fs.stat(trashRaw)).rejects.toThrow();
    expect(assetRow(live.db, assetId)).toBeNull();
  });

  test('soft-delete tombstones the asset in Meilisearch when maple_id is present', async () => {
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import('../src/index.ts');
    const mapleId = 'deadbeefdeadbeef';
    const { assetId } = await makeAsset('IMG_meili1.ARW', Buffer.from('raw'), { mapleId });

    const res = await app.handle(del(assetId));
    expect(res.status).toBe(204);
    expect(meili.tombstones).toEqual([mapleId]);
    expect(meili.upserts).toEqual([]);
  });

  test('soft-delete skips Meilisearch when maple_id is absent (legacy row)', async () => {
    const meili = capturingMeili();
    setMeilisearchClientForTests(meili);
    const { app } = await import('../src/index.ts');
    const { assetId } = await makeAsset('IMG_meili2.ARW', Buffer.from('raw'));

    const res = await app.handle(del(assetId));
    expect(res.status).toBe(204);
    expect(meili.tombstones).toEqual([]);
  });

  test('soft-delete 204s even when Meilisearch throws', async () => {
    setMeilisearchClientForTests(failingMeili(['tombstone']));
    const { app } = await import('../src/index.ts');
    const { assetId, absPath } = await makeAsset('IMG_meili3.ARW', Buffer.from('raw'), {
      mapleId: 'abc123',
    });

    const res = await app.handle(del(assetId));
    expect(res.status).toBe(204);
    // Catalog state still flipped despite the Meilisearch failure.
    const row = assetRow(live.db, assetId);
    expect(row!.deleted_at).toBeTruthy();
    expect(row!.original_path).toBe(absPath);
  });

  test('404 on unknown asset id', async () => {
    const { app } = await import('../src/index.ts');
    const res = await app.handle(del(newObjectIdHex()));
    expect(res.status).toBe(404);
  });
});
