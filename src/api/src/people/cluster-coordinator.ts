/**
 * Auto-clustering coordinator.
 *
 * Bridges the `face-embed` worker stage to `runOnlineClustering` so faces
 * get grouped into `PersonDoc`s automatically as they're embedded — no
 * human clicking "Run clustering". Two triggers, both routed through this
 * coordinator's single-flight guard:
 *
 *   1. Idle edge — when `face-embed` drains its queue (a tick claims zero
 *      docs after having processed at least one face since the last pass),
 *      run one clustering pass. We fire on the WORK → DRAINED edge only, not
 *      on every idle tick, so a stage that sits idle at rest doesn't
 *      re-cluster forever.
 *
 *   2. Every N faces — `runOnlineClustering` is incremental + idempotent (it
 *      only assigns faces missing `person_id`), so we also fire a pass once
 *      `threshold` faces have been embedded since the last pass. People then
 *      populate progressively during a long embed run instead of only at the
 *      very end.
 *
 * Single-flight (critical): `runOnlineClustering` walks the whole faces
 * space; two concurrent passes would race on the same `person_id` writes.
 * The coordinator holds an in-flight promise and coalesces: a trigger that
 * fires mid-pass sets a `dirty` flag and exactly ONE follow-up pass runs
 * when the current one finishes — never a queue of N.
 *
 * The manual `POST /api/people/cluster` route also runs through
 * `runClusterNow()` so an operator click and an auto-trigger can never run
 * two passes at once; they share the same single-flight + coalescing.
 *
 * `runOnlineClustering` is injected (constructor dependency) so unit tests
 * can stub it and exercise the trigger/single-flight logic without Mongo.
 */

import { child as childLogger } from '../log.ts';
import {
  runOnlineClustering as runOnlineClusteringImpl,
  type RunOnlineClusteringOptions,
  type RunOnlineClusteringResult,
} from './clustering-job.ts';

const log = childLogger('people:auto-cluster');

/** Run a clustering pass. Matches `runOnlineClustering`'s signature so the
 * production impl drops straight in and tests can substitute a stub. */
export type ClusterRunner = (
  options?: RunOnlineClusteringOptions,
) => Promise<RunOnlineClusteringResult>;

/** Default face count between auto-cluster passes during a long embed run. */
export const DEFAULT_AUTOCLUSTER_FACE_THRESHOLD = 500;

/**
 * Resolve the N-faces threshold from `MAPLE_AUTOCLUSTER_FACE_THRESHOLD`.
 * Mirrors `resolveOrtThreadCount` in face-models.ts: unset → fallback;
 * non-integer / < 1 → warn loud + fallback (a zero/negative threshold would
 * fire a pass every tick, which is exactly the misconfig to reject).
 */
export function resolveAutoclusterThreshold(
  raw: string | undefined,
  fallback: number = DEFAULT_AUTOCLUSTER_FACE_THRESHOLD,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    log.warn(
      { raw, fallback },
      'invalid MAPLE_AUTOCLUSTER_FACE_THRESHOLD; falling back to default',
    );
    return fallback;
  }
  return n;
}

export interface ClusterCoordinatorOptions {
  /** Clustering implementation. Defaults to the real DB-backed
   * `runOnlineClustering`; tests inject a stub. */
  runner?: ClusterRunner;
  /** N-faces trigger threshold. Defaults to the env-resolved value. */
  faceThreshold?: number;
}

export class ClusterCoordinator {
  private readonly runner: ClusterRunner;
  private readonly faceThreshold: number;

  /** Faces processed since the last pass STARTED. Drives the N-faces
   * trigger and the idle "did any work?" gate. Reset when a pass begins. */
  private facesSinceLastPass = 0;
  /** True between a WORK tick and the DRAINED edge — lets us fire the idle
   * trigger exactly once on the falling edge, not on every idle tick. */
  private sawWorkSinceDrain = false;
  /** In-flight clustering pass, or null when idle. The single-flight lock. */
  private inFlight: Promise<void> | null = null;
  /** A trigger fired mid-pass — run exactly one more pass when this finishes. */
  private dirty = false;
  /** Result of the most recently COMPLETED pass — returned to manual callers
   * that coalesced onto someone else's pass so the route still reports counts. */
  private lastResult: RunOnlineClusteringResult = { assigned: 0, newPeople: 0, scanned: 0 };
  /** Options for the NEXT pass start. The manual route may pass a
   * `similarityThreshold` override; auto-triggers pass none (default 0.5).
   * Applied at the start of each pass and then cleared so a one-off manual
   * override doesn't leak into subsequent auto-passes. */
  private pendingOptions: RunOnlineClusteringOptions | undefined;

  constructor(opts: ClusterCoordinatorOptions = {}) {
    this.runner = opts.runner ?? runOnlineClusteringImpl;
    this.faceThreshold =
      opts.faceThreshold ??
      resolveAutoclusterThreshold(process.env.MAPLE_AUTOCLUSTER_FACE_THRESHOLD);
  }

  /**
   * Poll-tick notification from a worker stage (wired as `onProgress`).
   *
   * @param processedThisTick docs the stage claimed this tick.
   * @param idle true iff the claim query matched nothing this tick.
   */
  notifyProgress(processedThisTick: number, idle: boolean): void {
    if (processedThisTick > 0) {
      this.facesSinceLastPass += processedThisTick;
      this.sawWorkSinceDrain = true;
    }

    // N-faces trigger — progressive population during a long embed run.
    if (this.facesSinceLastPass >= this.faceThreshold) {
      log.info(
        { facesSinceLastPass: this.facesSinceLastPass, threshold: this.faceThreshold },
        'auto-cluster: N-faces threshold reached',
      );
      void this.trigger();
      return;
    }

    // Idle edge — fire once on WORK → DRAINED, and only if there's unclustered
    // work pending. Once drained, `sawWorkSinceDrain` is false so subsequent
    // idle ticks are no-ops (the stage is idle ~all the time at rest).
    if (idle && this.sawWorkSinceDrain && this.facesSinceLastPass > 0) {
      this.sawWorkSinceDrain = false;
      log.info(
        { facesSinceLastPass: this.facesSinceLastPass },
        'auto-cluster: face-embed drained — clustering pending faces',
      );
      void this.trigger();
    }
  }

  /**
   * Run a clustering pass now, coalescing with any in-flight pass. Public so
   * the manual `POST /api/people/cluster` route shares the same single-flight
   * lock as the auto-triggers. Resolves with the result of a pass that ran
   * AT OR AFTER this call (so a manual click always reflects fresh state).
   *
   * Manual-vs-auto concurrency: a manual click during an in-flight pass does
   * NOT run concurrently — it coalesces into the single guaranteed follow-up
   * pass, then reads `lastResult`. The follow-up rescans, so the returned
   * counts are correct for the post-call DB state, but they're the counts of
   * the COALESCED pass, which may also absorb faces from concurrent triggers.
   */
  async runClusterNow(options?: RunOnlineClusteringOptions): Promise<RunOnlineClusteringResult> {
    if (options) this.pendingOptions = options;
    if (this.inFlight) {
      // A pass is already running — force exactly one more pass after it so
      // this caller sees state at-or-after its own arrival, then drain.
      this.dirty = true;
      await this.inFlight;
      while (this.inFlight) await this.inFlight;
      return this.lastResult;
    }
    await this.trigger();
    while (this.inFlight) await this.inFlight;
    return this.lastResult;
  }

  /**
   * Start a pass if none is running; otherwise set `dirty` so exactly one
   * follow-up pass runs when the current finishes (coalesce). Returns the
   * in-flight promise.
   */
  private trigger(): Promise<void> {
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    this.inFlight = this.runPass();
    return this.inFlight;
  }

  /** One pass + drain of the coalesced `dirty` follow-up. Resets the face
   * accumulator at the START of each pass so faces embedded DURING the pass
   * count toward the next one. */
  private async runPass(): Promise<void> {
    try {
      do {
        this.dirty = false;
        this.facesSinceLastPass = 0;
        const options = this.pendingOptions;
        this.pendingOptions = undefined;
        try {
          const result = await this.runner(options);
          this.lastResult = result;
          log.info(
            {
              assigned: result.assigned,
              newPeople: result.newPeople,
              scanned: result.scanned,
            },
            'auto-cluster pass complete',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err, msg }, 'auto-cluster pass failed');
        }
        // Loop again iff a trigger fired while we were running.
      } while (this.dirty);
    } finally {
      this.inFlight = null;
    }
  }

  /** Test/inspection hooks — not used in production code paths. */
  get _state(): {
    facesSinceLastPass: number;
    sawWorkSinceDrain: boolean;
    inFlight: boolean;
    dirty: boolean;
    faceThreshold: number;
  } {
    return {
      facesSinceLastPass: this.facesSinceLastPass,
      sawWorkSinceDrain: this.sawWorkSinceDrain,
      inFlight: this.inFlight !== null,
      dirty: this.dirty,
      faceThreshold: this.faceThreshold,
    };
  }
}

// ── Process-wide singleton ─────────────────────────────────────────────
// One coordinator per process so the `face-embed` stage hook and the manual
// `/api/people/cluster` route share the same single-flight lock. Lazily
// constructed so the env knob is read at first use, not import time.

let singleton: ClusterCoordinator | null = null;

export function clusterCoordinator(): ClusterCoordinator {
  if (!singleton) singleton = new ClusterCoordinator();
  return singleton;
}
