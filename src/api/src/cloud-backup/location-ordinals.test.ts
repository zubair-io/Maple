import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { readFile, writeFile } from '../fs/mirrored.ts';
import { ObjectId } from '../db/object-id.ts';
import { appendBackupLocation, insertBackupAsset } from '../db/repos/backup.repo.ts';
import { createTempLibrary } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { handleEvent } from '../workers/discover/index.ts';
import { indexRecoveredEntry } from './recovery-index.ts';
import type { BackupManifest } from './provider.ts';

async function reserveRemovedLocation(
  db: Database,
  root: string,
  assetId: string,
  libraryId: string,
) {
  const ordinal = 1;
  const removed = db
    .query(`SELECT path,filename FROM asset_locations WHERE asset_id=? AND ordinal=?`)
    .get(assetId, ordinal) as { path: string; filename: string };
  expect(removed).toBeDefined();
  const destinationId = randomUUID();
  const entryId = randomUUID();
  const sourcePath = path.posix.join(removed.path, removed.filename);
  const bytes = await readFile(path.join(root, sourcePath));
  const manifest: BackupManifest = {
    version: 1,
    libraryId,
    entryId,
    assetId,
    sequence: 3,
    state: 'active',
    originalPath: sourcePath,
    currentPath: sourcePath,
    deletedAt: null,
    hidden: false,
    files: [
      {
        path: sourcePath,
        role: 'original',
        object: {
          key: sourcePath,
          locator: sourcePath,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      },
    ],
  };
  db.run(
    `INSERT INTO backup_destinations(id,library_id,kind,name,created_at)
     VALUES(?,?,'google','historical','2026-10-01T00:00:00Z')`,
    [destinationId, libraryId],
  );
  db.run(
    `INSERT INTO backup_entries
     (id,destination_id,asset_id,ordinal,source_path,sequence,verified_sequence,manifest)
     VALUES(?,?,?,?,?,3,3,?)`,
    [entryId, destinationId, assetId, ordinal, sourcePath, JSON.stringify(manifest)],
  );
  db.run(`DELETE FROM asset_locations WHERE asset_id=? AND ordinal=?`, [assetId, ordinal]);
  return db
    .query(
      `SELECT id,destination_id,asset_id,ordinal,source_path,state,verified_sequence,manifest
    FROM backup_entries WHERE asset_id=? AND ordinal=?`,
    )
    .get(assetId, ordinal)!;
}

function expectHistoryAndNewLocation(
  db: Database,
  assetId: string,
  history: object,
  filename: string,
) {
  expect(
    db
      .query(
        `SELECT id,destination_id,asset_id,ordinal,source_path,state,verified_sequence,manifest
    FROM backup_entries WHERE asset_id=? AND ordinal=1`,
      )
      .get(assetId),
  ).toEqual(history);
  expect(
    db
      .query(`SELECT ordinal,filename FROM asset_locations WHERE asset_id=? ORDER BY ordinal`)
      .all(assetId),
  ).toEqual([
    { ordinal: 0, filename: 'first.jpg' },
    { ordinal: 2, filename },
  ]);
}

test('backup ingest does not reuse an ordinal with verified remote history', async () => {
  using library = await createTempLibrary('maple-backup-ordinal-');
  const folderId = new ObjectId(library.folderId);
  const first = path.join(library.root, 'first.jpg');
  const removed = path.join(library.root, 'removed.jpg');
  const next = path.join(library.root, 'next.jpg');
  await Promise.all([
    writeFile(first, 'same bytes'),
    writeFile(removed, 'same bytes'),
    writeFile(next, 'same bytes'),
  ]);
  const assetId = await insertBackupAsset({
    relPath: 'first.jpg',
    libraryId: folderId,
    totalBytes: 10,
    mapleId: 'historical-backup-asset',
    isScreenshot: false,
    link: {
      device_id: 'device',
      phasset_local_id: 'photo',
      first_seen: new Date('2026-10-01'),
    },
  });
  await appendBackupLocation(assetId, {
    relPath: 'removed.jpg',
    libraryId: folderId,
    link: null,
  });
  const history = await reserveRemovedLocation(
    library.db,
    library.root,
    assetId.toHexString(),
    library.folderId,
  );

  await appendBackupLocation(assetId, {
    relPath: 'next.jpg',
    libraryId: folderId,
    link: null,
  });
  expectHistoryAndNewLocation(library.db, assetId.toHexString(), history, 'next.jpg');
});

test('discover dedup does not reuse an ordinal with verified remote history', async () => {
  using library = await createTempLibrary('maple-discover-ordinal-');
  const files = ['first.jpg', 'removed.jpg', 'next.jpg'].map((name) =>
    path.join(library.root, name),
  );
  await Promise.all(files.map((file) => writeFile(file, Buffer.alloc(70 * 1024, 0x73))));
  const folderId = new ObjectId(library.folderId);
  await handleEvent({ kind: 'created', absPath: files[0]! }, folderId, library.root);
  await handleEvent({ kind: 'created', absPath: files[1]! }, folderId, library.root);
  const { asset_id: assetId } = library.db
    .query(`SELECT asset_id FROM asset_locations WHERE filename='first.jpg'`)
    .get() as { asset_id: string };
  const history = await reserveRemovedLocation(library.db, library.root, assetId, library.folderId);

  await handleEvent({ kind: 'created', absPath: files[2]! }, folderId, library.root);
  expectHistoryAndNewLocation(library.db, assetId, history, 'next.jpg');
});

test('recovery indexing does not reuse an ordinal with verified remote history', async () => {
  using library = await createTempLibrary('maple-recovery-ordinal-');
  const folderId = new ObjectId(library.folderId);
  const bytes = Buffer.alloc(70 * 1024, 0x74);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = (filename: string): BackupManifest => ({
    version: 1,
    libraryId: library.folderId,
    entryId: randomUUID(),
    assetId: randomUUID(),
    sequence: 1,
    state: 'active',
    originalPath: filename,
    currentPath: filename,
    deletedAt: null,
    hidden: false,
    files: [
      {
        path: filename,
        role: 'original',
        object: {
          key: filename,
          locator: filename,
          size: bytes.length,
          sha256,
        },
      },
    ],
  });
  for (const name of ['first.jpg', 'removed.jpg']) {
    await writeFile(path.join(library.root, name), bytes);
    await indexRecoveredEntry(library.root, folderId, manifest(name));
  }
  const { asset_id: assetId } = library.db
    .query(`SELECT asset_id FROM asset_locations WHERE filename='first.jpg'`)
    .get() as { asset_id: string };
  const history = await reserveRemovedLocation(library.db, library.root, assetId, library.folderId);

  await writeFile(path.join(library.root, 'next.jpg'), bytes);
  await indexRecoveredEntry(library.root, folderId, manifest('next.jpg'));
  expectHistoryAndNewLocation(library.db, assetId, history, 'next.jpg');
});
