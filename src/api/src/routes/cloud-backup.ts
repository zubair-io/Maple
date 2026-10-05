import { Elysia, t } from 'elysia';
import * as path from 'node:path';
import { realpath } from '../fs/mirrored.ts';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import { backupEngine } from '../cloud-backup/runtime.ts';
import {
  migrateFolderDestinations,
  projectFolderDestination,
} from '../cloud-backup/local-mirror-bridge.ts';
import { validateRoot } from '../fs/root.ts';
import { readRemoteCatalog } from '../cloud-backup/catalog.ts';
import { recoveryPreview } from '../cloud-backup/restore.ts';
import { createJob, getJob } from '../db/repos/jobs.repo.ts';
import { ObjectId } from '../db/object-id.ts';
import type { BackupDestination, BackupRepository } from '../cloud-backup/repository.ts';
import { resumeRecoveryJob } from '../cloud-backup/recovery-jobs.ts';

const repo: BackupRepository = backupEngine.repo;
const Id = t.Object({ id: t.String({ format: 'uuid' }) });
const Recovery = t.Object({
  targetPath: t.String({ maxLength: 4096 }),
  includeTrash: t.Boolean(),
  entryId: t.Optional(t.String({ format: 'uuid' })),
  sequence: t.Optional(t.Integer({ minimum: 1 })),
});
async function destination(id: string): Promise<BackupDestination> {
  const row = await repo.destination(id);
  if (!row) throw new Error('Backup destination not found');
  return row;
}
async function validateMirror(libraryId: string, target: string) {
  const [library] = await repo.db.read<{ path: string }>(`SELECT path FROM folders WHERE id=?`, [
    libraryId,
  ]);
  if (!library) throw new Error('Library not found');
  const valid = await validateRoot(target);
  if (!valid.ok) throw new Error(valid.error);
  const libraries = await repo.db.read<{ path: string }>(`SELECT path FROM folders`);
  const roots = [
    ...libraries.map((l) => path.resolve(l.path)),
    ...(await repo.destinations()).filter((d) => d.path).map((d) => path.resolve(d.path!)),
  ];
  const canonical = await realpath(target);
  if (
    roots.some(
      (root) =>
        canonical === root ||
        canonical.startsWith(root + path.sep) ||
        root.startsWith(canonical + path.sep),
    )
  )
    throw new Error('Mirror path overlaps a library or another destination');
  return canonical;
}
async function projection(row: BackupDestination) {
  const [status] = await repo.db.read<{
    pending: number;
    verified: number;
    trash: number;
    blocked: number;
    bytes: number;
    lastError: string | null;
  }>(
    `SELECT COALESCE(SUM(CASE WHEN state!='purged' AND verified_sequence<sequence THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN state!='purged' AND verified_sequence=sequence THEN 1 ELSE 0 END),0) AS verified,
      COALESCE(SUM(CASE WHEN state='trash' THEN 1 ELSE 0 END),0) AS trash,
      COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS blocked,
      COALESCE(SUM((SELECT SUM(json_extract(value,'$.object.size')) FROM json_each(manifest,'$.files'))),0) AS bytes,
      MAX(last_error) AS lastError FROM backup_entries WHERE destination_id=?`,
    [row.id],
  );
  if (!status) throw new Error('Backup status query failed');
  const purges = await repo.purges(row.id);
  const [coverage] = await repo.db.read<{ pending: number; missing: number; prepared: number }>(
    `SELECT
    (SELECT COUNT(*) FROM asset_locations l JOIN assets a ON a.id=l.asset_id LEFT JOIN backup_entries e
      ON e.asset_id=l.asset_id AND e.ordinal=l.ordinal AND e.destination_id=? WHERE l.library_id=?
      AND l.deleted_at IS NULL AND l.missing_since IS NULL AND a.deleted_reason IS NULL
      AND (e.id IS NULL OR (e.state!='purged' AND e.verified_sequence<e.sequence))) AS pending,
    (SELECT COUNT(*) FROM asset_locations l JOIN assets a ON a.id=l.asset_id WHERE l.library_id=?
      AND (l.missing_since IS NOT NULL OR a.deleted_reason IS NOT NULL)) AS missing,
    (SELECT COUNT(*) FROM backup_lifecycle WHERE library_id=? AND phase='prepared') AS prepared`,
    [row.id, row.libraryId, row.libraryId, row.libraryId],
  );
  if (!coverage) throw new Error('Backup coverage query failed');
  return {
    ...row,
    status: {
      pending: row.kind === 'google-drive' ? coverage.pending : status.pending,
      missing: coverage.missing,
      prepared: coverage.prepared,
      verified: status.verified,
      trash: status.trash,
      blocked: status.blocked + coverage.prepared,
      bytes: status.bytes,
      lastError: coverage.prepared
        ? 'Interrupted local move requires recovery or retry'
        : status.lastError,
      purgePending: purges.filter((p) => !p.completed).length,
    },
  };
}
export const cloudBackupRoutes = new Elysia({ name: 'cloudBackup', prefix: '/api/cloud-backup' })
  .use(requireAuth)
  .use(requireOwner)
  .onError(({ error, set }) => {
    if (Number(set.status) < 400 || !set.status) set.status = 400;
    return { error: error instanceof Error ? error.message : 'Backup request failed' };
  })
  .get('/destinations', async () => {
    await migrateFolderDestinations(repo);
    return { destinations: await Promise.all((await repo.destinations()).map(projection)) };
  })
  .post(
    '/destinations',
    async ({ body }) => {
      const [library] = await repo.db.read(`SELECT id FROM folders WHERE id=?`, [body.libraryId]);
      if (!library) throw new Error('Library not found');
      const target =
        body.kind === 'folder' ? await validateMirror(body.libraryId, body.path ?? '') : null;
      const row = await repo.createDestination({
        libraryId: body.libraryId,
        kind: body.kind,
        name: body.name.trim(),
        path: target,
      });
      if (row.kind === 'folder') await projectFolderDestination(row.libraryId, repo);
      return { destination: await projection(row) };
    },
    {
      body: t.Object({
        libraryId: t.String({ pattern: '^[a-f0-9]{24}$' }),
        kind: t.Union([t.Literal('folder'), t.Literal('google-drive')]),
        name: t.String({ minLength: 1, maxLength: 100 }),
        path: t.Optional(t.String({ maxLength: 4096 })),
      }),
    },
  )
  .patch(
    '/destinations/:id',
    async ({ params, body }) => {
      const row = await destination(params.id);
      await validateDestinationUpdate(row, body);
      await repo.updateDestination(row.id, { name: body.name, enabled: body.enabled });
      if (row.kind === 'folder') await projectFolderDestination(row.libraryId, repo);
      return { destination: await projection(await destination(row.id)) };
    },
    {
      params: Id,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
        enabled: t.Optional(t.Boolean()),
        path: t.Optional(t.String()),
      }),
    },
  )
  .delete(
    '/destinations/:id',
    async ({ params }) => {
      const row = await destination(params.id);
      if ((await repo.purges(row.id)).some((p) => !p.completed))
        throw new Error('Finish pending purges before removing this destination');
      if ((await repo.entries(row.id)).some((e) => e.lease_until > Date.now()))
        throw new Error('Pause the destination and wait for active transfers before removing it');
      const [deleted] = await repo.db.transaction([
        {
          sql: `DELETE FROM backup_destinations WHERE id=? AND NOT EXISTS
        (SELECT 1 FROM backup_purges WHERE destination_id=? AND completed=0) AND NOT EXISTS
        (SELECT 1 FROM backup_entries WHERE destination_id=? AND lease_until>?)`,
          params: [row.id, row.id, row.id, Date.now()],
        },
        {
          sql: `DELETE FROM backup_google_oauth WHERE destination_id=? AND NOT EXISTS (SELECT 1 FROM backup_destinations WHERE id=?)`,
          params: [row.id, row.id],
        },
        {
          sql: `DELETE FROM backup_google_connections WHERE destination_id=? AND NOT EXISTS (SELECT 1 FROM backup_destinations WHERE id=?)`,
          params: [row.id, row.id],
        },
      ]);
      if (!deleted?.changes) throw new Error('Destination has pending cleanup or active transfers');
      if (row.kind === 'folder') await projectFolderDestination(row.libraryId, repo);
      return { ok: true };
    },
    { params: Id },
  )
  .post(
    '/destinations/:id/retry',
    async ({ params }) => {
      await destination(params.id);
      await repo.retry(params.id);
      return { ok: true };
    },
    { params: Id },
  )
  .get(
    '/destinations/:id/catalog',
    async ({ params }) => {
      const row = await destination(params.id);
      return row.kind === 'google-drive'
        ? readRemoteCatalog(await backupEngine.provider(row))
        : repo.catalog(row.id);
    },
    { params: Id },
  )
  .post(
    '/destinations/:id/restore/preview',
    async ({ params, body }) =>
      recoveryPreview(await backupEngine.provider(await destination(params.id)), body),
    { params: Id, body: Recovery },
  )
  .post(
    '/destinations/:id/restore',
    async ({ params, body }) => {
      const row = await destination(params.id);
      await recoveryPreview(await backupEngine.provider(row), body);
      const job = await createJob({
        kind: 'cloud_backup_restore',
        payload: { ...body, destinationId: row.id },
      });
      return { jobId: job._id.toHexString() };
    },
    { params: Id, body: Recovery },
  )
  .get(
    '/destinations/:id/restore/jobs',
    async ({ params }) => {
      await destination(params.id);
      const rows = await repo.db.read<{ id: string }>(
        `SELECT id FROM jobs WHERE kind='cloud_backup_restore'
      AND json_extract(params,'$.destinationId')=? AND (status IN ('queued','running') OR id IN
        (SELECT id FROM jobs WHERE kind='cloud_backup_restore' AND json_extract(params,'$.destinationId')=?
        ORDER BY created_at DESC LIMIT 200)) ORDER BY created_at DESC`,
        [params.id, params.id],
      );
      const jobs = await Promise.all(rows.map((row) => getJob(new ObjectId(row.id))));
      return {
        jobs: jobs
          .filter((job) => job !== null)
          .map((job) => ({
            id: job._id.toHexString(),
            kind: job.kind,
            status: job.status,
            payload: job.payload,
            progress: job.progress,
            result: job.result,
            error: job.error,
            cancel_requested: job.cancel_requested,
            created_at: job.created_at,
            updated_at: job.updated_at,
          })),
      };
    },
    { params: Id },
  )
  .post(
    '/destinations/:id/restore/jobs/:jobId/resume',
    async ({ params, set }) => {
      await destination(params.id);
      if (!(await resumeRecoveryJob(params.id, params.jobId))) {
        set.status = 409;
        return { error: 'Only failed or cancelled recovery jobs for this destination can resume' };
      }
      return { ok: true };
    },
    {
      params: t.Object({
        id: t.String({ format: 'uuid' }),
        jobId: t.String({ pattern: '^[a-f0-9]{24}$' }),
      }),
    },
  );

async function validateDestinationUpdate(
  row: BackupDestination,
  body: { path?: string; enabled?: boolean },
): Promise<void> {
  if (body.path && body.path !== row.path)
    throw new Error(
      'Create a new folder destination to change its path; existing purge obligations retain their root',
    );
  if (!body.enabled) return;
  await validateEnabledDestination(row);
}
async function validateEnabledDestination(row: BackupDestination): Promise<void> {
  if (row.kind === 'folder' && row.path) {
    const valid = await validateRoot(row.path);
    if (!valid.ok) throw new Error(valid.error);
  }
  if (row.kind === 'google-drive' && !row.rootId)
    throw new Error('Connect Google Drive and create or attach a backup folder first');
}
