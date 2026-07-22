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
import { evaluateAsset, type AuditDeps } from './checks.ts';
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

const ALL_AUDIT_STAGES = ['thumb', 'preview', 'describe', 'cf-thumb-sync'] as const;

/** One audit pass. Exported for tests + driven by the interval loop. */
export async function runDerivativeAuditOnce(
  override: Partial<DerivativeAuditConfig> = {},
): Promise<DerivativeAuditSummary> {
  const cfg = { ...(await loadDerivativeAuditConfig()), ...override };
  const summary = emptySummary();
  summary.startedAt = new Date().toISOString();
  summary.running = true;
  setDerivativeAuditProgress({ ...summary });

  const libs = await loadLibraryRoots();
  const idToSlug = await loadLibraryIdToSlug();
  const coll = await assetsCollection();

  // Deep R2 check runs only when explicitly enabled AND fully configured —
  // otherwise a missing bucket-object reading would wrongly re-arm cf-thumb-sync.
  const cf = resolveCloudflareConfig(await loadCloudflareConfig());
  const r2Ready = cfg.deep_r2_enabled && isCloudflareConfigComplete(cf);
  const deps: AuditDeps = {
    statOrNull,
    ffmpegAvailable: () => ffmpegBinary().then((b) => b !== null),
    thumbExistsInR2: r2Ready ? (key) => thumbExistsInR2(cf, key, AbortSignal.timeout(5_000)) : null,
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

  const handleOne = async (doc: ImageDoc): Promise<void> => {
    if (summary.reArmed >= cfg.max_resets_per_pass) return;
    try {
      summary.scanned++;
      const drifted = await evaluateAsset(doc, libs, idToSlug, deps);
      const nowIso = new Date().toISOString();
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      for (const s of drifted) {
        if (summary.reArmed >= cfg.max_resets_per_pass) break;
        const prev = doc.derivative_audit?.[s]?.attempts ?? 0;
        if (prev >= AUDIT_MAX_ATTEMPTS) {
          summary.skippedCooldown++;
          continue;
        }
        Object.assign(set, buildStageReset(s));
        set[auditMarkKey(s)] = { attempts: prev + 1, last_reset_at: nowIso };
        summary.reArmed++;
        summary.byStage[s] = (summary.byStage[s] ?? 0) + 1;
      }
      // Clear resolved marks for stages that did NOT drift this pass.
      for (const s of ALL_AUDIT_STAGES) {
        if (!drifted.includes(s) && doc.derivative_audit?.[s]) unset[auditMarkKey(s)] = '';
      }
      const update: Record<string, unknown> = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      if (Object.keys(update).length) await coll.updateOne({ _id: doc._id }, update);
    } catch (err) {
      summary.errors++;
      log.warn({ id: doc._id, err: err instanceof Error ? err.message : err }, 'audit row failed');
    }
  };

  // Evaluate in bounded-concurrency chunks so the per-asset R2 HEADs run in
  // parallel without an unbounded fan-out.
  const chunkSize = Math.max(1, cfg.concurrency);
  let chunk: ImageDoc[] = [];
  const flush = async () => {
    await Promise.all(chunk.map((d) => handleOne(d)));
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

export interface DerivativeAuditHandle {
  stop(): void;
}

/** Start the interval loop — fires once on boot, then every `interval_ms`.
 * Each tick re-reads config and self-gates on `enabled`. */
export function startDerivativeAudit(): DerivativeAuditHandle {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    const cfg = await loadDerivativeAuditConfig();
    if (!cfg.enabled) return;
    inFlight = true;
    try {
      await runDerivativeAuditOnce();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'derivative-audit pass crashed');
    } finally {
      inFlight = false;
    }
  };
  // Fixed cadence from the default (an interval_ms config change takes effect on
  // next restart — matching mirror-scan's fixed timer). `enabled` + all other
  // knobs are honoured live via the per-tick config read above.
  const timer = setInterval(() => void tick(), DEFAULT_DERIVATIVE_AUDIT_CONFIG.interval_ms);
  timer.unref?.();
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
