/**
 * One bounded stretch of a library root's discover sweep, the unit a Temporal
 * activity runs. A slice claims, visits and paces directories exactly as the
 * long-lived loop it replaced did, including advancing to the next generation
 * when one drains, and ends only once its time is up, once its root is no
 * longer registered, or once it is told to stop. So a root costs Temporal about
 * one activity per ten minutes however small it is. Stopping always waits for
 * the directory in hand, so a slice never leaves a visit half done.
 */
import { setTimeout as sleepFor } from 'node:timers/promises';
import type { ObjectId } from '../../db/object-id.ts';
import { listLibraryRoots } from '../../db/repos/folders.repo.ts';
import { readCheckpoint } from '../../db/repos/indexer-checkpoints.repo.ts';
import * as frontier from './frontier.repo.ts';
import { advanceSweep, visitDirectory, type ReconcileDeps } from './sweeper.ts';

const LEASE_MS = 5 * 60 * 1000;
const SLICE_MS_DEFAULT = 10 * 60 * 1000;
const HEARTBEAT_EVERY_MS_DEFAULT = 30_000;
const IDLE_MS_FLOOR = 1000;

export interface SweepConfig {
  paused: boolean;
  sweepDirIntervalMs: number;
}

/** What a slice reports with every heartbeat. */
export interface SliceProgress {
  root: string;
  generation: number;
  generationsCompleted: number;
  directoriesVisited: number;
}

export interface SweepSliceSummary {
  /** The generation the root's next slice sweeps. */
  generation: number;
  generationsCompleted: number;
  directoriesVisited: number;
  /** False once the root has left the library list: nothing should sweep it again. */
  registered: boolean;
}

export interface SweepSliceOpts {
  folderId: ObjectId;
  root: string;
  deps: ReconcileDeps;
  loadConfig: () => Promise<SweepConfig>;
  heartbeat: (progress: SliceProgress) => void;
  signal?: AbortSignal;
  maxSliceMs?: number;
  /** The longest a paused or idle slice goes without a heartbeat. */
  heartbeatEveryMs?: number;
  isRegistered?: () => Promise<boolean>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onVisit?: (dirPath: string) => void;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  sleepFor(ms, undefined, { signal }).catch(() => {});

const stillRegistered = (folderId: ObjectId, root: string) => async (): Promise<boolean> =>
  (await listLibraryRoots()).some(
    (library) => library.id.toHexString() === folderId.toHexString() && library.path === root,
  );

/**
 * The generation a restarted sweep picks up from its checkpoint. The root is
 * seeded only when that generation has nothing queued: a fresh root, or a crash
 * between recording a finished walk and seeding the next one.
 */
async function resumeGeneration(folderId: ObjectId, root: string): Promise<number> {
  const generation = (await readCheckpoint(folderId.toHexString()))?.sweepGen ?? 1;
  if ((await frontier.remainingForGen(folderId, generation)) === 0)
    await frontier.seedRoot(folderId, root, generation);
  return generation;
}

class SweepSlice {
  private generation = 1;
  private visited = 0;
  private completed = 0;
  private readonly deadline: number;
  private readonly signal: AbortSignal;
  private readonly heartbeatEveryMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly isRegistered: () => Promise<boolean>;
  private readonly deps: ReconcileDeps;

  constructor(private readonly o: SweepSliceOpts) {
    this.deadline = Date.now() + (o.maxSliceMs ?? SLICE_MS_DEFAULT);
    this.signal = o.signal ?? new AbortController().signal;
    this.heartbeatEveryMs = o.heartbeatEveryMs ?? HEARTBEAT_EVERY_MS_DEFAULT;
    this.sleep = o.sleep ?? abortableSleep;
    this.isRegistered = o.isRegistered ?? stillRegistered(o.folderId, o.root);
    this.deps = { ...o.deps, handleEvent: this.beatingAfter(o.deps.handleEvent) };
  }

  async run(): Promise<SweepSliceSummary> {
    if (!(await this.isRegistered())) return this.summary(false);
    this.generation = await resumeGeneration(this.o.folderId, this.o.root);
    for (;;) {
      if (this.signal.aborted || Date.now() >= this.deadline) return this.summary(true);
      if (!(await this.isRegistered())) return this.summary(false);
      await this.step(await this.o.loadConfig());
    }
  }

  private summary(registered: boolean): SweepSliceSummary {
    return {
      generation: this.generation,
      generationsCompleted: this.completed,
      directoriesVisited: this.visited,
      registered,
    };
  }

  private beat(): void {
    this.o.heartbeat({
      root: this.o.root,
      generation: this.generation,
      generationsCompleted: this.completed,
      directoriesVisited: this.visited,
    });
  }

  /** A directory of thousands of new files can outlast the heartbeat timeout on its own. */
  private beatingAfter(handle: ReconcileDeps['handleEvent']): ReconcileDeps['handleEvent'] {
    return async (event, folderId, libraryRoot) => {
      await handle(event, folderId, libraryRoot);
      this.beat();
    };
  }

  /** One claim→visit→pace cycle, or one paused or idle wait. */
  private async step(config: SweepConfig): Promise<void> {
    const idleMs = Math.max(IDLE_MS_FLOOR, config.sweepDirIntervalMs);
    if (config.paused) {
      await this.pace(idleMs);
      return;
    }
    const dir = await frontier.claimNextDir(this.o.folderId, this.generation, LEASE_MS);
    if (!dir) {
      const next = await advanceSweep(this.o.folderId, this.o.root, this.generation);
      if (next !== this.generation) this.completed += 1;
      this.generation = next;
      await this.pace(idleMs);
      return;
    }
    this.o.onVisit?.(dir.dir_path);
    await visitDirectory(dir, this.o.root, this.deps);
    this.visited += 1;
    this.beat();
    await this.pace(config.sweepDirIntervalMs);
  }

  /** Waits `ms`, heartbeating at least every `heartbeatEveryMs`; a stop cuts it short. */
  private async pace(ms: number): Promise<void> {
    for (let left = ms; left > 0 && !this.signal.aborted; left -= this.heartbeatEveryMs) {
      await this.sleep(Math.min(left, this.heartbeatEveryMs), this.signal);
      this.beat();
    }
  }
}

export const runSweepSlice = (opts: SweepSliceOpts): Promise<SweepSliceSummary> =>
  new SweepSlice(opts).run();
