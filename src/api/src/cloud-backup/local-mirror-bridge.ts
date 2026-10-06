/** The folder mirror remains the sole local writer; this owns its configuration (#4228). */
import * as path from 'node:path';
import { listFolders } from '../db/repos/folders.repo.ts';
import type { MirrorLocation } from '../db/schema.ts';
import { BackupRepository } from './repository.ts';
import { setMirrorRoots } from '../fs/mirror-registry.ts';
import { removedDestinationStatements } from './destination-removal.ts';

export async function migrateFolderDestinations(repo = new BackupRepository()): Promise<void> {
  const folders = await listFolders(repo.db);
  const migrated = new Set(
    (
      await repo.db.read<{ id: string }>(
        `SELECT id FROM app_settings WHERE id LIKE 'backup-migrated:%'`,
      )
    ).map((row) => row.id),
  );
  for (const folder of folders) {
    const libraryId = folder._id.toHexString();
    if (migrated.has(`backup-migrated:${libraryId}`)) continue;
    // Mark migration in the same transaction as inserts. An intentionally
    // removed destination must not reappear from an old compatibility projection.
    await repo.db.transaction([
      ...(folder.mirrors ?? []).map((mirror) => ({
        sql: `INSERT OR IGNORE INTO backup_destinations(id,library_id,kind,name,enabled,path,created_at)
          SELECT ?,?,'folder',?,?,?,? WHERE NOT EXISTS
          (SELECT 1 FROM app_settings WHERE id=?)`,
        params: [
          crypto.randomUUID(),
          libraryId,
          path.basename(mirror.path),
          Number(mirror.enabled),
          mirror.path,
          new Date().toISOString(),
          `backup-migrated:${libraryId}`,
        ],
      })),
      {
        sql: `INSERT OR IGNORE INTO app_settings(id,doc) VALUES(?,'{}')`,
        params: [`backup-migrated:${libraryId}`],
      },
    ]);
  }
}

export async function loadDestinationMirrors(repo = new BackupRepository()): Promise<void> {
  await migrateFolderDestinations(repo);
  const folders = await listFolders(repo.db);
  const destinations = await repo.destinations();
  setMirrorRoots(
    new Map(
      folders.flatMap((folder) => {
        const roots = destinations
          .filter(
            (d) =>
              d.kind === 'folder' &&
              d.enabled &&
              d.path &&
              d.libraryId === folder._id.toHexString(),
          )
          .map((d) => d.path!);
        return roots.length ? [[folder.path, roots] as const] : [];
      }),
    ),
  );
}

export async function replaceFolderDestinations(
  libraryId: string,
  mirrors: MirrorLocation[],
  repo = new BackupRepository(),
): Promise<void> {
  await migrateFolderDestinations(repo);
  const current = (await repo.destinations()).filter(
    (d) => d.libraryId === libraryId && d.kind === 'folder',
  );
  await repo.db.transaction([
    ...current
      .filter((d) => !mirrors.some((m) => m.path === d.path))
      .flatMap((d) => [
        {
          sql: `DELETE FROM backup_destinations WHERE id=?`,
          params: [d.id],
        },
        ...removedDestinationStatements(d.id),
      ]),
    ...mirrors.map((m) => ({
      sql: `INSERT INTO backup_destinations(id,library_id,kind,name,enabled,path,created_at)
        VALUES(?,?,'folder',?,?,?,?) ON CONFLICT(library_id,kind,path)
        DO UPDATE SET enabled=excluded.enabled,generation=generation+1`,
      params: [
        crypto.randomUUID(),
        libraryId,
        path.basename(m.path),
        Number(m.enabled),
        m.path,
        new Date().toISOString(),
      ],
    })),
    {
      sql: `UPDATE folders SET mirrors=? WHERE id=?`,
      params: [JSON.stringify(mirrors), libraryId],
    },
  ]);
  await loadDestinationMirrors(repo);
}

export async function projectFolderDestination(
  libraryId: string,
  repo = new BackupRepository(),
): Promise<void> {
  await repo.db.write(
    `UPDATE folders SET mirrors=(SELECT json_group_array(json_object('path',path,
    'enabled',json(CASE enabled WHEN 1 THEN 'true' ELSE 'false' END))) FROM backup_destinations
    WHERE library_id=? AND kind='folder') WHERE id=?`,
    [libraryId, libraryId],
  );
  await loadDestinationMirrors(repo);
}
