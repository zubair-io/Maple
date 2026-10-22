import { expect, test } from 'bun:test';
import * as path from 'node:path';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import {
  createTestDatabase,
  testSqliteDb,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers';
import { ObjectId } from '../db/object-id';
import { hardDelete } from '../db/repos/assets.trash';
import { readFile, rename, stat, unlink, writeFile } from '../fs/mirrored';
import { serializeSidecarWrite } from '../fs/sidecar-write-order';
import { writeXmpAtomic, writeXmpWithPrecondition } from '../fs/xmp';
import { writeConflictSidecarAtomic } from '../fs/xmp-conflict';
import { captureSidecarWriteScope } from './xmp-change';
import { resolveAndAuthorizeSidecarWrite } from './xmp-path-auth';

const edits = (exposure: number) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="${exposure}"/>
</rdf:RDF></x:xmpmeta>`;

test.each(['path save', 'asset save', 'conflict save'] as const)(
  '%s admitted before a purge cannot recreate an orphan sidecar afterwards',
  async (kind) => {
    const f = await recoveryFixture();
    const photo = path.join(f.root, 'photo.dng');
    const sidecar = path.join(
      f.root,
      kind === 'conflict save' ? 'photo (conflict from move).xmp' : 'photo.xmp',
    );
    await writeFile(photo, 'original');
    const libraryId = insertFolder(f.live.db, { path: f.root });
    const id = insertAsset(f.live.db);
    insertLocation(f.live.db, { assetId: id, libraryId, path: '', filename: 'photo.dng' });
    const authorized = await resolveAndAuthorizeSidecarWrite(photo);
    if (!authorized.ok) throw new Error(authorized.error);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = serializeSidecarWrite(path.join(f.root, 'photo.xmp'), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const saving =
      kind === 'path save'
        ? writeXmpAtomic(photo, edits(2), undefined, authorized.writeScope)
        : kind === 'asset save'
          ? writeXmpWithPrecondition(photo, edits(2), null, 'device', false, authorized.writeScope)
          : writeConflictSidecarAtomic(
              photo,
              'photo (conflict from move)',
              edits(2),
              undefined,
              authorized.writeScope,
            );
    try {
      await hardDelete(new ObjectId(id));
      await unlink(photo);
      release.resolve();
      await holder;
      expect(await saving).toMatchObject({
        error: expect.stringContaining('reload before saving'),
      });
      await expect(stat(sidecar)).rejects.toThrow();
    } finally {
      release.resolve();
      await holder;
      await saving;
      await f.close();
    }
  },
);

test('a queued save cannot attach old edits to a replacement even before its catalog update', async () => {
  const f = await recoveryFixture();
  const photo = path.join(f.root, 'photo.dng');
  const sidecar = path.join(f.root, 'photo.xmp');
  await writeFile(photo, 'old original');
  await writeFile(sidecar, edits(1));
  const libraryId = insertFolder(f.live.db, { path: f.root });
  const id = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId: id, libraryId, path: '', filename: 'photo.dng' });
  const authorized = await resolveAndAuthorizeSidecarWrite(photo);
  if (!authorized.ok) throw new Error(authorized.error);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = serializeSidecarWrite(sidecar, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const saving = writeXmpAtomic(photo, edits(2), undefined, authorized.writeScope);
  try {
    const incoming = path.join(f.root, 'incoming.dng');
    await writeFile(incoming, 'new original');
    await rename(incoming, photo);
    release.resolve();
    await holder;
    expect(await saving).toMatchObject({
      ok: false,
      error: expect.stringContaining('reload before saving'),
    });
    expect(await readFile(photo, 'utf8')).toBe('new original');
    expect(await readFile(sidecar, 'utf8')).toBe(edits(1));
  } finally {
    release.resolve();
    await holder;
    await saving;
    await f.close();
  }
});

test('a write binding validates against its explicitly supplied database', async () => {
  const f = await recoveryFixture();
  using isolated = await createTestDatabase();
  const photo = path.join(f.root, 'isolated.dng');
  try {
    await writeFile(photo, 'original');
    const libraryId = insertFolder(isolated.db, { path: f.root });
    const id = insertAsset(isolated.db);
    insertLocation(isolated.db, { assetId: id, libraryId, path: '', filename: 'isolated.dng' });
    const scope = await captureSidecarWriteScope(photo, f.root, testSqliteDb(isolated.db));
    if (typeof scope === 'string') throw new Error('Expected a primary binding');
    await expect(scope.validate()).resolves.toBeUndefined();
    isolated.db.run('DELETE FROM asset_locations WHERE asset_id = ?', [id]);
    await expect(scope.validate()).rejects.toThrow('reload before saving');
  } finally {
    await f.close();
  }
});

test('a write admitted before catalog registration cannot attach to the newly registered asset', async () => {
  const f = await recoveryFixture();
  const photo = path.join(f.root, 'new.dng');
  try {
    await writeFile(photo, 'replacement');
    const libraryId = insertFolder(f.live.db, { path: f.root });
    const scope = await captureSidecarWriteScope(photo, f.root);
    if (typeof scope === 'string') throw new Error('Expected a primary binding');
    const id = insertAsset(f.live.db);
    insertLocation(f.live.db, { assetId: id, libraryId, path: '', filename: 'new.dng' });
    await expect(scope.validate()).rejects.toThrow('reload before saving');
  } finally {
    await f.close();
  }
});
