import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from '../fs/mirrored.ts';
import { clearMirrorRoots, snapshotMirrorRoots } from '../fs/mirror-registry.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { buildApp } from '../index.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

describe('mounted operator mirror routes and folder backup bridge', () => {
  let live: LiveTestDatabase;
  let directory: string;
  let primary: string;
  let mirror: string;
  let libraryId: string;
  let owner: string;
  let member: string;
  let previousSecret: string | undefined;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    clearMirrorRoots();
    live = await createLiveTestDatabase();
    directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-mirror-route-')));
    primary = join(directory, 'primary');
    mirror = join(directory, 'mirror');
    await fs.mkdir(primary);
    await fs.mkdir(mirror);
    libraryId = insertFolder(live.db, { path: primary });
    previousSecret = process.env.MAPLE_JWT_SECRET;
    const secret = 'mirror-route-owner-test-secret-long';
    process.env.MAPLE_JWT_SECRET = secret;
    owner = await signAccessToken(
      {
        sub: '111111111111111111111111',
        email: null,
        role: 'owner',
        file_access: true,
      },
      secret,
    );
    member = await signAccessToken(
      {
        sub: '222222222222222222222222',
        email: null,
        role: 'member',
        file_access: true,
      },
      secret,
    );
    app = buildApp({ stageNames: [] });
  });

  afterEach(async () => {
    await fs.flushPendingMirrorOps();
    clearMirrorRoots();
    await fs.rm(directory, { recursive: true, force: true });
    live.close();
    process.env.MAPLE_JWT_SECRET = previousSecret;
  });

  function request(url: string, method = 'GET', body?: unknown, token: string | null = owner) {
    return app.handle(
      new Request('http://localhost' + url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  function put(mirrors: Array<{ path: string; enabled: boolean }>, id = libraryId) {
    return request(`/api/folders/${id}/mirror`, 'PUT', { mirrors });
  }

  it('rejects unauthenticated and member access to every operator route', async () => {
    const routes = [
      { url: `/api/folders/${libraryId}/mirror`, method: 'GET' },
      {
        url: `/api/folders/${libraryId}/mirror`,
        method: 'PUT',
        body: { mirrors: [] },
      },
      { url: '/api/mirror/test', method: 'POST', body: { path: mirror } },
      { url: '/api/mirror/status', method: 'GET' },
      { url: '/api/mirror/retry-dead', method: 'POST', body: {} },
      { url: '/api/mirror/reconcile', method: 'POST', body: {} },
      { url: '/api/mirror/orphans', method: 'GET' },
    ];
    for (const route of routes) {
      expect((await request(route.url, route.method, route.body, null)).status, route.url).toBe(
        401,
      );
      expect((await request(route.url, route.method, route.body, member)).status, route.url).toBe(
        403,
      );
    }
    expect(await new BackupRepository(live.handle).destinations()).toEqual([]);
    // Local photo browsing remains member-readable; the plugin's owner gate is scoped.
    expect((await request('/api/folders', 'GET', undefined, member)).status).toBe(200);
  });

  it('returns consistent invalid and missing library errors for GET and PUT', async () => {
    for (const method of ['GET', 'PUT']) {
      const body = method === 'PUT' ? { mirrors: [] } : undefined;
      const invalid = await request('/api/folders/not-an-id/mirror', method, body);
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toBe('invalid folder id');
      const missing = await request('/api/folders/ffffffffffffffffffffffff/mirror', method, body);
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toBe('folder not found');
    }
  });

  it('bridges deduplicated folder targets into the existing mirror writer without changing Drive targets', async () => {
    const repo = new BackupRepository(live.handle);
    const drive = await repo.createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'Drive',
      path: null,
    });
    const offline = join(directory, 'offline');
    const response = await put([
      { path: mirror, enabled: true },
      { path: join(mirror, '.'), enabled: false },
      { path: offline, enabled: false },
    ]);
    expect(response.status).toBe(200);
    const mirrors = [
      { path: mirror, enabled: true },
      { path: offline, enabled: false },
    ];
    expect((await response.json()).mirrors).toEqual(mirrors);
    expect((await (await request(`/api/folders/${libraryId}/mirror`)).json()).mirrors).toEqual(
      mirrors,
    );
    const destinations = await repo.destinations();
    expect(
      destinations
        .filter((d) => d.kind === 'folder')
        .map((d) => ({ path: d.path, enabled: d.enabled })),
    ).toEqual(mirrors);
    expect(await repo.destination(drive.id)).toEqual(drive);
    expect(snapshotMirrorRoots()).toEqual({ [primary]: [mirror] });

    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><exact-sidecar-bytes/></x:xmpmeta>';
    const temporary = join(primary, 'photo.xmp.tmp.123');
    await fs.writeFile(temporary, xmp);
    await fs.rename(temporary, join(primary, 'photo.xmp'));
    await fs.flushPendingMirrorOps();
    expect(await fs.readFile(join(mirror, 'photo.xmp'), 'utf8')).toBe(xmp);
    expect(await repo.entries(drive.id)).toEqual([]);
  });

  it('migrates an existing folder mirror once and retains its destination identity when paused', async () => {
    run(
      live.db,
      'UPDATE folders SET mirrors=? WHERE id=?',
      JSON.stringify([{ path: mirror, enabled: true }]),
      libraryId,
    );
    expect((await put([{ path: mirror, enabled: true }])).status).toBe(200);
    const repo = new BackupRepository(live.handle);
    const before = (await repo.destinations())[0]!;
    expect((await put([{ path: mirror, enabled: false }])).status).toBe(200);
    const after = (await repo.destinations())[0]!;
    expect(after.id).toBe(before.id);
    expect(after.enabled).toBe(false);
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(snapshotMirrorRoots()).toEqual({});
    expect((await put([])).status).toBe(200);
    expect(await repo.destinations()).toEqual([]);
  });

  it.each(['same', 'child', 'parent', 'root', 'offline-child'])(
    'rejects a %s target overlapping the source before changing configuration',
    async (kind) => {
      const candidate = {
        same: primary,
        child: join(primary, 'nested'),
        parent: directory,
        root: '/',
        'offline-child': join(primary, 'offline'),
      }[kind]!;
      if (kind === 'child') await fs.mkdir(candidate);
      const response = await put([
        { path: mirror, enabled: true },
        { path: candidate, enabled: kind !== 'offline-child' },
      ]);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('overlaps the library');
      expect(await new BackupRepository(live.handle).destinations()).toEqual([]);
      expect(snapshotMirrorRoots()).toEqual({});
    },
  );

  it('rejects a symlink alias into the source even when the mirror is disabled', async () => {
    const nested = join(primary, 'nested');
    const alias = join(directory, 'alias');
    await fs.mkdir(nested);
    await fs.symlink(nested, alias);
    for (const enabled of [true, false]) {
      const response = await put([{ path: alias, enabled }]);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('overlaps the library');
    }
  });

  it('accepts a sibling whose name only shares the source prefix', async () => {
    const sibling = primary + '-backup';
    await fs.mkdir(sibling);
    expect((await put([{ path: sibling, enabled: true }])).status).toBe(200);
    expect(snapshotMirrorRoots()).toEqual({ [primary]: [sibling] });
  });

  it('validates enabled paths but retains offline mirrors when disabled', async () => {
    const file = join(directory, 'not-a-directory');
    const missing = join(directory, 'missing');
    await fs.writeFile(file, 'not a directory');
    for (const path of [file, missing]) {
      const response = await put([{ path, enabled: true }]);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('not a usable directory');
    }
    expect((await put([{ path: missing, enabled: false }])).status).toBe(200);
    expect(snapshotMirrorRoots()).toEqual({});
  });

  it('keeps a destination and its cleanup obligation when the legacy route tries to remove it', async () => {
    expect((await put([{ path: mirror, enabled: true }])).status).toBe(200);
    const repo = new BackupRepository(live.handle);
    const destination = (await repo.destinations())[0]!;
    await repo.db.write('INSERT INTO backup_purges(destination_id,entry_id,record) VALUES(?,?,?)', [
      destination.id,
      'purged-entry',
      '{}',
    ]);
    expect((await put([])).status).toBe(500);
    expect(await repo.destination(destination.id)).toEqual(destination);
    expect(await repo.purges(destination.id)).toHaveLength(1);
    expect(snapshotMirrorRoots()).toEqual({ [primary]: [mirror] });
  });
});
