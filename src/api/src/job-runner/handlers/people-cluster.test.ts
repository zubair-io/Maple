/**
 * The clustering handler shares the worker tier's coordinator with the
 * face-embed stage's automatic passes: a requested pass arriving while an
 * automatic one runs never overlaps it, and answers from a pass that started
 * after it arrived.
 */

import { describe, expect, it } from 'bun:test';
import { ObjectId } from '../../db/object-id.ts';
import { ClusterCoordinator } from '../../people/cluster-coordinator.ts';
import type { RunOnlineClusteringResult } from '../../people/clustering-job.ts';
import type { JobHandlerContext } from './index.ts';
import { peopleClusterHandlerFor } from './people-cluster.ts';

const ctx: JobHandlerContext = {
  jobId: new ObjectId(),
  reportProgress: async () => {},
  shouldCancel: async () => false,
};

describe('people_cluster', () => {
  it('runs a pass with the requested threshold and records its counts', async () => {
    const options: unknown[] = [];
    const coordinator = new ClusterCoordinator({
      faceThreshold: 10,
      runner: async (passOptions) => {
        options.push(passOptions);
        return { assigned: 3, newPeople: 2, scanned: 5 };
      },
    });

    const outcome = await peopleClusterHandlerFor(() => coordinator).run(
      { similarity_threshold: 0.6 },
      ctx,
    );

    expect(outcome).toEqual({
      kind: 'done',
      result: { assigned: 3, new_people: 2, scanned: 5 },
    });
    expect(options).toEqual([{ similarityThreshold: 0.6 }]);
  });

  it('never runs beside an automatic pass, and answers from the pass after it', async () => {
    const passes: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    let releaseAutomatic = () => {};
    const automaticBlocked = new Promise<void>((resolve) => {
      releaseAutomatic = resolve;
    });
    const coordinator = new ClusterCoordinator({
      faceThreshold: 1,
      runner: async (): Promise<RunOnlineClusteringResult> => {
        inFlight += 1;
        overlapped ||= inFlight > 1;
        passes.push(passes.length === 0 ? 'automatic' : 'requested');
        if (passes.length === 1) await automaticBlocked;
        inFlight -= 1;
        return { assigned: passes.length, newPeople: 0, scanned: passes.length };
      },
    });
    coordinator.recordFacesEmbedded(1);

    const requested = peopleClusterHandlerFor(() => coordinator).run({}, ctx);
    releaseAutomatic();

    expect(await requested).toEqual({
      kind: 'done',
      result: { assigned: 2, new_people: 0, scanned: 2 },
    });
    expect(passes).toEqual(['automatic', 'requested']);
    expect(overlapped).toBe(false);
  });
});
