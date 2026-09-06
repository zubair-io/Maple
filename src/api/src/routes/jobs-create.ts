/** Both create and retry expose identity reuse as a client conflict, never a 500. */
import { createJob, JobRequestConflictError } from '../job-runner/jobs.repo.ts';
import type { CreateJobInput } from '../job-runner/jobs.repo.ts';

export async function createJobResponse(input: CreateJobInput) {
  try {
    const job = await createJob(input);
    return { status: 201, body: { id: job._id.toHexString() } };
  } catch (error) {
    if (error instanceof JobRequestConflictError)
      return { status: 409, body: { error: error.message } };
    throw error;
  }
}
