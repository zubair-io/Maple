/**
 * PUT /api/assets/:id/xmp with X-If-Mtime-Matches:
 *  - omitted             → unconditional write, 204, Last-Modified set
 *  - matches on-disk     → atomic overwrite, 204, Last-Modified set
 *  - mismatches on-disk  → conflict-copy file written, 409 + JSON,
 *                          original untouched
 *
 * Real files in a private temp directory, and one real SQLite database
 * installed as the process-wide handle for the file (#3787) — the route
 * resolves the RAW's absolute path from `folders` + `asset_locations`, so both
 * have to be seeded where `sqliteDb()` will look. No external service, so
 * nothing to skip on.
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

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp2-conflict-')));
withTestEnv('MAPLE_ROOTS', ROOT);

const rawPath = path.join(ROOT, 'IMG_1.ARW');
const xmpPath = path.join(ROOT, 'IMG_1.xmp');

let live: LiveTestDatabase;
let assetId: string;

async function callPut(body: string, headers: Record<string, string> = {}): Promise<Response> {
  const { assetsRoutes } = await import('../src/routes/assets.ts');
  const url = `http://test/api/assets/${assetId}/xmp`;
  return assetsRoutes.handle(
    new Request(url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', ...headers },
      body,
    }),
  );
}

describe('PUT /api/assets/:id/xmp — conflict copies', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    const libraryId = registerLibrary(live.db, ROOT, 'xmp-conflict');
    assetId = seedRouteAsset(live.db, { libraryId, path: '', filename: 'IMG_1.ARW' });
    await fs.writeFile(rawPath, new Uint8Array([0xff, 0xd8, 0xff]));
  });

  afterAll(async () => {
    live.close();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('unconditional write returns 204 with Last-Modified', async () => {
    const res = await callPut('<x:xmpmeta>v1</x:xmpmeta>');
    expect(res.status).toBe(204);
    expect(res.headers.get('last-modified')).toBeTruthy();
    const onDisk = await fs.readFile(xmpPath, 'utf8');
    expect(onDisk).toContain('v1');
  });

  it('matching precondition overwrites atomically', async () => {
    const st = await fs.stat(xmpPath);
    const epoch = Math.floor(st.mtimeMs / 1000);
    const res = await callPut('<x:xmpmeta>v2</x:xmpmeta>', {
      'x-if-mtime-matches': String(epoch),
      'x-maple-device-name': 'test-mbp',
    });
    expect(res.status).toBe(204);
    const onDisk = await fs.readFile(xmpPath, 'utf8');
    expect(onDisk).toContain('v2');
    const dir = await fs.readdir(ROOT);
    expect(dir.some((f) => f.includes('conflict from'))).toBe(false);
  });

  it('mismatching precondition writes a conflict copy', async () => {
    const res = await callPut('<x:xmpmeta>v3-from-B</x:xmpmeta>', {
      'x-if-mtime-matches': '1',
      'x-maple-device-name': 'test-laptop-B',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      conflict_path: string;
      conflict_mtime: string;
    };
    expect(body.conflict_path).toContain('IMG_1 (conflict from test-laptop-B).xmp');
    const onDisk = await fs.readFile(body.conflict_path, 'utf8');
    expect(onDisk).toContain('v3-from-B');
    const orig = await fs.readFile(xmpPath, 'utf8');
    expect(orig).toContain('v2');
  });

  it("missing device name produces 'Unknown device' conflict file", async () => {
    const res = await callPut('<x:xmpmeta>v4</x:xmpmeta>', {
      'x-if-mtime-matches': '1',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflict_path: string };
    expect(body.conflict_path).toContain('(conflict from Unknown device)');
  });

  // #2532 — createItem's create-only precondition. Unlike the mtime headers
  // above (which model a modify that has a known — or deliberately absent —
  // prior version), this models Finder creating a sidecar it believes is
  // brand new. It must never silently clobber one that already exists.
  it('X-Maple-Require-Absent refuses to overwrite an existing sidecar (writes conflict copy instead)', async () => {
    const before = await fs.readFile(xmpPath, 'utf8'); // still "v2" from an earlier test
    const res = await callPut('<x:xmpmeta>from-a-create</x:xmpmeta>', {
      'x-maple-require-absent': 'true',
      'x-maple-device-name': 'test-create-device',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflict_path: string };
    expect(body.conflict_path).toContain('IMG_1 (conflict from test-create-device).xmp');
    const conflictContent = await fs.readFile(body.conflict_path, 'utf8');
    expect(conflictContent).toContain('from-a-create');
    const canonical = await fs.readFile(xmpPath, 'utf8');
    expect(canonical).toBe(before); // untouched
  });
});
