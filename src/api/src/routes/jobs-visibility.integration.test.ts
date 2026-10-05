import { expect, test } from 'bun:test';
import { buildApp } from '../index.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { createJob, completeJob } from '../db/repos/jobs.repo.ts';
import type { JobKind, JobWithId } from '../db/schema.ts';

test('mounted jobs list excludes owner-only recovery before LIMIT and preserves role, kind and status filters', async () => {
  using live = await createLiveTestDatabase();
  const previous = process.env.MAPLE_JWT_SECRET;
  const secret = 'job-visibility-sqlite-pagination-test-secret';
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
    const create = (kind: JobKind, second: number) =>
      createJob(
        { kind, payload: { marker: `job-${second}` } },
        () => new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
        undefined,
        live.handle,
      );
    const exports: JobWithId[] = [];
    for (let i = 0; i < 55; i++) exports.push(await create('batch_jpeg_export', i));
    const doneRecipe = await create('batch_recipe_export', 55);
    await completeJob(doneRecipe._id, { files: 1 }, undefined, undefined, live.handle);
    const queuedRecipe = await create('batch_recipe_export', 56);
    const restores: JobWithId[] = [];
    for (let i = 0; i < 60; i++) {
      const job = await create('cloud_backup_restore', 60 + i);
      restores.push(job);
      if (i % 2 === 0) await completeJob(job._id, { files: 1 }, undefined, undefined, live.handle);
    }
    const list = async (query = '', token = member) => {
      const response = await app.handle(
        new Request(`http://localhost/api/jobs${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { jobs: { id: string; kind: JobKind; status: string }[] };
    };
    const ids = (jobs: { id: string }[]) => jobs.map((job) => job.id);
    const expectedMember = [queuedRecipe, doneRecipe, ...exports.toReversed()].map((job) =>
      job._id.toHexString(),
    );
    const defaultPage = await list();
    expect(ids(defaultPage.jobs)).toEqual(expectedMember.slice(0, 50));
    expect(defaultPage.jobs.every((job) => job.kind !== 'cloud_backup_restore')).toBe(true);
    expect(ids((await list('?limit=2')).jobs)).toEqual(expectedMember.slice(0, 2));
    expect(ids((await list('?limit=200')).jobs)).toEqual(expectedMember);
    expect(ids((await list('?status=queued&limit=2')).jobs)).toEqual([
      queuedRecipe._id.toHexString(),
      exports[54]!._id.toHexString(),
    ]);
    expect(ids((await list('?kind=batch_jpeg_export&limit=2')).jobs)).toEqual([
      exports[54]!._id.toHexString(),
      exports[53]!._id.toHexString(),
    ]);
    expect(ids((await list('?kind=batch_recipe_export&status=done')).jobs)).toEqual([
      doneRecipe._id.toHexString(),
    ]);
    expect((await list('?kind=cloud_backup_restore&limit=200')).jobs).toEqual([]);
    expect((await list('?kind=cloud_backup_restore&status=done')).jobs).toEqual([]);

    const ownerPage = await list('', owner);
    expect(ids(ownerPage.jobs)).toEqual(
      restores
        .toReversed()
        .slice(0, 50)
        .map((job) => job._id.toHexString()),
    );
    expect(ids((await list('?kind=cloud_backup_restore&limit=3', owner)).jobs)).toEqual(
      restores
        .toReversed()
        .slice(0, 3)
        .map((job) => job._id.toHexString()),
    );
    expect(ids((await list('?kind=cloud_backup_restore&status=done&limit=2', owner)).jobs)).toEqual(
      [restores[58]!._id.toHexString(), restores[56]!._id.toHexString()],
    );
    expect(ids((await list('?kind=batch_jpeg_export&limit=2', owner)).jobs)).toEqual([
      exports[54]!._id.toHexString(),
      exports[53]!._id.toHexString(),
    ]);
  } finally {
    process.env.MAPLE_JWT_SECRET = previous;
  }
});
