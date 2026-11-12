/**
 * `POST /api/people/cluster` — a `people_cluster` operation the worker tier
 * runs through the same coordinator as the face-embed stage's automatic
 * passes. The answer comes from a pass that started after the request did.
 */

import { Elysia, t } from 'elysia';
import {
  awaitOperation,
  DEFAULT_OPERATION_WAIT,
  operationDeadline,
  startFreshOperation,
  type OperationWait,
} from '../job-runner/operations.ts';

const ClusterBody = t.Optional(
  t.Object({
    similarity_threshold: t.Optional(t.Number()),
  }),
);

export const peopleClusterRoutes = (wait: OperationWait = DEFAULT_OPERATION_WAIT) =>
  new Elysia({ prefix: '/api/people' }).post(
    '/cluster',
    async ({ body, set, request }) => {
      const payload =
        typeof body?.similarity_threshold === 'number'
          ? { similarity_threshold: body.similarity_threshold }
          : {};
      const until = operationDeadline(wait, request.signal);
      const job = await startFreshOperation('people_cluster', payload, until);
      const finished = await awaitOperation(job._id, until);
      if (finished === null) {
        set.status = 504;
        return { error: 'Clustering is still running and will finish in the background' };
      }
      if (finished.status !== 'done' || finished.result === null) {
        set.status = 500;
        return { error: finished.error ?? `Clustering ${finished.status}` };
      }
      return {
        assigned: Number(finished.result['assigned'] ?? 0),
        new_people: Number(finished.result['new_people'] ?? 0),
        scanned: Number(finished.result['scanned'] ?? 0),
      };
    },
    { body: ClusterBody },
  );
