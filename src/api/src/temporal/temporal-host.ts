/**
 * The worker tier's link to Temporal: one connection, one worker per lane (jobs,
 * imports and pipeline stages) executing Maple's workflows and activities on
 * it, and the relay that hands each lane its work. It follows the saved settings without a
 * restart and keeps trying while the server is away, publishing what it sees
 * for Settings → Workers.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Runtime, Worker } from '@temporalio/worker';
import { child as childLogger } from '../log.ts';
import { importLane } from '../imports/import-queue.ts';
import { discoverLane } from '../workers/discover/discover-lane.ts';
import { jobLane } from '../job-runner/job-queue.ts';
import { stageLane } from '../workers/stage-lane.ts';
import type { TemporalLane } from './temporal-lane.ts';
import {
  loadTemporalSettings,
  reportTemporalConnection,
  type TemporalSettings,
} from './temporal-config.ts';
import { installTemporalRuntime } from './temporal-runtime.ts';

const log = childLogger('temporal');

const RELAY_MS_DEFAULT = 1_000;
const REFRESH_MS_DEFAULT = 10_000;
const RETRY_MS_DEFAULT = 5_000;

export interface TemporalHostOptions {
  lanes: TemporalLane[];
  relayMs?: number;
  /** Settings re-read, connection probe and status report share one cadence. */
  refreshMs?: number;
  retryMs?: number;
}

type Served = 'reconfigured' | 'stopped';

const DRAINING = 'Waiting for running work to finish before reconnecting';

/** What the last check found: whether the server answers, and whether any lane failed to reconcile. */
interface Standing {
  health: unknown;
  drift: unknown;
}

const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows.ts', import.meta.url));

/**
 * Bundled once per process: a server that stays unreachable is retried every
 * few seconds. A failed bundling is not kept, so the next retry bundles again.
 */
let workflowBundle: ReturnType<typeof bundleWorkflowCode> | null = null;
const bundledWorkflows = () =>
  (workflowBundle ??= bundleWorkflowCode({
    workflowsPath: WORKFLOWS_PATH,
    logger: Runtime.instance().logger,
  }).catch((error: unknown) => {
    workflowBundle = null;
    throw error;
  }));

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal }).catch(() => {});

const failureOf = (work: () => Promise<unknown>): Promise<unknown> =>
  work().then(
    () => null,
    (error: unknown) => error,
  );

/**
 * The SDK reports transport failures as a debug dump of nested Rust errors; the
 * innermost quoted message is the part an operator can act on.
 */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const quoted = [...raw.matchAll(/message: \\?"([^"\\]+)/g)].at(-1)?.[1];
  return (quoted ?? raw).slice(0, 300);
}

const sameTarget = (a: TemporalSettings, b: TemporalSettings): boolean =>
  a.address === b.address && a.namespace === b.namespace;

/** Each lane gets a worker of its own, so none waits on another. */
export const defaultTemporalLanes = (): TemporalLane[] => [
  jobLane(),
  importLane(),
  stageLane(),
  discoverLane(),
];

interface LaneRun {
  worker: Worker;
  ended: boolean;
  failure?: unknown;
  done: Promise<void>;
}

function runLane(worker: Worker, endSession: () => void): LaneRun {
  const lane: LaneRun = { worker, ended: false, done: Promise.resolve() };
  lane.done = worker
    .run()
    .catch((error: unknown) => {
      lane.failure = error;
    })
    .finally(() => {
      lane.ended = true;
      endSession();
    });
  return lane;
}

export class TemporalHost {
  private readonly relayMs: number;
  private readonly refreshMs: number;
  private readonly retryMs: number;
  private readonly lanes: TemporalLane[];

  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private lastLogged: string | null = null;

  constructor(options: TemporalHostOptions) {
    this.relayMs = options.relayMs ?? RELAY_MS_DEFAULT;
    this.refreshMs = options.refreshMs ?? REFRESH_MS_DEFAULT;
    this.retryMs = options.retryMs ?? RETRY_MS_DEFAULT;
    this.lanes = options.lanes;
  }

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  /** Resolves once every worker has drained, which waits for a job or import that is mid-run. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    this.loop = null;
  }

  private get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  private async report(settings: TemporalSettings, error: unknown): Promise<void> {
    const message = error === null ? null : errorMessage(error);
    const line = `${settings.address}/${settings.namespace}: ${message ?? 'connected'}`;
    if (line !== this.lastLogged) {
      this.lastLogged = line;
      if (message === null) log.info(settings, 'Temporal connected');
      else log.warn({ ...settings, err: message }, 'Temporal unreachable');
    }
    await reportTemporalConnection({
      ...settings,
      state: message === null ? 'connected' : 'unreachable',
      error: message,
      checkedAt: Date.now(),
    }).catch((err: unknown) => {
      log.warn({ err: errorMessage(err) }, 'could not record the Temporal connection state');
    });
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const served = await this.serveSaved();
      if (served === 'failed') await pause(this.retryMs, this.abort.signal);
    }
  }

  private async serveSaved(): Promise<Served | 'failed'> {
    let settings: TemporalSettings | null = null;
    try {
      settings = await loadTemporalSettings();
      return await this.serve(settings);
    } catch (error) {
      if (settings === null) log.warn({ err: errorMessage(error) }, 'Temporal settings unreadable');
      else await this.report(settings, error);
      return 'failed';
    }
  }

  private async serve(settings: TemporalSettings): Promise<Served> {
    const connection = await NativeConnection.connect({ address: settings.address });
    const session = new AbortController();
    const endSession = () => session.abort();
    this.abort.signal.addEventListener('abort', endSession, { once: true });
    if (this.stopping) endSession();
    const running: LaneRun[] = [];
    try {
      const bundle = await bundledWorkflows();
      for (const lane of this.lanes) {
        const worker = await Worker.create({
          connection,
          namespace: settings.namespace,
          taskQueue: lane.taskQueue,
          workflowBundle: bundle,
          activities: lane.activities,
          maxConcurrentActivityTaskExecutions: lane.concurrency,
          // A cancel made in Temporal reaches a handler on a heartbeat reply, and
          // handlers heartbeat whenever they report progress or ask about cancel.
          maxHeartbeatThrottleInterval: '5 seconds',
        });
        running.push(runLane(worker, endSession));
      }
      const client = new Client({ connection, namespace: settings.namespace });
      const served = await this.supervise(settings, client, session.signal);
      const ended = running.find((lane) => lane.ended);
      if (ended) throw ended.failure ?? new Error('The Temporal worker stopped');
      return served;
    } finally {
      this.abort.signal.removeEventListener('abort', endSession);
      for (const lane of running) if (lane.worker.getState() === 'RUNNING') lane.worker.shutdown();
      await this.drain(running);
      await connection.close();
    }
  }

  /**
   * A worker drains for as long as its running job or import takes, and nothing
   * is relayed meanwhile. Settings → Workers says so instead of going stale.
   */
  private async drain(running: LaneRun[]): Promise<void> {
    const draining = new AbortController();
    const drained = Promise.all(running.map((lane) => lane.done)).then(() => draining.abort());
    while (!draining.signal.aborted) {
      await pause(this.refreshMs, draining.signal);
      if (!draining.signal.aborted && !this.stopping) await this.reportDraining();
    }
    await drained;
  }

  private async reportDraining(): Promise<void> {
    const saved = await failureOf(() =>
      loadTemporalSettings().then((settings) => this.report(settings, new Error(DRAINING))),
    );
    if (saved !== null) log.warn({ err: errorMessage(saved) }, 'Temporal settings unreadable');
  }

  /**
   * The worker reconnects by itself, so a failure here is only reported. A
   * failed check stands until the next check: the quiet ticks in between have
   * nothing to send and would otherwise report the server as back. Only a
   * server that does not answer stops the relay; a lane that cannot reconcile
   * is reported while every lane keeps receiving its rows.
   */
  private async supervise(
    settings: TemporalSettings,
    client: Client,
    session: AbortSignal,
  ): Promise<Served> {
    let refreshAt = 0;
    let standing: Standing = { health: null, drift: null };
    let reported: string | null | undefined;
    while (!session.aborted) {
      const refreshing = Date.now() >= refreshAt;
      if (refreshing) standing = await this.inspect(client, settings);
      const error = await this.relayUnder(client, standing);
      const message = error === null ? null : errorMessage(error);
      if (refreshing || message !== reported) {
        reported = message;
        await this.report(settings, error);
      }
      if (refreshing) {
        refreshAt = Date.now() + this.refreshMs;
        if (!sameTarget(settings, await loadTemporalSettings())) return 'reconfigured';
      }
      await pause(this.relayMs, session);
    }
    return 'stopped';
  }

  private async inspect(client: Client, settings: TemporalSettings): Promise<Standing> {
    const health = await failureOf(() => this.probe(client, settings));
    return { health, drift: health ?? (await failureOf(() => this.reconcile(client))) };
  }

  private async relayUnder(client: Client, standing: Standing): Promise<unknown> {
    if (standing.health !== null) return standing.health;
    const relayed = await failureOf(() => this.relay(client));
    return standing.drift ?? relayed;
  }

  /** Every lane gets its turn whatever the others do; the first failure is the one reported. */
  private async eachLane(work: (lane: TemporalLane) => Promise<void>): Promise<void> {
    const failures = await Promise.all(this.lanes.map((lane) => failureOf(() => work(lane))));
    const failed = failures.find((failure) => failure !== null);
    if (failed !== undefined) throw failed;
  }

  private relay(client: Client): Promise<void> {
    return this.eachLane(async (lane) => lane.relay?.(client));
  }

  private reconcile(client: Client): Promise<void> {
    return this.eachLane(async (lane) => lane.reconcile?.(client));
  }

  private async probe(client: Client, settings: TemporalSettings): Promise<void> {
    await client.workflowService.describeNamespace({ namespace: settings.namespace });
  }
}

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
