/**
 * Pano admission when two requests race past the active-job read: the insert
 * fence refuses the loser, which then rejoins or refuses against the winner.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import * as jobsRepo from '../job-runner/jobs.repo.ts';
import { admitPanoPreview, admitPanoStitch } from './pano-admission.ts';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

const stitchPayload = (assetIds: string[]) => ({
  assetIds,
  libraryId: 'lib',
  retention: 'keep',
  localAlign: 'mesh',
  strategy: null,
});

/** The race: the read before the insert has not yet seen the winning stitch. */
const missTheWinnerOnce = () => spyOn(jobsRepo, 'listJobs').mockImplementationOnce(async () => []);

describe('admitPanoStitch behind a racing request', () => {
  it('rejoins the winner when it is the same stitch', async () => {
    const winner = await admitPanoStitch(stitchPayload(['a', 'b']));
    const read = missTheWinnerOnce();
    const insert = spyOn(jobsRepo, 'createJob');
    const loser = await admitPanoStitch(stitchPayload(['b', 'a']));
    expect(read).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
    read.mockRestore();
    insert.mockRestore();
    expect('created' in winner && 'rejoined' in loser).toBe(true);
    if ('created' in winner && 'rejoined' in loser) {
      expect(loser.rejoined._id.toHexString()).toBe(winner.created._id.toHexString());
    }
  });

  it('refuses a different stitch with the winner as the running job', async () => {
    await admitPanoStitch(stitchPayload(['a', 'b']));
    const read = missTheWinnerOnce();
    const loser = await admitPanoStitch(stitchPayload(['c', 'd']));
    read.mockRestore();
    expect('running' in loser).toBe(true);
  });

  it('admits the request when the winner finishes before it is read back', async () => {
    const refusal = new jobsRepo.JobConflictError('pano_stitch slot taken');
    const insert = spyOn(jobsRepo, 'createJob').mockRejectedValueOnce(refusal);
    try {
      const admitted = await admitPanoStitch(stitchPayload(['a', 'b']));
      expect('created' in admitted).toBe(true);
      expect(insert).toHaveBeenCalledTimes(2);
    } finally {
      insert.mockRestore();
    }
  });

  it('gives up with the fence refusal after a bounded number of attempts', async () => {
    const refusal = new jobsRepo.JobConflictError('pano_stitch slot taken');
    const insert = spyOn(jobsRepo, 'createJob').mockRejectedValue(refusal);
    try {
      await expect(admitPanoStitch(stitchPayload(['a', 'b']))).rejects.toBe(refusal);
      expect(insert).toHaveBeenCalledTimes(3);
    } finally {
      insert.mockRestore();
    }
  });

  it('propagates a failure that is not the fence', async () => {
    const create = spyOn(jobsRepo, 'createJob').mockRejectedValueOnce(new Error('disk full'));
    await expect(admitPanoStitch(stitchPayload(['a', 'b']))).rejects.toThrow('disk full');
    create.mockRestore();
  });
});

describe('admitPanoPreview', () => {
  it('is refused while a stitch holds the slot', async () => {
    await admitPanoStitch(stitchPayload(['a', 'b']));
    const preview = await admitPanoPreview(stitchPayload(['a', 'b']));
    expect('running' in preview).toBe(true);
  });

  it('is admitted when the stitch that refused it finishes before it is read back', async () => {
    const refusal = new jobsRepo.JobConflictError('pano_stitch slot taken');
    const insert = spyOn(jobsRepo, 'createJob').mockRejectedValueOnce(refusal);
    try {
      const preview = await admitPanoPreview(stitchPayload(['a', 'b']));
      expect('created' in preview).toBe(true);
    } finally {
      insert.mockRestore();
    }
  });

  it('supersedes the previews already queued', async () => {
    const first = await admitPanoPreview(stitchPayload(['a', 'b']));
    const second = await admitPanoPreview(stitchPayload(['a', 'b']));
    expect(second).toMatchObject({ superseded: 1 });
    if ('created' in first) {
      expect((await jobsRepo.getJob(first.created._id))?.cancel_requested).toBe(true);
    }
  });
});
