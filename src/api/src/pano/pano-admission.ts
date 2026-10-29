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

/** A fenced insert can be refused by a stitch that finishes before it is read
 * back; the slot is then free, so admission is simply tried again. */
const ADMISSION_ATTEMPTS = 3;

type InsertOutcome = { created: JobWithId } | { winner: JobWithId | null; refusal: unknown };

/** The new job, or the stitch holding the slot when the fence refused it
 * (null when that stitch has already finished). */
async function insertOrWinner(
  kind: 'pano_stitch' | 'pano_preview',
  payload: PanoJobPayload,
): Promise<InsertOutcome> {
  try {
    return { created: await createJob({ kind, payload }) };
  } catch (err) {
    if (!(err instanceof JobConflictError)) throw err;
    return { winner: await activePanoJob('pano_stitch'), refusal: err };
  }
}

export async function admitPanoStitch(
  payload: PanoJobPayload,
  attemptsLeft = ADMISSION_ATTEMPTS,
): Promise<StitchAdmission> {
  const active = await activePanoJob('pano_stitch');
  if (active !== null) return againstActive(active, payload);
  const outcome = await insertOrWinner('pano_stitch', payload);
  if ('created' in outcome) {
    await supersedeActivePreviews();
    return outcome;
  }
  if (outcome.winner !== null) return againstActive(outcome.winner, payload);
  if (attemptsLeft <= 1) throw outcome.refusal;
  return admitPanoStitch(payload, attemptsLeft - 1);
}

export type PreviewAdmission = { created: JobWithId; superseded: number } | { running: JobWithId };

export async function admitPanoPreview(
  payload: PanoJobPayload,
  attemptsLeft = ADMISSION_ATTEMPTS,
): Promise<PreviewAdmission> {
  const superseded = await supersedeActivePreviews();
  const outcome = await insertOrWinner('pano_preview', payload);
  if ('created' in outcome) return { created: outcome.created, superseded };
  if (outcome.winner !== null) return { running: outcome.winner };
  if (attemptsLeft <= 1) throw outcome.refusal;
  return admitPanoPreview(payload, attemptsLeft - 1);
}
