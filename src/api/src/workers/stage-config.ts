/**
 * Stage definition, config plumbing, and version-bump reset.
 *
 * Extracted from `run-stage.ts` to keep that module under the 600-line file
 * budget (issue #740). This is the leaf half of the in-process stage runner:
 * the public `StageConfig`/`WorkerConfig`/`ImageDoc`/`StageContext`/
 * `StageResult`/`StageDep`/`StageState` types, the `defineStage` identity
 * helper, the boot-time `bootConfig` seed-or-load, the `versionBumpReset`
 * dead-doc requeue, and `resolveStageDeps` dependency normalisation.
 *
 * It has NO dependency on the poll loop, claim query, or `runStage` itself, so
 * there is no runtime import cycle back into `run-stage.ts`. Every symbol here
 * is re-exported from `run-stage.ts` so the existing import surface
 * (`import { defineStage, type ImageDoc } from './run-stage.ts'`, etc.) is
 * unchanged for every stage file and test.
 */

import type { Collection, Filter, WithId } from 'mongodb';
import type { Logger } from 'pino';
import { type IndexerAssetDoc } from '../indexer/images.repo.ts';
import { WorkerConfigRepo, type WorkerConfigDoc } from './worker-config.repo.ts';

// ---------------------------------------------------------------------------
// Public types — load-bearing for every stage file and stage test.
// ---------------------------------------------------------------------------

export interface StageState {
  /** Last version the handler ran at. 0 = never run. */
  version: number;
  /** Failed attempts at the current target version. Resets on success / bump. */
  attempts: number;
  /** Stringified error from the most recent failed attempt. */
  last_error: string | null;
  /** Wall-clock time of the most recent successful run. */
  processed_at: Date | null;
  /** True when attempts >= maxAttempts. Excluded from the claim query. */
  dead: boolean;
}

export type ImageDoc = WithId<IndexerAssetDoc> & {
  stages?: Record<string, StageState>;
};

export interface WorkerConfig {
  concurrency: number;
  maxAttempts: number;
  paused: boolean;
  /**
   * Last targetVersion the runner has seen. Compared against
   * StageConfig.targetVersion on boot to detect version bumps that
   * require a dead-doc reset.
   */
  last_seen_target_version: number;
}

export type StageResult<TPatch = Record<string, unknown>> =
  // `invalidates` lists downstream stages the runner marks stale (version 0,
  // bookkeeping cleared) in the SAME atomic $set as the patch, so their poll
  // loops re-claim the doc and rebuild from the freshly-patched fields. The
  // canonical caller is describe → meili: the caption/OCR usually lands after
  // the search index was already built (meili depends on exif+thumb only), so
  // without this the recovered text never becomes searchable (#2172). Done by
  // the runner — handlers cannot touch `stages.*` keys in the patch itself.
  | { patch: TPatch; invalidates?: readonly string[] }
  | { wrote: true }
  | { skip: string }
  // The handler determined the bytes are unreadable up front and no retry can
  // change that (e.g. a 0-byte file) — tag the asset `damaged` immediately
  // instead of throwing maxAttempts times to reach the same place. Only honored
  // for stages with `tagsDamagedOnDeadLetter`; the string is the operator-facing
  // reason recorded on the damaged tag (and the stage's last_error).
  | { damaged: string };

export interface StageContext {
  log: Logger;
  /** Canceled when the runner is shutting down. */
  signal: AbortSignal;
}

export type StageDep = string | { name: string; minVersion: number };

export interface StageConfig<TPatch = Record<string, unknown>> {
  name: string;
  /**
   * Bumping this on deploy triggers a dead-doc reset on boot and re-queues
   * all docs at the lower version.
   */
  targetVersion: number;
  /**
   * Stages whose version must reach a minimum before this stage's claim
   * query matches a doc.
   */
  dependsOn: StageDep[];
  defaults: WorkerConfig & {
    /**
     * Initial paused state when no worker_config doc exists yet. On
     * subsequent boots, the saved value is authoritative.
     */
    pausedOnFirstBoot: boolean;
  };
  /**
   * When true, a handler failure whose error is ENOENT is taken to mean the
   * on-disk original vanished: the runner stamps `missing_since` on the asset
   * (the "pending delete" tag the operator-gated missing-reaper consumes) in
   * addition to the normal attempts / dead bookkeeping. Set ONLY on stages
   * that read the original file (exif / thumb / preview) — never on stages
   * that read a derived artefact (a missing thumbnail must not be mistaken
   * for a missing original). A spurious tag is self-correcting: the reaper
   * re-stats on disk and clears the tag when the file is actually present.
   */
  tagsMissingOnEnoent?: boolean;
  /**
   * When true, a handler failure that EXHAUSTS retries (the attempt that pushes
   * `attempts >= maxAttempts`, i.e. the stage dead-letters) additionally stamps
   * `damaged` on the asset. That tag parks the file out of EVERY stage's claim
   * query (see `buildClaimQuery`) — the bytes can't be read, so the rest of the
   * pipeline stops retrying it — and surfaces it in the Workers "Damaged" list.
   *
   * Set ONLY on stages that read the ORIGINAL bytes and fail because those
   * bytes are unreadable (exif / thumb / preview). NEVER set it on a stage
   * whose dead-letter means something else (a describe LLM timeout, a geocode
   * HTTP 5xx) — those failures don't imply the file is damaged. ENOENT is
   * handled separately by `tagsMissingOnEnoent` and never reaches this path.
   */
  tagsDamagedOnDeadLetter?: boolean;
  /**
   * Optional extra Mongo predicate `AND`-ed into the claim query, so a stage
   * that only applies to a subset of assets never even claims the rest.
   *
   * Without it, a stage claims from the whole unprocessed pool and skips the
   * assets it doesn't handle in its handler — which stamps a pointless
   * `stages.<name>` skip-record on every non-matching asset and starves the
   * concurrency slots with skip work before the stage reaches anything real.
   * `transcribe` (video/audio only) sets this to a filename regex so it goes
   * straight to media assets and ignores the photo library. The handler's own
   * skips remain the correctness backstop — this is purely a claim-set
   * optimization, so a slightly loose filter is safe.
   *
   * Merged as `{ $and: [<base claim query>, claimFilter] }` in
   * `buildClaimQuery`; omit it and the claim query is unchanged.
   */
  claimFilter?: Filter<ImageDoc>;
  handler: (image: ImageDoc, ctx: StageContext) => Promise<StageResult<TPatch>>;
  /**
   * Optional per-tick progress hook, invoked by the poll loop after each
   * successful `runOnce` tick (NOT on a tick that threw — those go through
   * the retry/backoff path instead). Generic + opt-in: stages that don't
   * set it pay nothing. `face-embed` uses it to drive auto-clustering.
   *
   * @param processedThisTick docs claimed + dispatched this tick (0 = the
   *   claim query matched nothing — i.e. the stage is idle/drained).
   * @param idle convenience flag, `true` iff `processedThisTick === 0`.
   *
   * Best-effort: the loop awaits it but swallows + logs any rejection so a
   * misbehaving hook can never stall or crash the poll loop.
   */
  onProgress?: (processedThisTick: number, idle: boolean) => void | Promise<void>;
}

/** Zero-cost identity helper that provides `TPatch` inference at stage sites. */
export function defineStage<TPatch = Record<string, unknown>>(
  config: StageConfig<TPatch>,
): StageConfig<TPatch> {
  return config;
}

// ---------------------------------------------------------------------------
// Boot: load or seed worker_config for a stage.
// ---------------------------------------------------------------------------

export async function bootConfig(
  stage: StageConfig,
  coll: Collection<WorkerConfigDoc>,
): Promise<WorkerConfig> {
  const repo = new WorkerConfigRepo(coll);
  const existing = await repo.load(stage.name);

  const merged: WorkerConfig = {
    concurrency: pickInt(existing?.concurrency, stage.defaults.concurrency),
    maxAttempts: pickInt(existing?.maxAttempts, stage.defaults.maxAttempts),
    paused:
      typeof existing?.paused === 'boolean' ? existing.paused : stage.defaults.pausedOnFirstBoot,
    last_seen_target_version: pickInt(existing?.last_seen_target_version, 0),
  };

  // Idempotent. On first boot, seeds defaults; on subsequent boots, either
  // no-ops (when the doc was already complete) or repairs missing fields
  // written by a PATCH that landed before the first bootConfig.
  await repo.upsert(stage.name, merged);
  return merged;
}

function pickInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Version-bump reset: re-queue dead docs when targetVersion was bumped.
// ---------------------------------------------------------------------------

export async function versionBumpReset(
  stage: StageConfig,
  lastSeenVersion: number,
  images: Collection<ImageDoc>,
): Promise<void> {
  if (stage.targetVersion <= lastSeenVersion) return;
  const stageKey = `stages.${stage.name}`;
  await images.updateMany(
    { [`${stageKey}.version`]: { $lt: stage.targetVersion } },
    {
      $set: {
        [`${stageKey}.dead`]: false,
        [`${stageKey}.attempts`]: 0,
        [`${stageKey}.last_error`]: null,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Dependency normalisation.
// ---------------------------------------------------------------------------

/** Normalise a stage's `dependsOn` (bare-string or {name,minVersion}) to the
 * concrete {name, minVersion} shape `buildClaimQuery` and the registry use.
 * A bare string means "depends on that stage at version >= 1". */
export function resolveStageDeps(
  dependsOn: StageDep[],
): Array<{ name: string; minVersion: number }> {
  return dependsOn.map((d) => (typeof d === 'string' ? { name: d, minVersion: 1 } : d));
}
