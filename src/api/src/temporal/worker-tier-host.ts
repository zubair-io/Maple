/**
 * The host the worker tier runs: every lane, one worker each. Kept apart from
 * `temporal-host.ts` so a test fixture can serve only the lanes it exercises
 * without importing the others.
 */

import { importLane } from '../imports/import-queue.ts';
import { discoverLane } from '../workers/discover/discover-lane.ts';
import { jobLane } from '../job-runner/job-queue.ts';
import { operationLane } from '../job-runner/operation-queue.ts';
import { maintenanceLane } from '../workers/maintenance/lane.ts';
import { stageLane } from '../workers/stage-lane.ts';
import type { TemporalLane } from './temporal-lane.ts';
import { TemporalHost } from './temporal-host.ts';
import { installTemporalRuntime } from './temporal-runtime.ts';

/** Each lane gets a worker of its own, so none waits on another. */
export const defaultTemporalLanes = (): TemporalLane[] => [
  jobLane(),
  operationLane(),
  importLane(),
  stageLane(),
  discoverLane(),
  maintenanceLane(),
];

let singleton: TemporalHost | null = null;

export function startTemporalHost(): void {
  if (singleton) return;
  installTemporalRuntime();
  singleton = new TemporalHost({ lanes: defaultTemporalLanes() });
  singleton.start();
}

export async function stopTemporalHost(): Promise<void> {
  if (!singleton) return;
  await singleton.stop();
  singleton = null;
}
