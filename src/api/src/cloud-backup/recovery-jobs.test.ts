import { expect, test } from 'bun:test';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { createJob, failJob, getJob, markCancelled } from '../db/repos/jobs.repo.ts';
import { resumeRecoveryJob } from './recovery-jobs.ts';
test('resume retains recovery identity and checkpoint, resets cancellation, and excludes another destination or job kind', async () => {
  using live = await createLiveTestDatabase();
  const destinationId = crypto.randomUUID();
  const checkpoint = {
    owned: ['photo.dng'],
    targetPath: '/recovery',
    selection: [{ entryId: 'pinned' }],
  };
  const job = await createJob({
    kind: 'cloud_backup_restore',
    payload: { destinationId, targetPath: '/recovery' },
    checkpoint,
  });
  expect(await resumeRecoveryJob(destinationId, job._id.toHexString(), live.handle)).toBe(false);
  await failJob(job._id, 'temporary Google failure');
  expect(await resumeRecoveryJob('another-destination', job._id.toHexString(), live.handle)).toBe(
    false,
  );
  expect(await resumeRecoveryJob(destinationId, job._id.toHexString(), live.handle)).toBe(true);
  expect((await getJob(job._id))!.checkpoint).toEqual(checkpoint);
  expect((await getJob(job._id))!.status).toBe('queued');
  await markCancelled(job._id);
  await live.handle.write('UPDATE jobs SET cancel_requested=1 WHERE id=?', [job._id.toHexString()]);
  expect(await resumeRecoveryJob(destinationId, job._id.toHexString(), live.handle)).toBe(true);
  expect((await getJob(job._id))!.cancel_requested).toBe(false);
  const unrelated = await createJob({ kind: 'batch_jpeg_export', payload: { destinationId } });
  await failJob(unrelated._id, 'failure');
  expect(await resumeRecoveryJob(destinationId, unrelated._id.toHexString(), live.handle)).toBe(
    false,
  );
});
