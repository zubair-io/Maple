/**
 * Derivative-audit worker — the interval-loop detector that verifies each live
 * asset's thumb/preview/description on disk and its thumbnail in R2, and
 * re-arms the owning stage when a derivative has drifted (see the design doc,
 * `docs/superpowers/specs/2026-07-22-derivative-reconcile-worker-design.md`).
 * Modeled on `mirror/scan.ts`. It NEVER renders/uploads — it only issues the
 * canonical 5-field stage reset so the existing stages regenerate.
 *
 * That reset used to be five `$set` paths this module spelled out itself; it is
 * now `stageRearmStatements`, the one definition every re-arming caller in the
 * repository shares. The cooldown marks that rate-limit it go through
 * `writeAuditMarks`, which commits both in a single transaction — see
 * `auditAsset` for why they must not be separable.
 */
import {
  listAuditCandidatesAfter,
  writeAuditMarks,
  type AuditCandidate,
  type AuditMark,
} from '../../db/sqlite/repos/assets.sweeps.ts';
import { stageRearmStatements } from '../../db/sqlite/repos/assets.stage-rearm.ts';
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
import {
  DEFAULT_DERIVATIVE_AUDIT_CONFIG,
  loadDerivativeAuditConfig,
  type DerivativeAuditConfig,
} from './config.repo.ts';
import { emptySummary, setDerivativeAuditProgress } from './progress.ts';
import type { DerivativeAuditSummary } from './types.ts';
import type { ImageDoc } from '../run-stage.ts';

const log = childLogger('derivative-audit');

/** After this many audit re-arms that did NOT resolve the drift, stop
 * re-arming an asset+stage — the stage keeps marking itself done without
 * producing output (an imperfect skip-predicate would otherwise loop). */
const AUDIT_MAX_ATTEMPTS = 3;

/** Assets fetched per round trip. The per-asset work is filesystem stats and
 * possibly an R2 HEAD, so a page is cheap next to what is done with it. */
const CANDIDATE_PAGE_SIZE = 500;

/** Single-flight lock shared by the interval loop AND the manual /run route, so
 * a manual kick can never overlap a scheduled pass (double R2 load, racing
 * resets, and a clobbered progress summary). */
let passInFlight = false;

interface AssetUpdatePlan {
  /** Per-stage cooldown marks to write, one JSON key each. */
  marks: Map<string, AuditMark>;
  /** Stages whose mark is removed because their derivative is verifiably back. */
  cleared: string[];
  /** Stages actually re-armed this asset (excludes cooldown-skipped). */
  rearmed: string[];
  /** Drifted stages left alone because they hit the per-asset cooldown. */
  cooldownSkipped: number;
}

/** Build one asset's write plan from its drift verdict. Re-arms up to
 * `rearmBudget` drifted stages (respecting the per-asset cooldown), and clears
 * cooldown marks ONLY for stages whose derivative was positively verified
 * present — never for a below-target stage still awaiting regeneration. */
function planAssetUpdate(
  doc: AuditCandidate,
  verdict: AuditResult,
  nowIso: string,
  rearmBudget: number,
): AssetUpdatePlan {
  const marks = new Map<string, AuditMark>();
  const rearmed: string[] = [];
  let cooldownSkipped = 0;

  for (const s of verdict.drifted) {
    if (rearmed.length >= rearmBudget) break;
    const prev = doc.derivative_audit?.[s]?.attempts ?? 0;
    if (prev >= AUDIT_MAX_ATTEMPTS) {
      cooldownSkipped++;
      continue;
    }
    marks.set(s, { attempts: prev + 1, last_reset_at: nowIso });
    rearmed.push(s);
  }
  const cleared = verdict.resolved.filter((s) => doc.derivative_audit?.[s] !== undefined);
  return { marks, cleared, rearmed, cooldownSkipped };
}

/** Shared state threaded through a single pass's per-asset work. */
interface PassContext {
  libs: ReadonlyMap<string, string>;
  idToSlug: ReadonlyMap<string, string>;
  deps: AuditDeps;
  cfg: DerivativeAuditConfig;
  summary: DerivativeAuditSummary;
}

/**
 * Every live, undamaged asset, one keyset page at a time.
 *
 * Keyset on the asset's own primary key rather than `LIMIT`/`OFFSET`, for the
 * reason the mirror scan uses one: a full sweep with an offset page re-reads
 * every row before it, so the last page costs the whole table. The empty string
 * sorts before every hex id, which is what makes it the start of the walk.
 */
async function* auditCandidates(): AsyncGenerator<AuditCandidate> {
  let afterId = '';
  for (;;) {
    const page = await listAuditCandidatesAfter(afterId, CANDIDATE_PAGE_SIZE);
    for (const row of page) yield row;
    if (page.length < CANDIDATE_PAGE_SIZE) return;
    afterId = page[page.length - 1].rowId;
  }
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
async function auditAsset(doc: AuditCandidate, ctx: PassContext): Promise<void> {
  const { cfg, summary } = ctx;
  if (summary.reArmed >= cfg.max_resets_per_pass) return;
  try {
    summary.scanned++;
    // The checks read a document's `fileinfo`, `stages[].version`, caption and
    // hidden flag, which is exactly what the candidate row carries — but its
    // stage entries hold only the version the audit compares against, not the
    // full retry bookkeeping an `ImageDoc` declares, so the shapes meet through
    // a cast rather than structurally.
    const verdict = await evaluateAsset(
      doc as unknown as ImageDoc,
      ctx.libs,
      ctx.idToSlug,
      ctx.deps,
    );
    const budget = cfg.max_resets_per_pass - summary.reArmed;
    const plan = planAssetUpdate(doc, verdict, new Date().toISOString(), budget);
    for (const s of plan.rearmed) {
      summary.reArmed++;
      summary.byStage[s] = (summary.byStage[s] ?? 0) + 1;
    }
    summary.skippedCooldown += plan.cooldownSkipped;
    // One transaction: a stage is re-armed and the mark that rate-limits that
    // re-arm is recorded together, so a crash between them cannot produce a
    // stage queued for regeneration with no record of the attempt. A plan with
    // nothing in it writes nothing.
    await writeAuditMarks({
      assetId: doc.rowId,
      set: plan.marks,
      clear: plan.cleared,
      extra: stageRearmStatements(doc.rowId, plan.rearmed),
    });
  } catch (err) {
    summary.errors++;
    log.warn({ id: doc.rowId, err: err instanceof Error ? err.message : err }, 'audit row failed');
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

  const ctx: PassContext = {
    libs: await loadLibraryRoots(),
    idToSlug: await loadLibraryIdToSlug(),
    deps: await buildAuditDeps(cfg),
    cfg,
    summary,
  };

  // Evaluate in bounded-concurrency chunks so per-asset R2 HEADs run in parallel
  // without an unbounded fan-out.
  const chunkSize = Math.max(1, cfg.concurrency);
  let chunk: AuditCandidate[] = [];
  const flush = async () => {
    await Promise.all(chunk.map((d) => auditAsset(d, ctx)));
    chunk = [];
  };
  for await (const doc of auditCandidates()) {
    chunk.push(doc);
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
