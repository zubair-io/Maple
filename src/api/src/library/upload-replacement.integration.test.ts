import { expect, test, spyOn } from 'bun:test';
import { Elysia } from 'elysia';
import * as path from 'node:path';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { foldersRoutes } from '../routes/folders.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import * as lifecycle from '../cloud-backup/lifecycle.ts';
import { reconcileLifecycle } from '../cloud-backup/lifecycle.ts';
import { ObjectId } from '../db/object-id.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { mkdir, writeFile, readFile, stat } from '../fs/mirrored.ts';
import * as assetsRepo from '../db/repos/assets.repo.ts';
import * as xmpConflict from '../fs/xmp-conflict.ts';
import * as mirrored from '../fs/mirrored.ts';
import * as ownership from '../fs/sidecar-ownership.ts';
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

const OLD_NAME_EDIT =
  '<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">unique backup edit</x:xmpmeta>';

test.each(['sidecar', 'old-name backup edit', 'companion'] as const)(
  'identical RAW replacement retains unique %s and its remote history',
  async (paired) => {
    const f = await fixture();
    try {
      if (paired === 'sidecar')
        await writeFile(
          path.join(f.library, 'photo.xmp'),
          '<x:xmpmeta>unique exposure edit</x:xmpmeta>',
        );
      else if (paired === 'old-name backup edit')
        await writeFile(path.join(f.library, 'photo.dng.xmp'), OLD_NAME_EDIT);
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
      const kept = {
        sidecar: ['.maple/trash/photo.xmp', 'unique exposure edit'],
        'old-name backup edit': ['.maple/trash/photo.dng.xmp', 'unique backup edit'],
        companion: ['photo-rendered.jpg', 'unique Apple render'],
      }[paired];
      expect(await readFile(path.join(f.library, kept[0]), 'utf8')).toContain(kept[1]);
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

test('a sidecar first written while an identical replacement purges follows the replacement (#5069)', async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  const late = path.join(f.library, '.maple/trash/photo.xmp');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    const realPrepare = lifecycle.prepareIdenticalReplacementPurge;
    const prepare = spyOn(lifecycle, 'prepareIdenticalReplacementPurge').mockImplementation(
      async (...args) => {
        await writeFile(late, 'edit');
        return realPrepare(...args);
      },
    );
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(true);
    } finally {
      prepare.mockRestore();
    }
    await expect(stat(source)).rejects.toThrow();
    await expect(stat(late)).rejects.toThrow();
    expect(await readFile(path.join(f.library, 'photo (conflict from move).xmp'), 'utf8')).toBe(
      'edit',
    );
  } finally {
    await f.close();
  }
});

test('a late sidecar a trashed same-stem sibling shares stays with that sibling (#5069)', async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  const late = path.join(f.library, '.maple/trash/photo.xmp');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    await writeFile(path.join(f.library, '.maple/trash/photo.jpg'), 'sibling');
    const realPrepare = lifecycle.prepareIdenticalReplacementPurge;
    const prepare = spyOn(lifecycle, 'prepareIdenticalReplacementPurge').mockImplementation(
      async (...args) => {
        await writeFile(late, 'shared edit');
        return realPrepare(...args);
      },
    );
    try {
      await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original);
    } finally {
      prepare.mockRestore();
    }
    expect(await readFile(late, 'utf8')).toBe('shared edit');
  } finally {
    await f.close();
  }
});

test('a late old-name edit follows the replacement even beside a same-stem sibling (#5069)', async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  const legacy = path.join(f.library, '.maple/trash/photo.dng.xmp');
  const edit =
    '<x:xmpmeta xmlns:maple="https://ns.justmaple.app/xmp/1.0/">old-name edit</x:xmpmeta>';
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    await writeFile(path.join(f.library, '.maple/trash/photo.jpg'), 'sibling');
    const realPrepare = lifecycle.prepareIdenticalReplacementPurge;
    const prepare = spyOn(lifecycle, 'prepareIdenticalReplacementPurge').mockImplementation(
      async (...args) => {
        await writeFile(legacy, edit);
        return realPrepare(...args);
      },
    );
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(true);
    } finally {
      prepare.mockRestore();
    }
    await expect(stat(legacy)).rejects.toThrow();
    expect(await readFile(path.join(f.library, 'photo (conflict from move).xmp'), 'utf8')).toBe(
      edit,
    );
  } finally {
    await f.close();
  }
});

test('an unreadable Trash folder never reads as having no late edits (#5069)', async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  const late = path.join(f.library, '.maple/trash/photo.xmp');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    // The edit lands just after the eligibility check, then the sibling check's
    // read of the Trash folder fails.
    const realStrict = xmpConflict.listPairedSidecarsStrict;
    let checked = false;
    const strict = spyOn(xmpConflict, 'listPairedSidecarsStrict').mockImplementation(async (p) => {
      const listed = await realStrict(p);
      if (!checked) {
        checked = true;
        await writeFile(late, 'edit');
      }
      return listed;
    });
    const realReaddir = mirrored.readdir as (...args: unknown[]) => Promise<unknown>;
    const readdir = spyOn(mirrored, 'readdir').mockImplementation(((...args: unknown[]) =>
      (args[1] as { withFileTypes?: boolean } | undefined)?.withFileTypes &&
      String(args[0]).endsWith('.maple/trash')
        ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
        : realReaddir(...args)) as unknown as typeof mirrored.readdir);
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(false);
    } finally {
      strict.mockRestore();
      readdir.mockRestore();
    }
    expect(await readFile(source, 'utf8')).toBe('old-original');
    expect(await readFile(late, 'utf8')).toBe('edit');
  } finally {
    await f.close();
  }
});

test("a failed late-edit check never skips the purged row's deletion (#5069)", async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    // The check fails only once the purge intent is recorded and can't be undone.
    let admitted = false;
    const realPrepare = lifecycle.prepareIdenticalReplacementPurge;
    const prepare = spyOn(lifecycle, 'prepareIdenticalReplacementPurge').mockImplementation(
      async (...args) => {
        admitted = await realPrepare(...args);
        return admitted;
      },
    );
    const realList = xmpConflict.listPairedSidecars;
    const list = spyOn(xmpConflict, 'listPairedSidecars').mockImplementation(async (p) =>
      admitted && String(p) === source ? Promise.reject(new Error('EIO')) : realList(p),
    );
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(true);
    } finally {
      list.mockRestore();
      prepare.mockRestore();
    }
    expect(admitted).toBe(true);
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).toBeNull();
  } finally {
    await f.close();
  }
});

test("a late edit that can't follow stops the purge before its intent is recorded (#5129)", async () => {
  const f = await fixture();
  const source = path.join(f.library, '.maple/trash/photo.dng');
  const late = path.join(f.library, '.maple/trash/photo.xmp');
  try {
    expect((await f.upload('different')).status).toBe(201);
    await writeFile(f.original, 'old-original');
    // The edit lands just after the purge checked for sidecars.
    const realStrict = xmpConflict.listPairedSidecarsStrict;
    const strict = spyOn(xmpConflict, 'listPairedSidecarsStrict').mockImplementation(async (p) => {
      const listed = await realStrict(p);
      await writeFile(late, 'edit');
      return listed;
    });
    const publish = spyOn(ownership, 'publishConflictBytes').mockResolvedValue(false);
    try {
      expect(
        await discardIdenticalReplacement(new ObjectId(f.id), f.library, source, f.original),
      ).toBe(false);
    } finally {
      strict.mockRestore();
      publish.mockRestore();
    }
    expect(await readFile(source, 'utf8')).toBe('old-original');
    expect(await readFile(late, 'utf8')).toBe('edit');
    expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(f.id)).not.toBeNull();
    expect(
      f.live.db
        .query("SELECT COUNT(*) AS n FROM backup_lifecycle WHERE asset_id=? AND kind='purge'")
        .get(f.id),
    ).toEqual({ n: 0 });
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
