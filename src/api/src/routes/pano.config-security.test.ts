/**
 * PUT /api/pano/config access control (#4743).
 *
 * The saved maple-cli binary and ONNX dylib are executed by the server, so the
 * route is owner-only and refuses any executable that resolves inside a
 * registered library root — including paths that do not exist yet but whose
 * ancestor is a symlink into a library. A path stored before the guard existed
 * is neutralised on read so it is never probed or run.
 *
 * Split out of pano.test.ts to keep that file under the line budget.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';

import { panoRoutes } from './pano.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { clearMirrorRoots } from '../fs/mirror-registry.ts';
import { replaceFolderDestinations } from '../cloud-backup/local-mirror-bridge.ts';
import { savePanoConfig } from '../pano/pano-config.repo.ts';

const app = new Elysia().use(fakeAuth()).use(panoRoutes);
const memberApp = new Elysia().use(fakeAuth({ role: 'member' })).use(panoRoutes);

let live: LiveTestDatabase;
let tmpDir = '';
let fakeCli = '';
let folderId: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-config-test-'));
  fakeCli = path.join(tmpDir, 'fake-maple-cli');
  await fs.writeFile(
    fakeCli,
    '#!/bin/sh\necho "      --features-engine <FEATURES_ENGINE>"\nexit 0\n',
  );
  await fs.chmod(fakeCli, 0o755);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  folderId = insertFolder(live.db, { path: libPath, slug: 'pano-config-lib' });
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
  clearMirrorRoots();
});

function getReq(url: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${url}`));
}

function putJson(url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function postJson(url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const STITCH_BODY = () => ({
  assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
  libraryId: folderId,
  options: { retention: 'keep', localAlign: 'mesh' },
});

describe('PUT /api/pano/config — owner gate and executable jail (#4743)', () => {
  it('refuses a member with 403 and leaves the saved config untouched', async () => {
    const res = await memberApp.handle(
      new Request('http://localhost/api/pano/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maple_cli_path: fakeCli, enabled: true }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await (await getReq('/api/pano/config')).json()) as {
      maple_cli_path: string | null;
    };
    expect(body.maple_cli_path).toBeNull();
  });

  it('members can still read the config', async () => {
    const res = await memberApp.handle(new Request('http://localhost/api/pano/config'));
    expect(res.status).toBe(200);
  });

  it('refuses a maple_cli_path inside a registered library root', async () => {
    const planted = path.join(tmpDir, 'lib', 'planted-cli');
    await fs.copyFile(fakeCli, planted);
    const res = await putJson('/api/pano/config', { maple_cli_path: planted, enabled: true });
    expect(res.status).toBe(400);
    const body = (await (await getReq('/api/pano/config')).json()) as {
      maple_cli_path: string | null;
    };
    expect(body.maple_cli_path).toBeNull();
  });

  it('refuses an ort_dylib_path inside a registered library root', async () => {
    const planted = path.join(tmpDir, 'lib', 'libonnxruntime.dylib');
    await fs.writeFile(planted, 'not a dylib');
    const res = await putJson('/api/pano/config', { ort_dylib_path: planted });
    expect(res.status).toBe(400);
  });

  it('refuses a not-yet-existing path whose ancestor is a symlink into a library', async () => {
    const alias = path.join(tmpDir, 'alias-to-lib');
    await fs.symlink(path.join(tmpDir, 'lib'), alias);
    try {
      const res = await putJson('/api/pano/config', {
        maple_cli_path: path.join(alias, 'future-cli'),
      });
      expect(res.status).toBe(400);
    } finally {
      await fs.unlink(alias);
    }
  });

  it('saves the canonical path, not the symlink it was typed through', async () => {
    const aliasDir = path.join(tmpDir, 'alias-outside');
    await fs.symlink(tmpDir, aliasDir);
    try {
      const typed = path.join(aliasDir, 'fake-maple-cli');
      const body = (await (
        await putJson('/api/pano/config', { maple_cli_path: typed })
      ).json()) as {
        maple_cli_path: string | null;
      };
      expect(body.maple_cli_path).toBe(await fs.realpath(fakeCli));
    } finally {
      await fs.unlink(aliasDir);
    }
  });

  it("refuses an executable inside a library's mirror root", async () => {
    const mirror = path.join(tmpDir, 'mirror');
    await fs.mkdir(mirror, { recursive: true });
    await replaceFolderDestinations(folderId, [{ path: mirror, enabled: true }]);
    const planted = path.join(mirror, 'mirrored-cli');
    await fs.copyFile(fakeCli, planted);
    const res = await putJson('/api/pano/config', { maple_cli_path: planted });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('mirror');
  });

  it('keeps refusing an executable under a mirror that has since been disabled', async () => {
    const mirror = path.join(tmpDir, 'paused-mirror');
    await fs.mkdir(mirror, { recursive: true });
    await replaceFolderDestinations(folderId, [{ path: mirror, enabled: false }]);
    const planted = path.join(mirror, 'mirrored-cli');
    await fs.copyFile(fakeCli, planted);
    await savePanoConfig({ maple_cli_path: planted, enabled: true });
    const got = (await (await getReq('/api/pano/config')).json()) as {
      maple_cli_path: string | null;
    };
    expect(got.maple_cli_path).toBeNull();
    expect((await putJson('/api/pano/config', { ort_dylib_path: planted })).status).toBe(400);
  });

  it('neutralises a previously stored library-root path instead of probing it', async () => {
    const planted = path.join(tmpDir, 'lib', 'legacy-cli');
    await fs.copyFile(fakeCli, planted);
    await savePanoConfig({ maple_cli_path: planted, enabled: true });

    const got = (await (await getReq('/api/pano/config')).json()) as {
      maple_cli_path: string | null;
      strategy_supported: boolean;
    };
    expect(got.maple_cli_path).toBeNull();
    expect(got.strategy_supported).toBe(false);

    const patched = (await (await putJson('/api/pano/config', { enabled: true })).json()) as {
      maple_cli_path: string | null;
    };
    expect(patched.maple_cli_path).toBeNull();

    const stitch = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(stitch.status).toBe(409);
  });
});
