import { expect, test } from 'bun:test';
import { buildApp } from '../index.ts';
import { signAccessToken } from '../auth/tokens.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { createJob, failJob, getJob } from '../db/repos/jobs.repo.ts';
import { BackupRepository } from '../cloud-backup/repository.ts';

test('mounted owner backup routes retain folder scope and protect recovery detail/cancel/resume', async () => {
  using live = await createLiveTestDatabase();
  const previous = process.env.MAPLE_JWT_SECRET;
  const secret = 'backup-common-owner-test-secret-long';
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    const app = buildApp({ stageNames: [] });
    const owner = await signAccessToken(
      { sub: '111111111111111111111111', email: null, role: 'owner', file_access: true },
      secret,
    );
    const member = await signAccessToken(
      { sub: '222222222222222222222222', email: null, role: 'member', file_access: true },
      secret,
    );
    const request = (url: string, method = 'GET', body?: unknown, token = owner) =>
      app.handle(
        new Request('http://localhost' + url, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect(
      (await app.handle(new Request('http://localhost/api/cloud-backup/destinations'))).status,
    ).toBe(401);
    expect((await request('/api/cloud-backup/destinations', 'GET', undefined, member)).status).toBe(
      403,
    );
    const libraryId = insertFolder(live.db);
    const otherLibrary = insertFolder(live.db);
    const assetId = insertAsset(live.db);
    insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
    insertLocation(live.db, {
      assetId,
      ordinal: 1,
      libraryId: otherLibrary,
      path: '',
      filename: 'other.dng',
    });
    const response = await request('/api/cloud-backup/destinations', 'POST', {
      libraryId,
      kind: 'google-drive',
      name: 'Drive',
    });
    expect(response.status).toBe(200);
    const { destination } = (await response.json()) as {
      destination: { id: string; enabled: boolean; status: { pending: number } };
    };
    expect(destination.enabled).toBe(false);
    expect(destination.status.pending).toBe(1);
    const repo = new BackupRepository(live.handle);
    const second = await repo.createDestination({
      libraryId: otherLibrary,
      kind: 'google-drive',
      name: 'Another Drive',
      path: null,
    });
    const job = await createJob({
      kind: 'cloud_backup_restore',
      payload: { destinationId: destination.id, targetPath: '/recovery' },
      checkpoint: { owned: ['photo.dng'] },
    });
    await failJob(job._id, 'temporary failure');
    expect(
      (await request(`/api/jobs/${job._id.toHexString()}`, 'GET', undefined, member)).status,
    ).toBe(403);
    expect(
      (await request(`/api/jobs/${job._id.toHexString()}/cancel`, 'POST', {}, member)).status,
    ).toBe(403);
    expect((await request(`/api/jobs/${job._id.toHexString()}`)).status).toBe(200);
    const memberList = (await (
      await request('/api/jobs?kind=cloud_backup_restore', 'GET', undefined, member)
    ).json()) as { jobs: unknown[] };
    expect(memberList.jobs).toEqual([]);
    const endpoint = `/api/cloud-backup/destinations/${destination.id}/restore/jobs/${job._id.toHexString()}/resume`;
    expect((await request(endpoint, 'POST', {}, member)).status).toBe(403);
    expect(
      (
        await request(
          `/api/cloud-backup/destinations/${second.id}/restore/jobs/${job._id.toHexString()}/resume`,
          'POST',
          {},
        )
      ).status,
    ).toBe(409);
    expect((await request(endpoint, 'POST', {})).status).toBe(200);
    expect((await getJob(job._id))!.checkpoint).toEqual({ owned: ['photo.dng'] });
    expect(
      (
        await request('/api/jobs', 'POST', {
          kind: 'cloud_backup_restore',
          payload: { targetPath: '/unchecked' },
        })
      ).status,
    ).toBe(400);
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
});

test('Google Drive destination coverage preserves pending and missing counts', async () => {
  using live = await createLiveTestDatabase();
  const previous = process.env.MAPLE_JWT_SECRET;
  const secret = 'backup-destination-coverage-test-secret';
  process.env.MAPLE_JWT_SECRET = secret;
  try {
    const app = buildApp({ stageNames: [] });
    const owner = await signAccessToken(
      { sub: '111111111111111111111111', email: null, role: 'owner', file_access: true },
      secret,
    );
    const libraryId = insertFolder(live.db);
    const destination = await new BackupRepository(live.handle).createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'Drive',
      path: null,
    });
    const repo = new BackupRepository(live.handle);
    const location = (filename: string, options: { missingSince?: string } = {}) => {
      const assetId = insertAsset(live.db);
      insertLocation(live.db, {
        assetId,
        libraryId,
        filename,
        missingSince: options.missingSince,
      });
      return assetId;
    };

    location('without-entry.dng');
    const verifiedAsset = location('verified.dng');
    const staleAsset = location('stale.dng');
    const purgedAsset = location('purged.dng');
    const reapedAsset = location('reaped.dng');
    location('missing.dng', { missingSince: '2026-10-01T00:00:00Z' });
    run(live.db, `UPDATE assets SET deleted_reason='reaped' WHERE id=?`, reapedAsset);

    const verified = await repo.ensureEntry(destination.id, verifiedAsset, 0, 'verified.dng');
    run(
      live.db,
      `UPDATE backup_entries SET sequence=1,verified_sequence=1 WHERE id=?`,
      verified.id,
    );
    const stale = await repo.ensureEntry(destination.id, staleAsset, 0, 'stale.dng');
    run(live.db, `UPDATE backup_entries SET sequence=2,verified_sequence=1 WHERE id=?`, stale.id);
    const purged = await repo.ensureEntry(destination.id, purgedAsset, 0, 'purged.dng');
    run(live.db, `UPDATE backup_entries SET state='purged',sequence=2 WHERE id=?`, purged.id);

    const response = await app.handle(
      new Request('http://localhost/api/cloud-backup/destinations', {
        headers: { Authorization: `Bearer ${owner}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      destinations: Array<{ id: string; status: { pending: number; missing: number } }>;
    };
    expect(body.destinations.find((item) => item.id === destination.id)?.status).toMatchObject({
      pending: 2,
      missing: 2,
    });
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
});
