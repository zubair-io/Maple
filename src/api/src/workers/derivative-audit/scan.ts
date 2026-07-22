/**
 * Derivative-audit worker — the interval-loop detector that verifies each live
 * asset's thumb/preview/description on disk and its thumbnail in R2, and
 * re-arms the owning stage when a derivative has drifted (see the design doc,
 * `docs/superpowers/specs/2026-07-22-derivative-reconcile-worker-design.md`).
 * Modeled on `mirror/scan.ts`. It NEVER renders/uploads — it only issues the
 * canonical 5-field stage reset so the existing stages regenerate.
 */
import { assetsCollection } from '../../db/client.ts';
import { liveFileInfoElemMatch } from '../../indexer/images.repo.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../../indexer/libraries.cache.ts';
import { statOrNull } from '../mirror/replicate.ts';
import { ffmpegBinary } from '../../thumbs/video-poster.ts';
import {
  loadCloudflareConfig,
  resolveCloudflareConfig,
  isCloudflareConfigComplete,
} from '../../cloudflare/cloudflare-config.repo.ts';
import { thumbExistsInR2 } from '../../cloudflare/r2-client.ts';
import { child as childLogger } from '../../log.ts';
import { evaluateAsset, type AuditDeps, type AuditResult } from './checks.ts';
import { buildStageReset, auditMarkKey, AUDIT_MAX_ATTEMPTS } from './reset.ts';
import {
  DEFAULT_DERIVATIVE_AUDIT_CONFIG,
  loadDerivativeAuditConfig,
  type DerivativeAuditConfig,
} from './config.repo.ts';
import { emptySummary, setDerivativeAuditProgress } from './progress.ts';
import type { DerivativeAuditSummary } from './types.ts';
import type { ImageDoc } from '../run-stage.ts';

const log = childLogger('derivative-audit');

/** Single-flight lock shared by the interval loop AND the manual /run route, so
 * a manual kick can never overlap a scheduled pass (double R2 load, racing
 * resets, and a clobbered progress summary). */
let passInFlight = false;

interface AssetUpdatePlan {
  set: Record<string, unknown>;
  unset: Record<string, unknown>;
  /** Stages actually re-armed this asset (excludes cooldown-skipped). */
  rearmed: string[];
  /** Drifted stages left alone because they hit the per-asset cooldown. */
  cooldownSkipped: number;
}

/** Build the `$set`/`$unset` for one asset from its drift verdict. Re-arms up to
 * `rearmBudget` drifted stages (respecting the per-asset cooldown), and clears
 * cooldown marks ONLY for stages whose derivative was positively verified
 * present — never for a below-target stage still awaiting regeneration. */
function planAssetUpdate(
  doc: ImageDoc,
  verdict: AuditResult,
  nowIso: string,
  rearmBudget: number,
): AssetUpdatePlan {
  const set: Record<string, unknown> = {};
  const unset: Record<string, unknown> = {};
  const rearmed: string[] = [];
  let cooldownSkipped = 0;

  for (const s of verdict.drifted) {
    if (rearmed.length >= rearmBudget) break;
    const prev = doc.derivative_audit?.[s]?.attempts ?? 0;
    if (prev >= AUDIT_MAX_ATTEMPTS) {
      cooldownSkipped++;
      continue;
    }
    Object.assign(set, buildStageReset(s));
    set[auditMarkKey(s)] = { attempts: prev + 1, last_reset_at: nowIso };
    rearmed.push(s);
  }
  for (const s of verdict.resolved) {
    if (doc.derivative_audit?.[s]) unset[auditMarkKey(s)] = '';
  }
  return { set, unset, rearmed, cooldownSkipped };
}

/** Shared state threaded through a single pass's per-asset work. */
interface PassContext {
  libs: ReadonlyMap<string, string>;
  idToSlug: ReadonlyMap<string, string>;
  deps: AuditDeps;
  coll: Awaited<ReturnType<typeof assetsCollection>>;
  cfg: DerivativeAuditConfig;
  summary: DerivativeAuditSummary;
}

/** Assemble the pass's injected dependencies. The deep R2 check runs only when
 * explicitly enabled AND fully configured — otherwise a missing bucket-object
 * reading would wrongly re-arm cf-thumb-sync. */
async function buildAuditDeps(cfg: DerivativeAuditConfig): Promise<AuditDeps> {
  const cf = resolveCloudflareConfig(await loadCloudflareConfig());
  const r2Ready = cfg.deep_r2_enabled && isCloudflareConfigComplete(cf);
  return {
    statOrNull,
    ffmpegAvailable: () => ffmpegBinary().then((b) => b !== null),
    thumbExistsInR2: r2Ready ? (key) => thumbExistsInR2(cf, key, AbortSignal.timeout(5_000)) : null,
  };
}

/** Evaluate one asset and apply its re-arm/clear plan, tallying into the pass
 * summary. Swallows per-row errors so one bad asset can't abort the pass. */
async function auditAsset(doc: ImageDoc, ctx: PassContext): Promise<void> {
  const { cfg, summary } = ctx;
  if (summary.reArmed >= cfg.max_resets_per_pass) return;
  try {
    summary.scanned++;
    const verdict = await evaluateAsset(doc, ctx.libs, ctx.idToSlug, ctx.deps);
    const budget = cfg.max_resets_per_pass - summary.reArmed;
    const plan = planAssetUpdate(doc, verdict, new Date().toISOString(), budget);
    for (const s of plan.rearmed) {
      summary.reArmed++;
      summary.byStage[s] = (summary.byStage[s] ?? 0) + 1;
    }
    summary.skippedCooldown += plan.cooldownSkipped;
    const update: Record<string, unknown> = {};
    if (Object.keys(plan.set).length) update.$set = plan.set;
    if (Object.keys(plan.unset).length) update.$unset = plan.unset;
    if (Object.keys(update).length) await ctx.coll.updateOne({ _id: doc._id }, update);
  } catch (err) {
    summary.errors++;
    log.warn({ id: doc._id, err: err instanceof Error ? err.message : err }, 'audit row failed');
  }
}

/** One audit pass. Exported for tests + driven by the interval loop. NOT guarded
 * itself — the single-flight lock lives in `startAuditPass()`. */
export async function runDerivativeAuditOnce(
  override: Partial<DerivativeAuditConfig> = {},
): Promise<DerivativeAuditSummary> {
  const cfg = { ...(await loadDerivativeAuditConfig()), ...override };
  const summary = emptySummary();
  summary.startedAt = new Date().toISOString();
  summary.running = true;
  setDerivativeAuditProgress({ ...summary });

  const coll = await assetsCollection();
  const ctx: PassContext = {
    libs: await loadLibraryRoots(),
    idToSlug: await loadLibraryIdToSlug(),
    deps: await buildAuditDeps(cfg),
    coll,
    cfg,
    summary,
  };

  const cursor = coll.find(
    { ...liveFileInfoElemMatch(), 'damaged.since': { $not: { $type: 'string' } } },
    {
      projection: {
        fileinfo: 1,
        maple_id: 1,
        stages: 1,
        description: 1,
        hidden: 1,
        derivative_audit: 1,
      },
    },
  );

  // Evaluate in bounded-concurrency chunks so per-asset R2 HEADs run in parallel
  // without an unbounded fan-out.
  const chunkSize = Math.max(1, cfg.concurrency);
  let chunk: ImageDoc[] = [];
  const flush = async () => {
    await Promise.all(chunk.map((d) => auditAsset(d, ctx)));
    chunk = [];
  };
  for await (const doc of cursor) {
    chunk.push(doc as unknown as ImageDoc);
    if (chunk.length >= chunkSize) await flush();
    if (summary.reArmed >= cfg.max_resets_per_pass) break;
  }
  await flush();

  summary.finishedAt = new Date().toISOString();
  summary.running = false;
  setDerivativeAuditProgress({ ...summary });
  if (summary.scanned > 0) log.info(summary, 'derivative-audit pass complete');
  return summary;
}

/** Start one pass in the background under the shared single-flight lock. Returns
 * synchronously whether it started. Both the interval loop and the manual /run
 * route go through this, so at most one pass ever runs at a time. */
export function startAuditPass(): { started: boolean; reason?: string } {
  if (passInFlight) return { started: false, reason: 'already-running' };
  passInFlight = true;
  void runDerivativeAuditOnce()
    .catch((err) =>
      log.error({ err: err instanceof Error ? err.message : err }, 'derivative-audit pass crashed'),
    )
    .finally(() => {
      passInFlight = false;
    });
  return { started: true };
}

export interface DerivativeAuditHandle {
  stop(): void;
}

/** Start the interval loop. Fires once on boot, then self-reschedules using the
 * live `interval_ms` from config each cycle (so the operator's cadence + enable
 * toggle both take effect without a restart). */
export function startDerivativeAudit(): DerivativeAuditHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => void runTick(), ms);
    timer.unref?.();
  };
  const runTick = async () => {
    if (stopped) return;
    let intervalMs = DEFAULT_DERIVATIVE_AUDIT_CONFIG.interval_ms;
    try {
      const cfg = await loadDerivativeAuditConfig();
      intervalMs = cfg.interval_ms;
      if (cfg.enabled) startAuditPass();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'derivative-audit tick failed');
    }
    schedule(intervalMs);
  };
  void runTick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
