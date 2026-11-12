/**
 * `POST /api/people/cluster` keeps its synchronous answer while the pass runs
 * on the worker tier: the route leaves a `people_cluster` row, waits for it,
 * and answers from the row's result. The handler stands in for the pass here;
 * `job-runner/handlers/people-cluster.test.ts` covers the real one. A run
 * already going when the request arrives is waited out and followed by one of
 * the request's own.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import type { JobHandler } from '../job-runner/handlers/index.ts';
import { withOperationsRunning } from '../job-runner/operation-runner.test-helpers.ts';
import { claimJob, completeJob, createJob } from '../job-runner/jobs.repo.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { peopleClusterRoutes } from './people-cluster.ts';

let live: LiveTestDatabase;

beforeEach(async () => {
  live = await createLiveTestDatabase();
});

afterEach(() => {
  live.close();
});

const FAST = { timeoutMs: 30_000, intervalMs: 5 };

const cluster = (body: unknown = {}, wait = FAST) =>
  new Elysia()
    .use(fakeAuth())
    .use(peopleClusterRoutes(wait))
    .handle(
      new Request('http://localhost/api/people/cluster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

const clusterRows = () =>
  live.db.query(`SELECT status, params FROM jobs WHERE kind = 'people_cluster'`).all() as {
    status: string;
    params: string;
  }[];

const stubCluster = (run: JobHandler['run']) => ({ handlers: { people_cluster: { run } } });

describe('POST /api/people/cluster', () => {
  it('answers the counts the worker recorded on the row', async () => {
    const res = await withOperationsRunning(
      () => cluster(),
      stubCluster(async () => ({
        kind: 'done',
        result: { assigned: 3, new_people: 2, scanned: 3 },
      })),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assigned: 3, new_people: 2, scanned: 3 });
    expect(clusterRows()).toEqual([{ status: 'done', params: '{}' }]);
  });

  it('carries the similarity threshold to the pass', async () => {
    const seen: unknown[] = [];
    await withOperationsRunning(
      () => cluster({ similarity_threshold: 0.7 }),
      stubCluster(async (payload) => {
        seen.push(payload);
        return { kind: 'done', result: { assigned: 0, new_people: 0, scanned: 0 } };
      }),
    );

    expect(seen).toEqual([{ similarity_threshold: 0.7 }]);
  });

  it('answers 500 with the error when the pass fails', async () => {
    const res = await withOperationsRunning(
      () => cluster(),
      stubCluster(async () => {
        throw new Error('faces table locked');
      }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'faces table locked' });
  });

  it('answers 504 when the pass outlasts the wait, and leaves the row to finish', async () => {
    const res = await cluster({}, { timeoutMs: 30, intervalMs: 5 });

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: 'Clustering is still running and will finish in the background',
    });
    expect(clusterRows()).toEqual([{ status: 'queued', params: '{}' }]);
  });

  it('waits out a pass already running, then answers from one of its own', async () => {
    const earlier = await createJob({ kind: 'people_cluster', payload: {} });
    await claimJob(earlier._id, 'automatic');
    const answered = { yet: false };

    const response = withOperationsRunning(
      () => cluster(),
      stubCluster(async () => ({
        kind: 'done',
        result: { assigned: 1, new_people: 0, scanned: 4 },
      })),
    ).then((res) => {
      answered.yet = true;
      return res;
    });
    await sleep(100);
    const whileEarlierRuns = {
      answered: answered.yet,
      rows: clusterRows().map((row) => row.status),
    };
    await completeJob(
      earlier._id,
      { assigned: 9, new_people: 9, scanned: 9 },
      undefined,
      'automatic',
    );
    const res = await response;

    expect(whileEarlierRuns).toEqual({ answered: false, rows: ['running'] });
    expect(await res.json()).toEqual({ assigned: 1, new_people: 0, scanned: 4 });
    expect(clusterRows().map((row) => row.status)).toEqual(['done', 'done']);
  });
});
