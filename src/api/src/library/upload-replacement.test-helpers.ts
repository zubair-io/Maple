import { Elysia } from 'elysia';
import * as path from 'node:path';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { foldersRoutes } from '../routes/folders.ts';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import {
  insertAsset,
  insertFolder,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { mkdir, writeFile } from '../fs/mirrored.ts';

export async function replacementFixture(bytes = 'old-original') {
  const f = await recoveryFixture();
  const library = path.join(f.root, 'library');
  await mkdir(library);
  const original = path.join(library, 'photo.dng');
  await writeFile(original, bytes);
  const libraryId = insertFolder(f.live.db, { path: library });
  const id = insertAsset(f.live.db);
  insertLocation(f.live.db, {
    assetId: id,
    libraryId,
    path: '',
    filename: 'photo.dng',
  });
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
