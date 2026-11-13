/**
 * `people_cluster` — an operator's "Run clustering". It goes through the
 * worker tier's one cluster coordinator, the same one the face-embed stage
 * triggers, so a requested pass and an automatic one never run together.
 * It does not look for a cancel: the coordinator, not the row, is what keeps
 * a cancelled pass and the next request's pass apart.
 */

import { clusterCoordinator, type ClusterCoordinator } from '../../people/cluster-coordinator.ts';
import type { JobHandler } from './index.ts';

export function peopleClusterHandlerFor(coordinator: () => ClusterCoordinator): JobHandler {
  return {
    async run(payload) {
      const threshold = payload['similarity_threshold'];
      const result = await coordinator().runClusterNow(
        typeof threshold === 'number' ? { similarityThreshold: threshold } : undefined,
      );
      return {
        kind: 'done',
        result: {
          assigned: result.assigned,
          new_people: result.newPeople,
          scanned: result.scanned,
        },
      };
    },
  };
}

export const peopleClusterHandler = peopleClusterHandlerFor(clusterCoordinator);
