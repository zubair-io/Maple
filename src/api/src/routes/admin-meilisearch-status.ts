import { Elysia } from 'elysia';
import { requireAuth, requireOwner } from '../auth/middleware.ts';
import { readBackfillState, type BackfillStateRow } from '../db/repos/meilisearch-backfill.repo.ts';
import { WorkerConfigRepo } from '../db/repos/worker-config.repo.ts';
import { EMBEDDER_NAME, meilisearchClient } from '../enrichment/meilisearch-client.ts';
import {
  DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
} from '../enrichment/meilisearch-config.ts';
import type { MeilisearchSemanticStatus } from '../enrichment/meilisearch-client.ts';
import {
  countLiveAssets,
  countLiveAssetsWithFingerprint,
} from '../enrichment/meilisearch-vector-coverage.ts';

const unavailableStatus = (): MeilisearchSemanticStatus => ({
  configured: false,
  enabled: false,
  embedderName: EMBEDDER_NAME,
  model: DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  semanticRatio: DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
  meilisearchReachable: false,
  embedderConfigured: false,
  embedderReachable: false,
  indexedDocumentCount: null,
  vectorizedDocumentCount: null,
  isIndexing: null,
  error: 'status_not_supported',
  embedderPolicyRejected: false,
});

/** The `meili` stage's DB-backed pause state. When the stage paused ITSELF
 * (embedder address policy, #3315) the reason rides along here so the
 * semantic-status surface tells the same story as Settings → Workers. */
async function meiliStagePause(): Promise<{ paused: boolean; pauseReason: string | null }> {
  const config = await new WorkerConfigRepo().load('meili');
  return { paused: config?.paused === true, pauseReason: config?.pause_reason ?? null };
}

function backfillStatus(backfill: BackfillStateRow): string {
  if (!backfill.completed_at) return 'in_progress';
  return backfill.errors > 0 ? 'complete_with_errors' : 'complete';
}

function backfillPayload(backfill: BackfillStateRow | null): Record<string, unknown> {
  if (!backfill) {
    return {
      status: 'not_started',
      scanned: 0,
      upserted: 0,
      tombstoned: 0,
      skipped: 0,
      errors: 0,
      startedAt: null,
      updatedAt: null,
      completedAt: null,
    };
  }
  return {
    status: backfillStatus(backfill),
    scanned: backfill.scanned,
    upserted: backfill.upserted,
    tombstoned: backfill.tombstoned ?? 0,
    skipped: backfill.skipped,
    errors: backfill.errors,
    startedAt: backfill.started_at,
    updatedAt: backfill.updated_at,
    completedAt: backfill.completed_at,
  };
}

// ── Status response cache (#2359) ─────────────────────────────────────
// Every call runs `semanticStatus()` (a live hybrid-search embed probe
// against Ollama — see `meilisearch-semantic-status.ts`) alongside two
// asset counts. This route backs the Settings → Workers polling widget, so
// without a cache each poll tick re-hammers Ollama. There's exactly one
// response shape (no request params to key on), so a single cached slot +
// absolute expiry is enough — mirrors the TTL-cache shape used by
// `totalCache` in `routes/search/total-cache.ts` and `bucketsCache` in
// `routes/search/buckets.ts`, just without the per-filter `Map`. No bypass:
// operators can wait out the TTL.
//
// The two counts are no longer the reason the cache exists. They were
// unindexed O(N) collection scans, because "live" lived in an `$elemMatch`
// over `fileinfo[]`; they are partial-index counts now. The embed probe
// still costs what it costs, so the cache stays for that.
const STATUS_CACHE_TTL_MS = 30_000;
let statusCache: { result: Record<string, unknown>; expiresMs: number } | null = null;

/** Test-only: blow the cache so back-to-back tests (each installing a
 * different fake Meilisearch client) don't see a stale cached response. */
export function _resetAdminMeilisearchStatusCacheForTests(): void {
  statusCache = null;
}

async function computeAdminMeilisearchStatus(): Promise<Record<string, unknown>> {
  const client = meilisearchClient();
  const fingerprint = client.semanticFingerprint?.() ?? null;
  const [semantic, liveDocumentCount, vectorizedLive, backfill, stage] = await Promise.all([
    client.semanticStatus?.() ?? Promise.resolve(unavailableStatus()),
    countLiveAssets(),
    countLiveAssetsWithFingerprint(fingerprint),
    readBackfillState(),
    meiliStagePause(),
  ]);
  return {
    semantic,
    stage,
    documents: {
      live: liveDocumentCount,
      indexedRaw: semantic.indexedDocumentCount,
      vectorizedRaw: semantic.vectorizedDocumentCount,
      vectorizedLive,
      vectorCoverage: liveDocumentCount === 0 ? 1 : vectorizedLive / liveDocumentCount,
    },
    backfill: backfillPayload(backfill),
  };
}

async function loadAdminMeilisearchStatus(): Promise<Record<string, unknown>> {
  const nowMs = Date.now();
  if (statusCache && statusCache.expiresMs > nowMs) return statusCache.result;
  const result = await computeAdminMeilisearchStatus();
  statusCache = { result, expiresMs: nowMs + STATUS_CACHE_TTL_MS };
  return result;
}

// Owner-only (#2353): mirrors meilisearchBackfillRoutes in the same
// `/api/admin/enrichment` prefix — this surfaces the raw indexed/vectorized
// document counts and backfill progress, admin-tier operational detail that
// shouldn't be exposed to every member.
export const adminMeilisearchStatusRoutes = new Elysia({
  prefix: '/api/admin/enrichment',
})
  .use(requireAuth)
  .use(requireOwner)
  .get('/meilisearch-status', loadAdminMeilisearchStatus);
