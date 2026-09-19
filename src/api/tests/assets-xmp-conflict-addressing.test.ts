/**
 * GET / PUT / DELETE /api/assets/:id/xmp?conflict=<basename>
 *
 * Verifies the conflict-addressing query parameter:
 *   - GET reads the specific conflict file (404 if absent or invalid)
 *   - PUT unconditionally overwrites the named conflict file, no precondition
 *   - DELETE removes the named conflict file (idempotent; 204 if absent)
 *   - Invalid basenames (traversal, wrong asset, malformed suffix) return 404
 *
 * Real files in a private temp directory, and one real SQLite database
 * installed as the process-wide handle for the file (#3787). No external
 * service, so nothing to skip on.
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

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp2-confaddr-')));
withTestEnv('MAPLE_ROOTS', ROOT);

const rawPath = path.join(ROOT, 'IMG_1.ARW');
const conflictXmpPath = path.join(ROOT, 'IMG_1 (conflict from MacBook).xmp');

let live: LiveTestDatabase;
let assetId: string;

async function call(
  method: 'GET' | 'PUT' | 'DELETE',
  query: string,
  body?: string,
): Promise<Response> {
  const { assetsRoutes } = await import('../src/routes/assets.ts');
  const url = `http://test/api/assets/${assetId}/xmp${query}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'text/plain' };
    init.body = body;
  }
  return assetsRoutes.handle(new Request(url, init));
}

describe('XMP routes — ?conflict=<basename> addressing', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, ROOT, 'xmp-conflict-addr');
    assetId = seedRouteAsset(live.db, { libraryId, path: '', filename: 'IMG_1.ARW' });
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
    await fs.writeFile(conflictXmpPath, '<x:xmpmeta>conflict-v1</x:xmpmeta>');
  });

  afterAll(async () => {
    live.close();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('GET ?conflict=<basename> reads the specific conflict file', async () => {
    const res = await call(
      'GET',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('conflict-v1');
  });

  it('PUT ?conflict=<basename> overwrites unconditionally, no precondition needed', async () => {
    const res = await call(
      'PUT',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
      '<x:xmpmeta>conflict-v2</x:xmpmeta>',
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('last-modified')).toBeTruthy();
    const onDisk = await fs.readFile(conflictXmpPath, 'utf8');
    expect(onDisk).toContain('conflict-v2');
  });

  it('DELETE ?conflict=<basename> removes the specific conflict file', async () => {
    const res = await call(
      'DELETE',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
    );
    expect(res.status).toBe(204);
    await expect(fs.access(conflictXmpPath)).rejects.toThrow();
    await fs.access(rawPath); // RAW must still exist.
  });

  it('DELETE ?conflict=<basename> is idempotent (returns 204 when absent)', async () => {
    // Already deleted above.
    const res = await call(
      'DELETE',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook)'),
    );
    expect(res.status).toBe(204);
  });

  it('rejects path-traversal in the conflict basename', async () => {
    const res = await call('GET', '?conflict=' + encodeURIComponent('../etc/passwd'));
    expect(res.status).toBe(404);
  });

  it('rejects wrong-asset basenames', async () => {
    // Basename matches the conflict-suffix pattern but for a DIFFERENT raw.
    const res = await call(
      'GET',
      '?conflict=' + encodeURIComponent('IMG_2 (conflict from MacBook)'),
    );
    expect(res.status).toBe(404);
  });

  it('PUT ?conflict=<numbered-variant> works for pickFreeConflictPath output', async () => {
    // Numbered variant from pickFreeConflictPath collision handling.
    const res = await call(
      'PUT',
      '?conflict=' + encodeURIComponent('IMG_1 (conflict from MacBook) (2)'),
      '<x:xmpmeta>numbered</x:xmpmeta>',
    );
    expect(res.status).toBe(204);
    const expected = path.join(ROOT, 'IMG_1 (conflict from MacBook) (2).xmp');
    const onDisk = await fs.readFile(expected, 'utf8');
    expect(onDisk).toContain('numbered');
  });
});
