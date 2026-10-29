/**
 * Admitting pano jobs. One stitch may be queued or running at a time and no
 * preview runs beside it, because a stitch peaks at tens of GB. The job store
 * enforces that in the insert statement itself (`jobs.sql.ts`), so two requests
 * racing past the read below still produce one job; the read only lets a repeat
 * of the running stitch rejoin it without a failed insert. A new stitch cancels
 * the previews it supersedes so they do not hold the single-worker runner.
 */
import { createJob, JobConflictError, listJobs, requestCancel } from '../job-runner/jobs.repo.ts';
import type { JobWithId } from '../db/schema.ts';
import { repeatsRunningStitch, type StitchIdentity } from './pano-stitch-rejoin.ts';

export async function activePanoJob(kind: 'pano_stitch' | 'pano_preview') {
  const [active] = await listJobs({ kind, statuses: ['queued', 'running'], limit: 1 });
  return active ?? null;
}

export function panoJobRunning(jobId: JobWithId['_id']) {
  return {
    error: 'pano_job_running',
    message: 'A panorama job is already running or queued. Wait for it to finish.',
    jobId: jobId.toHexString(),
  };
}

async function supersedeActivePreviews(): Promise<number> {
  const active = await listJobs({
    kind: 'pano_preview',
    statuses: ['queued', 'running'],
    limit: 50,
  });
  await Promise.all(active.map((job) => requestCancel(job._id)));
  return active.length;
}

type PanoJobPayload = StitchIdentity & Record<string, unknown>;

export type StitchAdmission =
  | { created: JobWithId }
  | { rejoined: JobWithId }
  | { running: JobWithId };

const againstActive = (active: JobWithId, payload: PanoJobPayload): StitchAdmission =>
  repeatsRunningStitch(active, payload) ? { rejoined: active } : { running: active };

/** The stitch that holds the slot after a fenced insert was refused. */
async function fencedOutBy(err: unknown): Promise<JobWithId> {
  const winner = err instanceof JobConflictError ? await activePanoJob('pano_stitch') : null;
  if (winner === null) throw err;
  return winner;
}

export async function admitPanoStitch(payload: PanoJobPayload): Promise<StitchAdmission> {
  const active = await activePanoJob('pano_stitch');
  if (active !== null) return againstActive(active, payload);
  const created = await createJob({ kind: 'pano_stitch', payload }).catch(async (err: unknown) =>
    againstActive(await fencedOutBy(err), payload),
  );
  if (!('_id' in created)) return created;
  await supersedeActivePreviews();
  return { created };
}

export type PreviewAdmission = { created: JobWithId; superseded: number } | { running: JobWithId };

export async function admitPanoPreview(payload: PanoJobPayload): Promise<PreviewAdmission> {
  const superseded = await supersedeActivePreviews();
  try {
    return { created: await createJob({ kind: 'pano_preview', payload }), superseded };
  } catch (err) {
    return { running: await fencedOutBy(err) };
  }
}
