/**
 * routes/pano.ts with the maple-cli the Docker image bundles (#5493).
 *
 * The image names its binary in MAPLE_PANO_CLI. With nothing saved in
 * Settings > Pano, the server uses it and stitching defaults to on; a saved
 * path or a saved off switch still wins.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import fs from '../fs/mirrored.ts';
import os from 'node:os';
import path from 'node:path';

import { panoRoutes } from './pano.ts';
import { ObjectId } from '../db/object-id.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const app = new Elysia().use(fakeAuth()).use(panoRoutes);

let live: LiveTestDatabase;
let tmpDir = '';
let bundledCli = '';
let savedCli = '';
let folderId = '';
let ambientBundled: string | undefined;

async function writeScript(name: string, body: string): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}`);
  await fs.chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-bundled-')));
  bundledCli = await writeScript(
    'bundled-maple-cli',
    'case " $* " in *" --help "*) echo "      --features-engine <FEATURES_ENGINE>";; esac\nexit 0\n',
  );
  savedCli = await writeScript('saved-maple-cli', 'echo "Usage: maple-cli pano stitch"\nexit 0\n');
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  ambientBundled = process.env.MAPLE_PANO_CLI;
  process.env.MAPLE_PANO_CLI = bundledCli;
  live = await createLiveTestDatabase();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  folderId = insertFolder(live.db, { path: libPath, slug: 'pano-bundled-lib' });
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
  if (ambientBundled === undefined) delete process.env.MAPLE_PANO_CLI;
  else process.env.MAPLE_PANO_CLI = ambientBundled;
});

function send(method: string, url: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const STITCH_BODY = () => ({
  assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
  libraryId: folderId,
  options: { retention: 'keep', localAlign: 'mesh' },
});

describe('bundled maple-cli (#5493)', () => {
  it('reports a stock image as provisioned with the bundled binary', async () => {
    const body = (await (await send('GET', '/api/pano/config')).json()) as {
      enabled: boolean;
      maple_cli_path: string;
      source: { maple_cli_path: string; enabled: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.maple_cli_path).toBe(bundledCli);
    expect(body.source.maple_cli_path).toBe('bundled');
    expect(body.source.enabled).toBe('default');
  });

  it('stitches on a stock image with no saved settings', async () => {
    const res = await send('POST', '/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(201);
  });

  it('prefers the path saved in Settings > Pano over the bundled one', async () => {
    const res = await send('PUT', '/api/pano/config', { maple_cli_path: savedCli });
    const body = (await res.json()) as {
      maple_cli_path: string;
      source: { maple_cli_path: string };
    };
    expect(body.maple_cli_path).toBe(savedCli);
    expect(body.source.maple_cli_path).toBe('db');
  });

  it('stays off when the operator turned pano off', async () => {
    await send('PUT', '/api/pano/config', { enabled: false });
    const res = await send('POST', '/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('pano_not_provisioned');
  });
});
