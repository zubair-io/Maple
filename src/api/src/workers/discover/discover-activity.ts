/**
 * The activity behind every discover workflow: one slice of one library root's
 * sweep, heartbeating as it goes.
 */

import { Context } from '@temporalio/activity';
import { listLibraryRoots } from '../../db/repos/folders.repo.ts';
import { loadDiscoverConfig } from './discover-config.repo.ts';
import { handleEvent } from './handle-event.ts';
import {
  runSweepSlice,
  type SliceProgress,
  type SweepSliceOpts,
  type SweepSliceSummary,
} from './sweep-slice.ts';
import type { ReconcileDeps } from './sweeper.ts';

export interface DiscoverActivities {
  sweepRoot: (rootKey: string) => Promise<SweepSliceSummary>;
}

/** What tests shorten or replace; production takes every default. */
export interface DiscoverSliceOptions extends Partial<
  Pick<SweepSliceOpts, 'maxSliceMs' | 'heartbeatEveryMs' | 'sleep'>
> {
  handleEvent?: ReconcileDeps['handleEvent'];
}

type Heartbeat = (progress: SliceProgress) => void;

type SliceRunner = (
  rootKey: string,
  heartbeat: Heartbeat,
  signal: AbortSignal,
) => Promise<SweepSliceSummary>;

const GONE: SweepSliceSummary = { generation: 0, directoriesVisited: 0, registered: false };

/** A root's key is its library id, which is also what names its workflow. */
function sliceRunner({ handleEvent: onEvent, ...pacing }: DiscoverSliceOptions): SliceRunner {
  return async (rootKey, heartbeat, signal) => {
    const library = (await listLibraryRoots()).find((root) => root.id.toHexString() === rootKey);
    if (library === undefined) return GONE;
    return runSweepSlice({
      ...pacing,
      folderId: library.id,
      root: library.path,
      deps: { folderId: library.id, handleEvent: onEvent ?? handleEvent },
      loadConfig: loadDiscoverConfig,
      heartbeat,
      signal,
    });
  };
}

/**
 * Temporal redelivers a slice it lost contact with even when the slice is in
 * fact still running here, as it can be after a long network outage. Two slices
 * of one root would claim against each other, so the later delivery joins the
 * running slice, heartbeating with it, and ends the way it does.
 */
export function singleFlightPerRoot(run: SliceRunner): SliceRunner {
  const running = new Map<string, { done: Promise<SweepSliceSummary>; beats: Set<Heartbeat> }>();
  return (rootKey, heartbeat, signal) => {
    const current = running.get(rootKey);
    if (current !== undefined) {
      current.beats.add(heartbeat);
      return current.done;
    }
    const beats = new Set([heartbeat]);
    const fanOut: Heartbeat = (progress) => beats.forEach((beat) => beat(progress));
    const done = run(rootKey, fanOut, signal).finally(() => running.delete(rootKey));
    running.set(rootKey, { done, beats });
    return done;
  };
}

/**
 * The activity's cancellation signal fires when the workflow is cancelled or
 * terminated and when this worker shuts down; either way the slice ends at the
 * next directory boundary.
 */
export function createDiscoverActivities(options: DiscoverSliceOptions = {}): DiscoverActivities {
  const sweep = singleFlightPerRoot(sliceRunner(options));
  return {
    sweepRoot: (rootKey) => {
      const context = Context.current();
      return sweep(rootKey, (progress) => context.heartbeat(progress), context.cancellationSignal);
    },
  };
}
