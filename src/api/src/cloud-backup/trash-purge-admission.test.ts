import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, rename } from '../fs/mirrored.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { ObjectId } from '../db/object-id.ts';
import { BackupRepository, type BackupEntry } from './repository.ts';
import { runTrashGcOnce } from '../workers/trash-gc.ts';
import { trashRoutes } from '../routes/assets/trash.ts';
import { restoreAssetById } from '../library/asset-trash.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';

async function fixture() {
  const live = await createLiveTestDatabase();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maple-purge-admission-')));
  await mkdir(join(root, '.maple/trash'), { recursive: true });
  const libraryId = insertFolder(live.db, { path: root });
  const repo = new BackupRepository(live.handle);
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Photos',
    path: null,
  });
  await repo.updateDestination(destination.id, { enabled: true });
  const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
  async function seed(name: string) {
    const id = insertAsset(live.db, { deletedAt: '2000-01-01T00:00:00Z' });
    insertLocation(live.db, {
      assetId: id,
      libraryId,
      path: '.maple/trash',
      filename: `${name}.dng`,
    });
    live.db
      .query('UPDATE assets SET original_path=? WHERE id=?')
      .run(join(root, `${name}.dng`), id);
    await writeFile(join(root, `.maple/trash/${name}.dng`), `original-${name}`);
    await writeFile(join(root, `.maple/trash/${name}.xmp`), `<xmp>${name}</xmp>`);
    const entry = await repo.ensureEntry(destination.id, id, 0, `.maple/trash/${name}.dng`);
    live.db
      .query(
        "UPDATE backup_entries SET state='trash',manifest='retained-remote-history' WHERE id=?",
      )
      .run(entry.id);
    return {
      id,
      entry,
      original: join(root, `.maple/trash/${name}.dng`),
      sidecar: join(root, `.maple/trash/${name}.xmp`),
    };
  }
  return {
    live,
    root,
    repo,
    libraryId,
    destination,
    seed,
    purge: (id: string) =>
      app.handle(
        new Request(`http://localhost/api/assets/${id}?intent=purge`, { method: 'DELETE' }),
      ),
    async [Symbol.asyncDispose]() {
      live.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function beforePurge(f: Awaited<ReturnType<typeof fixture>>, action: () => Promise<void>) {
  const transaction = f.live.handle.transaction.bind(f.live.handle);
  let admitted = false;
  f.live.handle.transaction = async (statements) => {
    if (!admitted && statements[0]?.sql.includes("SELECT ?,a.id,'purge'")) {
      admitted = true;
      await action();
    }
    return transaction(statements);
  };
}

for (const mode of ['route', 'retention'] as const) {
  test(`${mode} cannot erase history using a Trash candidate selected before restore completes`, async () => {
    await using f = await fixture();
    const candidate = await f.seed('photo');
    const following = await f.seed('following');
    let restoredHistory: BackupEntry[] = [];
    beforePurge(f, async () => {
      expect((await restoreAssetById(new ObjectId(candidate.id))).kind).toBe('ok');
      restoredHistory = await f.repo.entries(f.destination.id, candidate.id);
    });
    const result =
      mode === 'route' ? await f.purge(candidate.id) : await runTrashGcOnce({ retentionDays: 30 });
    if (result instanceof Response) {
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({
        error: 'Trash state changed — refresh before deleting',
      });
    } else {
      expect(result).toEqual({ scanned: 2, purged: 1, errors: 0 });
      expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(following.id)).toBeNull();
    }
    expect(await readFile(join(f.root, 'photo.dng'), 'utf8')).toBe('original-photo');
    expect(await readFile(join(f.root, 'photo.xmp'), 'utf8')).toBe('<xmp>photo</xmp>');
    expect(f.live.db.query('SELECT deleted_at FROM assets WHERE id=?').get(candidate.id)).toEqual({
      deleted_at: null,
    });
    expect(await f.repo.entries(f.destination.id, candidate.id)).toEqual(restoredHistory);
    expect(
      f.live.db
        .query("SELECT id FROM backup_lifecycle WHERE asset_id=? AND kind='purge'")
        .all(candidate.id),
    ).toEqual([]);
    expect(
      (await f.repo.purges(f.destination.id)).some(
        (purge) => purge.entry_id === candidate.entry.id,
      ),
    ).toBe(false);
  });

  for (const change of ['reaped', 'replacement'] as const) {
    test(`${mode} skips a ${change} location admitted after Trash selection`, async () => {
      await using f = await fixture();
      const candidate = await f.seed('photo');
      let changedHistory: BackupEntry[] = [];
      const mutations = {
        reaped: async () => {
          f.live.db
            .query("UPDATE assets SET deleted_reason='reaped',deleted_at=? WHERE id=?")
            .run(new Date().toISOString(), candidate.id);
          await writeFile(join(f.root, 'photo.dng'), 'returned-active-original');
        },
        replacement: async () => {
          await rename(candidate.original, join(f.root, '.maple/trash/new-location.dng'));
          f.live.db
            .query("UPDATE asset_locations SET filename='new-location.dng' WHERE asset_id=?")
            .run(candidate.id);
          await writeFile(candidate.original, 'new-unrelated-bytes');
        },
      };
      beforePurge(f, async () => {
        await mutations[change]();
        changedHistory = await f.repo.entries(f.destination.id, candidate.id);
      });
      const result =
        mode === 'route'
          ? await f.purge(candidate.id)
          : await runTrashGcOnce({ retentionDays: 30 });
      if (result instanceof Response) expect(result.status).toBe(409);
      else expect(result).toEqual({ scanned: 1, purged: 0, errors: 0 });
      expect(await readFile(candidate.original, 'utf8')).toBe(
        change === 'reaped' ? 'original-photo' : 'new-unrelated-bytes',
      );
      expect(await readFile(candidate.sidecar, 'utf8')).toBe('<xmp>photo</xmp>');
      expect(await f.repo.entries(f.destination.id, candidate.id)).toEqual(changedHistory);
      expect(await f.repo.purges(f.destination.id)).toEqual([]);
      expect(f.live.db.query("SELECT id FROM backup_lifecycle WHERE kind='purge'").all()).toEqual(
        [],
      );
    });
  }

  for (const phase of ['prepared', 'applied']) {
    test(`${mode} preserves a Trash candidate while its ${phase} filesystem lease is live`, async () => {
      await using f = await fixture();
      const candidate = await f.seed('photo');
      const history = await f.repo.entries(f.destination.id, candidate.id);
      beforePurge(f, async () => {
        f.live.db
          .query(
            `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at,lease_owner,lease_until)
          VALUES(?,?,'restore',?,?,'current-mover',?)`,
          )
          .run(
            crypto.randomUUID(),
            candidate.id,
            phase,
            new Date().toISOString(),
            Date.now() + 120_000,
          );
      });
      const result =
        mode === 'route'
          ? await f.purge(candidate.id)
          : await runTrashGcOnce({ retentionDays: 30 });
      if (result instanceof Response) expect(result.status).toBe(409);
      else expect(result).toEqual({ scanned: 1, purged: 0, errors: 0 });
      expect(await readFile(candidate.original, 'utf8')).toBe('original-photo');
      expect(await f.repo.entries(f.destination.id, candidate.id)).toEqual(history);
      expect(await f.repo.purges(f.destination.id)).toEqual([]);
    });
  }
}

test('retention cannot forget a reaped row whose deletion clock changed after selection', async () => {
  await using f = await fixture();
  const candidate = await f.seed('photo');
  await f.repo.db.write('DELETE FROM backup_entries WHERE asset_id=?', [candidate.id]);
  f.live.db.query("UPDATE assets SET deleted_reason='reaped' WHERE id=?").run(candidate.id);
  const write = f.live.handle.write.bind(f.live.handle);
  f.live.handle.write = async (sql, params) => {
    if (sql.startsWith('DELETE FROM assets AS a')) {
      f.live.db
        .query('UPDATE assets SET deleted_at=? WHERE id=?')
        .run(new Date().toISOString(), candidate.id);
    }
    return write(sql, params);
  };
  expect(await runTrashGcOnce({ retentionDays: 30 })).toEqual({ scanned: 1, purged: 0, errors: 0 });
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(candidate.id)).not.toBeNull();
  expect(await readFile(candidate.original, 'utf8')).toBe('original-photo');
});
