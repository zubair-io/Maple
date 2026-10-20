/**
 * POST /api/libraries/:id/backup/sidecar with `X-Maple-Sidecar-Base` — the
 * compare-and-swap re-send of a newer local edit (#4719). The device names the
 * sidecar version its edit was based on; a matching base overwrites, and a
 * mismatch still lands the incoming edit while the displaced version is kept in
 * `sidecar_divergences` instead of being lost.
 *
 * Real temp library files and a private SQLite database; each test writes its
 * own target path so the cases stay independent.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../src/db/object-id.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import { serializeSidecarWrite } from '../src/fs/sidecar-write-order.ts';

const deviceId = 'test-device-cas';

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;

interface DivergenceRow {
  asset_id: string;
  sidecar_rel_path: string;
  device_id: string;
  base_sha256: string | null;
  displaced_sha256: string;
  displaced_xmp: string;
  incoming_sha256: string;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const xmp = (label: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">${label}</x:xmpmeta>`;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-cas-test-'));
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, { path: tmpLib, label: 'sidecar-cas-test' });
  invalidateLibraryRoots();
});

afterAll(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

/** Seed one previously uploaded original; returns its rel path and phasset id. */
async function seedUpload(name: string): Promise<{ relPath: string; phid: string }> {
  const relPath = `2024/CAS/${name}.HEIC`;
  const phid = `CAS/${name}/L0/001`;
  const abs = path.join(tmpLib, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.alloc(64, 1));
  seedBackupAsset(live.db, {
    mapleId: createHash('md5').update(name).digest('hex'),
    size: 64,
    locations: [{ libraryId: libId, relPath }],
    links: [{ deviceId, phassetLocalId: phid }],
  });
  return { relPath, phid };
}

function post(
  target: { relPath: string; phid: string },
  body: string,
  base: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Maple-Device-Id': deviceId,
    'X-Maple-Phasset-Id': target.phid,
    'X-Maple-Target-Rel-Path': target.relPath,
  };
  if (base !== undefined) headers['X-Maple-Sidecar-Base'] = base;
  return authedHandle(
    new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/sidecar`, {
      method: 'POST',
      headers,
      body,
    }),
  );
}

const onDisk = (relPath: string) => fs.readFile(path.join(tmpLib, `${relPath}.xmp`), 'utf8');

function divergences(relPath: string): DivergenceRow[] {
  return live.db
    .query(
      `SELECT asset_id, sidecar_rel_path, device_id, base_sha256, displaced_sha256,
              displaced_xmp, incoming_sha256
         FROM sidecar_divergences WHERE sidecar_rel_path = ? ORDER BY rowid`,
    )
    .all(`${relPath}.xmp`) as DivergenceRow[];
}

describe('backup sidecar compare-and-swap (#4719)', () => {
  test('first send based on no prior version writes the sidecar', async () => {
    const target = await seedUpload('first');
    const res = await post(target, xmp('v1'), 'none');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target_rel_path: `${target.relPath}.xmp` });
    expect(await onDisk(target.relPath)).toBe(xmp('v1'));
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a newer edit based on the current version overwrites it', async () => {
    const target = await seedUpload('newer');
    expect((await post(target, xmp('v1'), 'none')).status).toBe(200);
    const res = await post(target, xmp('v2'), sha256(xmp('v1')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target_rel_path: `${target.relPath}.xmp` });
    expect(await onDisk(target.relPath)).toBe(xmp('v2'));
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a stale base still lands the edit and records the displaced version', async () => {
    const target = await seedUpload('stale');
    expect((await post(target, xmp('v1'), 'none')).status).toBe(200);
    expect((await post(target, xmp('other device'), sha256(xmp('v1')))).status).toBe(200);

    const res = await post(target, xmp('v2'), sha256(xmp('v1')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target_rel_path: `${target.relPath}.xmp`, diverged: true });
    expect(await onDisk(target.relPath)).toBe(xmp('v2'));
    const [row, ...rest] = divergences(target.relPath);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      sidecar_rel_path: `${target.relPath}.xmp`,
      device_id: deviceId,
      base_sha256: sha256(xmp('v1')),
      displaced_sha256: sha256(xmp('other device')),
      displaced_xmp: xmp('other device'),
      incoming_sha256: sha256(xmp('v2')),
    });
    expect(row?.asset_id).toMatch(/^[0-9a-f]{24}$/);
  });

  test("a first send over another device's sidecar lands on top and keeps theirs", async () => {
    const target = await seedUpload('dedup');
    expect((await post(target, xmp('device A'), undefined)).status).toBe(200);

    const res = await post(target, xmp('device B'), 'none');
    expect(res.status).toBe(200);
    expect((await res.json()).diverged).toBe(true);
    expect(await onDisk(target.relPath)).toBe(xmp('device B'));
    expect(divergences(target.relPath)).toMatchObject([
      { base_sha256: null, displaced_xmp: xmp('device A') },
    ]);
  });

  test('re-sending the version already on the server changes nothing', async () => {
    const target = await seedUpload('same');
    expect((await post(target, xmp('v1'), 'none')).status).toBe(200);
    const before = await fs.stat(path.join(tmpLib, `${target.relPath}.xmp`));

    const res = await post(target, xmp('v1'), 'none');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ target_rel_path: `${target.relPath}.xmp`, unchanged: true });
    const after = await fs.stat(path.join(tmpLib, `${target.relPath}.xmp`));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a client without the header keeps skip-if-exists (#698)', async () => {
    const target = await seedUpload('legacy');
    expect((await post(target, xmp('v1'), undefined)).status).toBe(200);
    const res = await post(target, xmp('v2'), undefined);
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
    expect(await onDisk(target.relPath)).toBe(xmp('v1'));
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a malformed base is rejected without touching the sidecar', async () => {
    const target = await seedUpload('malformed');
    expect((await post(target, xmp('v1'), 'none')).status).toBe(200);
    const res = await post(target, xmp('v2'), 'not-a-digest');
    expect(res.status).toBe(400);
    expect(await onDisk(target.relPath)).toBe(xmp('v1'));
  });

  test('two edits racing on the same base never lose a version', async () => {
    const target = await seedUpload('race');
    expect((await post(target, xmp('v1'), 'none')).status).toBe(200);
    const base = sha256(xmp('v1'));

    const [a, b] = await Promise.all([
      post(target, xmp('edit A'), base),
      post(target, xmp('edit B'), base),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const outcomes = [(await a.json()).diverged === true, (await b.json()).diverged === true];
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const final = await onDisk(target.relPath);
    const rows = divergences(target.relPath);
    expect(rows).toHaveLength(1);
    const displaced = final === xmp('edit B') ? xmp('edit A') : xmp('edit B');
    expect([xmp('edit A'), xmp('edit B')]).toContain(final);
    expect(rows[0]?.displaced_xmp).toBe(displaced);
  });

  test('a target path belonging to another asset is refused and its sidecar kept', async () => {
    const owner = await seedUpload('owner');
    const other = await seedUpload('other');
    expect((await post(other, xmp('theirs'), 'none')).status).toBe(200);

    const res = await post({ relPath: other.relPath, phid: owner.phid }, xmp('mine'), 'none');
    expect(res.status).toBe(404);
    expect(await onDisk(other.relPath)).toBe(xmp('theirs'));
    expect(divergences(other.relPath)).toEqual([]);
  });

  test('a sidecar reached through a symlink out of the library is never read or stored', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-cas-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'IMG.HEIC'), Buffer.alloc(64, 1));
      await fs.writeFile(path.join(outside, 'IMG.HEIC.xmp'), xmp('outside secret'));
      await fs.mkdir(path.join(tmpLib, '2024/CAS'), { recursive: true });
      await fs.symlink(outside, path.join(tmpLib, '2024/CAS/linked'));
      const relPath = '2024/CAS/linked/IMG.HEIC';
      const phid = 'CAS/linked/L0/001';
      seedBackupAsset(live.db, {
        mapleId: createHash('md5').update('linked').digest('hex'),
        size: 64,
        locations: [{ libraryId: libId, relPath }],
        links: [{ deviceId, phassetLocalId: phid }],
      });

      const res = await post({ relPath, phid }, xmp('incoming'), 'none');
      expect(res.status).not.toBe(200);
      expect(divergences(relPath)).toEqual([]);
      expect(await fs.readFile(path.join(outside, 'IMG.HEIC.xmp'), 'utf8')).toBe(
        xmp('outside secret'),
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('a location marked missing is not a valid target', async () => {
    const target = await seedUpload('missing');
    live.db
      .query(`UPDATE asset_locations SET missing_since = ? WHERE filename = ?`)
      .run(new Date().toISOString(), 'missing.HEIC');

    const res = await post(target, xmp('v1'), 'none');
    expect(res.status).toBe(404);
    await expect(onDisk(target.relPath)).rejects.toThrow();
  });

  test('a legacy upload waits its turn on the sidecar write barrier', async () => {
    const target = await seedUpload('legacy-barrier');
    const sidecar = path.join(tmpLib, `${target.relPath}.xmp`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holder = serializeSidecarWrite(sidecar, async () => {
      entered();
      await held;
      await fs.writeFile(sidecar, xmp('edit'));
    });
    await inside;

    const legacy = post(target, xmp('legacy'), undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(fs.access(sidecar)).rejects.toThrow();

    release();
    await holder;
    const res = await legacy;
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
    expect(await onDisk(target.relPath)).toBe(xmp('edit'));
  });

  test('a publish that fails leaves no divergence row behind (#5023)', async () => {
    const target = await seedUpload('failed-publish');
    expect((await post(target, xmp('v1'), 'none')).status).toBe(200);
    expect((await post(target, xmp('other device'), sha256(xmp('v1')))).status).toBe(200);
    const dir = path.dirname(path.join(tmpLib, target.relPath));
    await fs.chmod(dir, 0o555);
    try {
      const res = await post(target, xmp('v2'), sha256(xmp('v1')));
      expect(res.status).toBe(500);
    } finally {
      await fs.chmod(dir, 0o755);
    }
    expect(await onDisk(target.relPath)).toBe(xmp('other device'));
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a legacy upload through an outward symlink is a 400 and creates nothing outside (#5023)', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-legacy-outside-'));
    try {
      await fs.mkdir(path.join(tmpLib, '2024/CAS'), { recursive: true });
      await fs.symlink(outside, path.join(tmpLib, '2024/CAS/legacy-link'));
      const owner = await seedUpload('legacy-link-owner');
      const res = await post(
        { relPath: '2024/CAS/legacy-link/new/IMG.HEIC', phid: owner.phid },
        xmp('incoming'),
        undefined,
      );
      expect(res.status).toBe(400);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('a legacy upload whose folder becomes an outward symlink while it waits is a 400 (#5023)', async () => {
    const { status, outside } = await swapFolderWhileQueued('swapped/IMG', undefined);
    expect(status).toBe(400);
    expect(outside).toEqual([]);
  });

  test('a CAS upload whose folder becomes an outward symlink while it waits is a 400 (#5023)', async () => {
    const { status, outside, relPath } = await swapFolderWhileQueued('cas-swapped/IMG', 'none');
    expect(status).toBe(400);
    expect(outside).toEqual(['IMG.HEIC.xmp']);
    expect(divergences(relPath)).toEqual([]);
  });
});

/**
 * Holds the sidecar's write barrier, sends an upload, swaps the photo's folder
 * for a symlink to an outside folder (already holding the same XMP when a base
 * is sent), then releases. Returns the status and the outside folder's files.
 */
async function swapFolderWhileQueued(
  name: string,
  base: string | undefined,
): Promise<{ status: number; outside: string[]; relPath: string }> {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-swap-'));
  let release = (): void => {};
  try {
    const target = await seedUpload(name);
    if (base !== undefined) await fs.writeFile(path.join(outside, 'IMG.HEIC.xmp'), xmp('incoming'));
    const folder = path.dirname(path.join(tmpLib, target.relPath));
    const sidecar = path.join(tmpLib, `${target.relPath}.xmp`);
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holder = serializeSidecarWrite(sidecar, async () => {
      entered();
      await held;
    });
    await inside;

    const upload = post(target, xmp('incoming'), base);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fs.rm(folder, { recursive: true, force: true });
    await fs.symlink(outside, folder);
    release();
    await holder;
    const status = (await upload).status;
    return { status, outside: await fs.readdir(outside), relPath: target.relPath };
  } finally {
    release();
    await fs.rm(outside, { recursive: true, force: true });
  }
}
