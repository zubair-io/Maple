/**
 * POST /api/libraries/:id/backup/sidecar with `X-Maple-Sidecar-Head` or
 * `X-Maple-Sidecar-Base` — the compare-and-swap re-send of a newer local edit
 * (#4719). The device names the sidecar version its edit was based on; a matching
 * base replaces the adjustments, and a mismatch is reconciled onto the stored
 * sidecar through its edit history (#5796) instead of being parked aside.
 *
 * Real temp library files and a private SQLite database; each test writes its
 * own target path so the cases stay independent.
 */
import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { seedBackupAsset } from './helpers/sqlite-fixtures.ts';
import { serializeSidecarWrite } from '../src/fs/sidecar-write-order.ts';
import { xmpSidecarPath } from '../src/fs/xmp.ts';
import {
  deviceId,
  history,
  labelOf,
  sha256,
  useSidecarLibrary,
  xmp,
} from './helpers/backup-sidecar-fixtures.ts';

const lib = useSidecarLibrary();
const { seedUpload, post, onDisk, divergences, firstSend } = lib;

describe('backup sidecar compare-and-swap (#4719, #5796)', () => {
  test('first send based on no prior version writes the sidecar with a one-entry history', async () => {
    const target = await seedUpload('first');
    const res = await post(target, xmp('v1'), 'none');
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { target_rel_path: string; head: string };
    expect(reply.target_rel_path).toBe(xmpSidecarPath(target.relPath));
    const stored = await onDisk(target.relPath);
    expect(labelOf(stored)).toBe('v1');
    expect(stored).toContain('xmlns:test="https://example.test/ns/1.0/"');
    const rows = await history(stored);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: reply.head, action: 'adjustment', writer: 'backup' });
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a newer edit based on the head replaces the adjustments and extends the history', async () => {
    const target = await seedUpload('newer');
    const first = await firstSend(target, xmp('v1'));
    const res = await post(target, xmp('v2'), undefined, first.head);
    expect(res.status).toBe(200);
    const reply = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(reply).sort()).toEqual(['head', 'target_rel_path']);
    const stored = await onDisk(target.relPath);
    expect(labelOf(stored)).toBe('v2');
    const rows = await history(stored);
    expect(rows.map((row) => row.id)).toEqual([first.head, reply.head as string]);
    expect(rows[1]?.parentId).toBe(first.head);
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a client that names only the digest of what it sent still replaces its own head', async () => {
    const target = await seedUpload('digest-fresh');
    await firstSend(target, xmp('v1'));
    const res = await post(target, xmp('v2'), sha256(xmp('v1')));
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['head', 'target_rel_path']);
    expect(labelOf(await onDisk(target.relPath))).toBe('v2');
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('re-sending the version already on the server changes nothing', async () => {
    const target = await seedUpload('same');
    const first = await firstSend(target, xmp('v1'));
    const before = await fs.stat(path.join(lib.tmpLib, xmpSidecarPath(target.relPath)));

    const res = await post(target, xmp('v1'), 'none');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target_rel_path: xmpSidecarPath(target.relPath),
      unchanged: true,
      head: first.head,
    });
    const after = await fs.stat(path.join(lib.tmpLib, xmpSidecarPath(target.relPath)));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('a client without the headers keeps skip-if-exists (#698)', async () => {
    const target = await seedUpload('legacy');
    expect((await post(target, xmp('v1'), undefined)).status).toBe(200);
    const res = await post(target, xmp('v2'), undefined);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skipped?: boolean }).skipped).toBe(true);
    expect(await onDisk(target.relPath)).toBe(xmp('v1'));
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a malformed base or head is rejected without touching the sidecar', async () => {
    const target = await seedUpload('malformed');
    const first = await firstSend(target, xmp('v1'));
    expect((await post(target, xmp('v2'), 'not-a-digest')).status).toBe(400);
    expect((await post(target, xmp('v2'), undefined, 'not-an-entry-id')).status).toBe(400);
    expect(await onDisk(target.relPath)).toBe(first.stored);
  });

  test('a body that is not an XMP document is rejected without touching the sidecar', async () => {
    const target = await seedUpload('not-xmp');
    const first = await firstSend(target, xmp('v1'));
    const res = await post(target, 'not xml at all', undefined, first.head);
    expect(res.status).toBe(400);
    expect(await onDisk(target.relPath)).toBe(first.stored);
  });

  test('a target path belonging to another asset is refused and its sidecar kept', async () => {
    const owner = await seedUpload('owner');
    const other = await seedUpload('other');
    expect((await post(other, xmp('theirs'), 'none')).status).toBe(200);
    const theirs = await onDisk(other.relPath);

    const res = await post({ relPath: other.relPath, phid: owner.phid }, xmp('mine'), 'none');
    expect(res.status).toBe(404);
    expect(await onDisk(other.relPath)).toBe(theirs);
    expect(divergences(other.relPath)).toEqual([]);
  });

  test('a sidecar reached through a symlink out of the library is never read or stored', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-cas-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'IMG.HEIC'), Buffer.alloc(64, 1));
      await fs.writeFile(path.join(outside, 'IMG.xmp'), xmp('outside secret'));
      await fs.mkdir(path.join(lib.tmpLib, '2024/CAS'), { recursive: true });
      await fs.symlink(outside, path.join(lib.tmpLib, '2024/CAS/linked'));
      const relPath = '2024/CAS/linked/IMG.HEIC';
      const phid = 'CAS/linked/L0/001';
      seedBackupAsset(lib.live.db, {
        mapleId: createHash('md5').update('linked').digest('hex'),
        size: 64,
        locations: [{ libraryId: lib.libId, relPath }],
        links: [{ deviceId, phassetLocalId: phid }],
      });

      const res = await post({ relPath, phid }, xmp('incoming'), 'none');
      expect(res.status).not.toBe(200);
      expect(divergences(relPath)).toEqual([]);
      expect(await fs.readFile(path.join(outside, 'IMG.xmp'), 'utf8')).toBe(xmp('outside secret'));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('a location marked missing is not a valid target', async () => {
    const target = await seedUpload('missing');
    lib.live.db
      .query(`UPDATE asset_locations SET missing_since = ? WHERE filename = ?`)
      .run(new Date().toISOString(), 'missing.HEIC');

    const res = await post(target, xmp('v1'), 'none');
    expect(res.status).toBe(404);
    await expect(onDisk(target.relPath)).rejects.toThrow();
  });

  test('a legacy upload waits its turn on the sidecar write barrier', async () => {
    const target = await seedUpload('legacy-barrier');
    const sidecar = path.join(lib.tmpLib, xmpSidecarPath(target.relPath));
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

  test('a sibling that arrives while a send waits on the barrier still shares the sidecar (#4692)', async () => {
    const target = await seedUpload('late-sibling');
    const sidecar = path.join(lib.tmpLib, xmpSidecarPath(target.relPath));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holder = serializeSidecarWrite(sidecar, async () => {
      entered();
      await held;
      await fs.writeFile(path.join(lib.tmpLib, '2024/CAS/late-sibling.cr2'), Buffer.alloc(8));
      await fs.writeFile(sidecar, xmp('sibling edit'));
    });
    await inside;

    const send = post(target, xmp('incoming'), 'none');
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await holder;
    const res = await send;

    expect(await res.json()).toEqual({
      target_rel_path: xmpSidecarPath(target.relPath),
      shared: true,
    });
    expect(await onDisk(target.relPath)).toBe(xmp('sibling edit'));
  });

  for (const base of ['none', undefined] as const) {
    test(`a ${base ? 'compare-and-swap' : 'no-base'} send whose location goes away while it waits writes nothing`, async () => {
      const target = await seedUpload(`gone-while-queued-${base ?? 'legacy'}`);
      const sidecar = path.join(lib.tmpLib, xmpSidecarPath(target.relPath));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      const holder = serializeSidecarWrite(sidecar, async () => {
        entered();
        await held;
      });
      await inside;

      const send = post(target, xmp('stale'), base);
      await new Promise((resolve) => setTimeout(resolve, 200));
      lib.live.db
        .query(`UPDATE asset_locations SET deleted_at = ? WHERE path || '/' || filename = ?`)
        .run(new Date().toISOString(), target.relPath);
      release();
      await holder;
      const res = await send;

      expect(res.status).toBe(404);
      await expect(fs.access(sidecar)).rejects.toThrow();
    });
  }

  test('a publish that fails leaves the sidecar and its history as they were (#5023)', async () => {
    const target = await seedUpload('failed-publish');
    const first = await firstSend(target, xmp('v1', { exposure: '0' }));
    await post(target, xmp('other device', { exposure: '1' }), undefined, first.head);
    const before = await onDisk(target.relPath);
    const dir = path.dirname(path.join(lib.tmpLib, target.relPath));
    await fs.chmod(dir, 0o555);
    try {
      const res = await post(target, xmp('v2', { exposure: '2' }), undefined, first.head);
      expect(res.status).toBe(500);
    } finally {
      await fs.chmod(dir, 0o755);
    }
    expect(await onDisk(target.relPath)).toBe(before);
    expect(divergences(target.relPath)).toEqual([]);
  });

  test('a legacy upload through an outward symlink is a 400 and creates nothing outside (#5023)', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-legacy-outside-'));
    try {
      await fs.mkdir(path.join(lib.tmpLib, '2024/CAS'), { recursive: true });
      await fs.symlink(outside, path.join(lib.tmpLib, '2024/CAS/legacy-link'));
      // Only the database row: writing the original would itself follow the link.
      const relPath = '2024/CAS/legacy-link/new/IMG.HEIC';
      const phid = 'CAS/legacy-link-owner/L0/001';
      seedBackupAsset(lib.live.db, {
        mapleId: createHash('md5').update('legacy-link-owner').digest('hex'),
        size: 64,
        locations: [{ libraryId: lib.libId, relPath }],
        links: [{ deviceId, phassetLocalId: phid }],
      });
      const res = await post({ relPath, phid }, xmp('incoming'), undefined);
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
    expect(outside).toEqual(['IMG.xmp']);
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
    if (base !== undefined) await fs.writeFile(path.join(outside, 'IMG.xmp'), xmp('incoming'));
    const folder = path.dirname(path.join(lib.tmpLib, target.relPath));
    const sidecar = path.join(lib.tmpLib, xmpSidecarPath(target.relPath));
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
