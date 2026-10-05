import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import {
  mkdir,
  writeFile,
  readFile,
  stat,
  copyFile,
  symlink,
  unlink,
  rename,
} from '../fs/mirrored.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import { drainPurges } from '../cloud-backup/purge.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

type Mode = 'route' | 'retention';
async function fixture(withMirror = true) {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  const mirror = path.join(f.root, 'mirror');
  const relativeOriginal = '.maple/trash/sub/photo.dng';
  const relativeCompanion = 'sub/photo-rendered.jpg';
  const original = path.join(library, relativeOriginal);
  const companion = path.join(library, relativeCompanion);
  const sidecar = path.join(library, '.maple/trash/sub/photo.xmp');
  for (const root of [library, mirror]) {
    await mkdir(path.join(root, '.maple/trash/sub'), { recursive: true });
    await mkdir(path.join(root, 'sub'), { recursive: true });
  }
  await writeFile(original, 'original-photo-bytes');
  await writeFile(companion, 'apple-rendered-photo-bytes');
  await writeFile(sidecar, '<x:xmpmeta>exact sidecar</x:xmpmeta>');
  for (const filename of [original, companion, sidecar])
    await copyFile(filename, path.join(mirror, path.relative(library, filename)));
  await writeFile(path.join(mirror, 'sub/unrelated.jpg'), 'unrelated-photo');
  const libraryId = insertFolder(f.live.db, { path: library });
  const id = insertAsset(f.live.db, { deletedAt: '2000-01-01T00:00:00Z' });
  insertLocation(f.live.db, {
    assetId: id,
    libraryId,
    path: '.maple/trash/sub',
    filename: 'photo.dng',
  });
  await backupEngine.repo.db.write(
    'UPDATE assets SET apple_rendered_path=?,original_path=? WHERE id=?',
    [relativeCompanion, 'sub/photo.dng', id],
  );
  const destination = withMirror
    ? await backupEngine.repo.createDestination({
        libraryId,
        kind: 'folder',
        name: 'Photo mirror',
        path: mirror,
      })
    : null;
  const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  return {
    ...f,
    library,
    mirror,
    original,
    companion,
    sidecar,
    id,
    destination,
    relativeCompanion,
    async purge(mode: Mode) {
      return mode === 'route'
        ? app.handle(
            new Request(`http://localhost/api/assets/${id}?intent=purge`, { method: 'DELETE' }),
          )
        : runTrashGcOnce({ retentionDays: 30 });
    },
  };
}

async function expectRemoved(filename: string) {
  await expect(stat(filename)).rejects.toThrow();
}

test.each(['route', 'retention'] as const)(
  '%s permanent purge removes the recorded Apple companion and its verified mirror copy',
  async (mode) => {
    const f = await fixture();
    try {
      const outcome = await f.purge(mode);
      if (outcome instanceof Response) expect(outcome.status).toBe(204);
      else expect(outcome).toEqual({ scanned: 1, purged: 1, errors: 0 });
      for (const filename of [f.original, f.companion, f.sidecar]) await expectRemoved(filename);
      expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).toBeNull();
      const [entry] = await backupEngine.repo.entries(f.destination!.id);
      expect(JSON.parse(entry!.manifest!).localFiles).toEqual(
        expect.arrayContaining([
          { path: f.relativeCompanion, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ]),
      );
      expect(f.live.db.query('SELECT completed FROM backup_purges').get()).toEqual({
        completed: 0,
      });
      await drainPurges(backupEngine, f.destination!);
      for (const filename of [f.original, f.companion, f.sidecar])
        await expectRemoved(path.join(f.mirror, path.relative(f.library, filename)));
      expect(await readFile(path.join(f.mirror, 'sub/unrelated.jpg'), 'utf8')).toBe(
        'unrelated-photo',
      );
      expect(f.live.db.query('SELECT completed FROM backup_purges').get()).toEqual({
        completed: 1,
      });
    } finally {
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s purge preserves a newer mirror file that reused the companion path and keeps erasure pending',
  async (mode) => {
    const f = await fixture();
    try {
      const mirrorCompanion = path.join(f.mirror, f.relativeCompanion);
      await writeFile(mirrorCompanion, 'new-unrelated-photo');
      await f.purge(mode);
      await expectRemoved(f.companion);
      await drainPurges(backupEngine, f.destination!);
      expect(await readFile(mirrorCompanion, 'utf8')).toBe('new-unrelated-photo');
      expect(f.live.db.query('SELECT completed,last_error FROM backup_purges').get()).toEqual({
        completed: 0,
        last_error: 'Destination cleanup requires retry',
      });
    } finally {
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s purge rejects outside-library and symlink companion paths before deleting originals or tracking rows',
  async (mode) => {
    const f = await fixture(false);
    try {
      const outside = path.join(f.root, 'outside.jpg');
      await writeFile(outside, 'outside-photo');
      await symlink(outside, path.join(f.library, 'sub/linked.jpg'));
      for (const relative of ['../outside.jpg', outside, 'sub/linked.jpg']) {
        await backupEngine.repo.db.write('UPDATE assets SET apple_rendered_path=? WHERE id=?', [
          relative,
          f.id,
        ]);
        const outcome = await f.purge(mode);
        if (outcome instanceof Response) expect(outcome.status).toBe(500);
        else expect(outcome).toEqual({ scanned: 1, purged: 0, errors: 1 });
        expect(await readFile(f.original, 'utf8')).toBe('original-photo-bytes');
        expect(await readFile(f.sidecar, 'utf8')).toBe('<x:xmpmeta>exact sidecar</x:xmpmeta>');
        expect(await readFile(outside, 'utf8')).toBe('outside-photo');
        expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).toEqual({ id: f.id });
      }
    } finally {
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s companion unlink failure keeps the catalogue association for retry',
  async (mode) => {
    const f = await fixture(false);
    try {
      await unlink(f.companion);
      await mkdir(f.companion);
      const outcome = await f.purge(mode);
      if (outcome instanceof Response) expect(outcome.status).toBe(500);
      else expect(outcome).toEqual({ scanned: 1, purged: 0, errors: 1 });
      expect(await readFile(f.original, 'utf8')).toBe('original-photo-bytes');
      expect(
        f.live.db.query('SELECT apple_rendered_path FROM assets WHERE id=?').get(f.id),
      ).toEqual({
        apple_rendered_path: f.relativeCompanion,
      });
    } finally {
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s does not mistake an unavailable companion library for already-removed bytes',
  async (mode) => {
    const f = await fixture(false);
    try {
      const displaced = path.join(f.root, 'temporarily-offline-library');
      await rename(f.library, displaced);
      const outcome = await f.purge(mode);
      if (outcome instanceof Response) expect(outcome.status).toBe(500);
      else expect(outcome).toEqual({ scanned: 1, purged: 0, errors: 1 });
      expect(await readFile(path.join(displaced, f.relativeCompanion), 'utf8')).toBe(
        'apple-rendered-photo-bytes',
      );
      expect(await readFile(path.join(displaced, '.maple/trash/sub/photo.dng'), 'utf8')).toBe(
        'original-photo-bytes',
      );
      expect(
        f.live.db.query('SELECT apple_rendered_path FROM assets WHERE id=?').get(f.id),
      ).toEqual({ apple_rendered_path: f.relativeCompanion });
    } finally {
      await f.close();
    }
  },
);

test.each(['route', 'retention'] as const)(
  '%s companion removal is idempotent when its bytes are already absent',
  async (mode) => {
    const f = await fixture(false);
    try {
      await unlink(f.companion);
      const outcome = await f.purge(mode);
      if (outcome instanceof Response) expect(outcome.status).toBe(204);
      else expect(outcome).toEqual({ scanned: 1, purged: 1, errors: 0 });
      await expectRemoved(f.original);
      expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).toBeNull();
    } finally {
      await f.close();
    }
  },
);
