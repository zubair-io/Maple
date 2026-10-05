import { expect, test, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { foldersRoutes } from '../routes/folders.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import { reconcileLifecycle } from '../cloud-backup/lifecycle.ts';
import { ObjectId } from '../db/object-id.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { mkdir, writeFile, readFile, stat } from '../fs/mirrored.ts';
import * as assetsRepo from '../db/repos/assets.repo.ts';
import { discardIdenticalReplacement } from './upload-replacement.ts';

async function fixture(bytes = 'old-original') {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  await mkdir(library);
  const original = path.join(library, 'photo.dng');
  await writeFile(original, bytes);
  const libraryId = insertFolder(f.live.db, { path: library });
  const id = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId: id, libraryId, path: '', filename: 'photo.dng' });
  const destination = await backupEngine.repo.createDestination({
    libraryId,
    kind: 'google-drive',
    path: null,
    name: 'Private Drive',
  });
  const entry = await backupEngine.repo.ensureEntry(destination.id, id, 0, 'photo.dng');
  await backupEngine.repo.db.write(
    'UPDATE backup_entries SET lease_owner=?,lease_until=? WHERE id=?',
    ['stale-upload', Date.now() + 120000, entry.id],
  );
  const app = new Elysia().use(fakeAuth()).use(foldersRoutes);
  return {
    ...f,
    library,
    original,
    libraryId,
    id,
    entry,
    destination,
    async upload(value: string) {
      return app.handle(
        new Request(`http://localhost/api/folders/${libraryId}/upload`, {
          method: 'POST',
          headers: {
            'X-Maple-Target-Path': 'photo.dng',
            'Content-Type': 'application/octet-stream',
          },
          body: value,
        }),
      );
    },
    location() {
      return f.live.db
        .query('SELECT path,filename FROM asset_locations WHERE asset_id=? ORDER BY ordinal')
        .get(id) as { path: string; filename: string };
    },
    backup() {
      return f.live.db
        .query('SELECT state,sequence,source_path,lease_owner FROM backup_entries WHERE id=?')
        .get(entry.id) as {
        state: string;
        sequence: number;
        source_path: string;
        lease_owner: string | null;
      };
    },
  };
}

test('replacement upload commits durable Trash and fences an already claimed cloud upload', async () => {
  const f = await fixture();
  try {
    expect((await f.upload('new-original')).status).toBe(201);
    expect(await readFile(f.original, 'utf8')).toBe('new-original');
    expect(f.location()).toEqual({ path: '.maple/trash', filename: 'photo.dng' });
    expect(await readFile(path.join(f.library, '.maple/trash/photo.dng'), 'utf8')).toBe(
      'old-original',
    );
    expect(f.backup()).toMatchObject({
      state: 'trash',
      source_path: '.maple/trash/photo.dng',
      lease_owner: null,
    });
    expect(f.backup().sequence).toBeGreaterThan(1);
    expect(
      f.live.db
        .query(
          "SELECT phase,target_path,source_sha256 FROM backup_lifecycle WHERE asset_id=? AND kind='trash'",
        )
        .get(f.id),
    ).toMatchObject({ phase: 'applied', target_path: '.maple/trash/photo.dng' });
  } finally {
    await f.close();
  }
});

test('same prefix and size with different trailing bytes preserves the old Trash identity', async () => {
  const prefix = 'a'.repeat(65536);
  const f = await fixture(prefix + 'old');
  try {
    expect((await f.upload(prefix + 'new')).status).toBe(201);
    expect(await readFile(path.join(f.library, '.maple/trash/photo.dng'), 'utf8')).toBe(
      prefix + 'old',
    );
    expect(f.backup().state).toBe('trash');
    expect(f.live.db.query('SELECT * FROM backup_purges').all()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test.each(['sidecar', 'companion'] as const)(
  'identical RAW replacement retains unique %s and its remote history',
  async (paired) => {
    const f = await fixture();
    try {
      if (paired === 'sidecar')
        await writeFile(
          path.join(f.library, 'photo.xmp'),
          '<x:xmpmeta>unique exposure edit</x:xmpmeta>',
        );
      else {
        await writeFile(path.join(f.library, 'photo-rendered.jpg'), 'unique Apple render');
        await backupEngine.repo.db.write('UPDATE assets SET apple_rendered_path=? WHERE id=?', [
          'photo-rendered.jpg',
          f.id,
        ]);
      }
      expect((await f.upload('old-original')).status).toBe(201);
      expect(await readFile(path.join(f.library, '.maple/trash/photo.dng'), 'utf8')).toBe(
        'old-original',
      );
      const pairedPath = paired === 'sidecar' ? '.maple/trash/photo.xmp' : 'photo-rendered.jpg';
      expect(await readFile(path.join(f.library, pairedPath), 'utf8')).toContain(
        paired === 'sidecar' ? 'unique exposure edit' : 'unique Apple render',
      );
      expect(f.backup().state).toBe('trash');
      expect(f.live.db.query('SELECT * FROM backup_purges').all()).toHaveLength(0);
      expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).not.toBeNull();
    } finally {
      await f.close();
    }
  },
);

test('identical unedited replacement records permanent purge before discarding its old identity', async () => {
  const f = await fixture();
  try {
    const response = await f.upload('old-original');
    expect(response.status).toBe(201);
    const newId = ((await response.json()) as { asset_id: string }).asset_id;
    expect(newId).not.toBe(f.id);
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).toBeNull();
    await expect(stat(path.join(f.library, '.maple/trash/photo.dng'))).rejects.toThrow();
    expect(await readFile(f.original, 'utf8')).toBe('old-original');
    expect(f.backup().state).toBe('purged');
    expect(
      f.live.db.query('SELECT completed FROM backup_purges WHERE entry_id=?').get(f.entry.id),
    ).toEqual({ completed: 0 });
    expect(
      f.live.db
        .query("SELECT kind FROM backup_lifecycle WHERE asset_id=? AND kind='purge'")
        .get(f.id),
    ).toEqual({ kind: 'purge' });
  } finally {
    await f.close();
  }
});

test('identical replacement preserves a second indexed copy and does not purge the shared identity', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.library, 'other.dng'), 'old-original');
    insertLocation(f.live.db, {
      assetId: f.id,
      libraryId: f.libraryId,
      path: '',
      filename: 'other.dng',
      ordinal: 1,
    });
    expect((await f.upload('old-original')).status).toBe(201);
    expect(await readFile(path.join(f.library, 'other.dng'), 'utf8')).toBe('old-original');
    expect(
      f.live.db
        .query('SELECT filename FROM asset_locations WHERE asset_id=? ORDER BY ordinal')
        .all(f.id),
    ).toEqual([{ filename: 'photo.dng' }, { filename: 'other.dng' }]);
    expect(f.backup().state).toBe('trash');
    expect(f.live.db.query('SELECT * FROM backup_purges').all()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('location appended during file verification fails atomic redundant-purge admission', async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    const realTransaction = backupEngine.repo.db.transaction.bind(backupEngine.repo.db);
    const transaction = spyOn(backupEngine.repo.db, 'transaction').mockImplementation(
      async (statements) => {
        if (statements[0]?.sql.includes("SELECT ?,a.id,'purge'"))
          insertLocation(f.live.db, {
            assetId: f.id,
            libraryId: f.libraryId,
            path: '',
            filename: 'other.dng',
            ordinal: 1,
          });
        return realTransaction(statements);
      },
    );
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(false);
    } finally {
      transaction.mockRestore();
    }
    expect(await readFile(source, 'utf8')).toBe('old-original');
    expect(f.backup().state).toBe('trash');
    expect(f.live.db.query('SELECT * FROM backup_purges').all()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('catalog commit failure during replacement retains original bytes and a recoverable intent', async () => {
  const f = await fixture();
  const commit = spyOn(assetsRepo, 'markSoftDeleted').mockRejectedValueOnce(
    new Error('simulated catalog commit failure'),
  );
  try {
    expect((await f.upload('new-original')).status).toBe(500);
    expect(await readFile(f.original, 'utf8')).toBe('old-original');
    expect(f.location()).toEqual({ path: '', filename: 'photo.dng' });
    commit.mockRestore();
    await reconcileLifecycle();
    expect(
      f.live.db
        .query("SELECT phase FROM backup_lifecycle WHERE asset_id=? AND kind='trash'")
        .get(f.id),
    ).toEqual({ phase: 'cancelled' });
    expect(f.backup().state).toBe('active');
    expect(await readFile(f.original, 'utf8')).toBe('old-original');
  } finally {
    commit.mockRestore();
    await f.close();
  }
});
