/**
 * /api/pano — panorama stitching HTTP surface (#1231).
 *
 *   POST   /api/pano/stitch        — create a pano_stitch job, returns { id }
 *   GET    /api/pano/jobs/:id      — job status + progress
 *   DELETE /api/pano/jobs/:id      — cancel an in-flight job
 *   GET    /api/pano/config        — effective pano config + strategySupported
 *   PUT    /api/pano/config        — save pano config
 *
 * All routes mount behind `requireAuth` in `src/index.ts`.
 *
 * Provisioning: when pano is not provisioned (enabled=false or no binary
 * path), POST returns 409 { error: 'pano_not_provisioned', message: '...' }.
 *
 * Concurrency: one pano_stitch job may run at a time (they are heavy:
 * ~6 min, tens of GB RSS). POST returns 409 { error: 'pano_job_running' }
 * when a running job exists.
 *
 * --strategy conditional: the config response includes `strategySupported`.
 * The UI hides the strategy control when false. The flag is probed by running
 * `maple-cli pano stitch --help` and checking for `--strategy` in the output;
 * result is cached for the process lifetime.
 */

import { Elysia, t } from 'elysia';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { child as childLogger } from '../log.ts';
import {
  isPanoProvisioned,
  loadPanoConfig,
  resolvePanoConfig,
  savePanoConfig,
} from '../pano/pano-config.repo.ts';
import { createJob, getJob, listJobs, requestCancel } from '../job-runner/jobs.repo.ts';
import type { JobWithId } from '../db/schema.ts';
import { assetsCollection } from '../db/client.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { isUnderRoot } from '../fs/browse.ts';

const log = childLogger('pano:routes');

// ── strategy probe cache (process-scoped) ─────────────────────────────────────
let _strategyProbeResult: boolean | null = null;
let _strategyProbedPath: string | null = null;

async function probeStrategySupported(cliPath: string): Promise<boolean> {
  if (_strategyProbedPath === cliPath && _strategyProbeResult !== null) {
    return _strategyProbeResult;
  }
  try {
    const proc = Bun.spawn([cliPath, 'pano', 'stitch', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Collect both stdout AND stderr: clap may print help to either depending
    // on the version. Match the exact flag token `--strategy` to avoid a
    // false positive from help text that merely contains the word "strategy".
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const supported = out.includes('--strategy') || err.includes('--strategy');
    _strategyProbeResult = supported;
    _strategyProbedPath = cliPath;
    return supported;
  } catch {
    _strategyProbeResult = false;
    _strategyProbedPath = cliPath;
    return false;
  }
}

// ── body / query schemas ──────────────────────────────────────────────────────

// The client may send either `assetIds` (Mongo ObjectId hex strings, stale
// fast-path) or `assetPaths` (absolute server-side filesystem paths, always
// fresh), or both. The route resolves paths → ids on the server at request
// time so the client's in-memory id map can never cause a false-negative.
// Elysia v1 does not support `t.Union` at the object level for mutual
// exclusivity; we accept both as optional and validate the invariant in the
// handler.
const StitchBody = t.Object({
  assetIds: t.Optional(t.Array(t.String())),
  assetPaths: t.Optional(t.Array(t.String())),
  libraryId: t.String(),
  options: t.Object({
    retention: t.Union([t.Literal('keep'), t.Literal('strict')]),
    localAlign: t.Union([t.Literal('mesh'), t.Literal('off')]),
    strategy: t.Optional(t.Union([t.Literal('auto'), t.Literal('rotation'), t.Literal('tile')])),
  }),
});

const ConfigBody = t.Object({
  maple_cli_path: t.Optional(t.Union([t.String(), t.Null()])),
  models_dir: t.Optional(t.Union([t.String(), t.Null()])),
  ort_dylib_path: t.Optional(t.Union([t.String(), t.Null()])),
  enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
});

// ── view helpers ─────────────────────────────────────────────────────────────

interface JobView {
  id: string;
  kind: string;
  status: string;
  progress: { current: number; total: number };
  result: Record<string, unknown> | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

function projectJob(doc: JobWithId): JobView {
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    status: doc.status,
    progress: doc.progress,
    result: doc.result,
    error: doc.error,
    cancel_requested: doc.cancel_requested,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

// ── path → asset-id resolution (server-authoritative) ────────────────────────

/**
 * Resolve a list of absolute filesystem paths to MongoDB asset ObjectId hexes.
 *
 * Security: every path is validated against the registered library roots
 * (longest-prefix match from `loadLibraryRoots`). Paths outside every root
 * are rejected with a 400 error. This is the sole security boundary —
 * arbitrary server paths can never be indexed or stitched.
 *
 * For each path:
 *   (a) Look up the asset doc by filename match + `assetAbsPath` verification
 *       (same query the browse route uses).
 *   (b) If not found: index the file on-demand by firing `handleEvent` (the
 *       discover producer's per-file insert path). This is a light index —
 *       skeleton doc + fileinfo only. The stitch reads the RAW file by path
 *       directly, so heavy enrichment (exif, thumb, face, describe) can stay
 *       deferred to the normal worker pipeline.
 *
 * Returns `{ resolvedIds, indexedCount }` where:
 *   `resolvedIds` — MongoDB ObjectId hex, one per input path, same order.
 *   `indexedCount` — number of assets that were indexed on-demand.
 *
 * Throws a structured error when a path escapes the library roots.
 */
async function resolveAssetPaths(
  paths: string[],
): Promise<{ resolvedIds: string[]; indexedCount: number }> {
  const libs = await loadLibraryRoots();

  // Build a root → folderId map for the index-on-demand path.
  const rootToFolderId = new Map<string, ObjectId>();
  for (const [id, root] of libs) {
    rootToFolderId.set(root, new ObjectId(id));
  }

  const resolvedIds: string[] = [];
  let indexedCount = 0;

  const coll = await assetsCollection();

  for (const absPath of paths) {
    // ── Security boundary ──────────────────────────────────────────────────
    const owningRoot = Array.from(libs.values()).find((root) => isUnderRoot(absPath, root));
    if (!owningRoot) {
      throw Object.assign(
        new Error(
          `Path is outside every registered library root and cannot be stitched: ${absPath}`,
        ),
        { status: 400, code: 'path_outside_library' },
      );
    }
    const owningFolderId = rootToFolderId.get(owningRoot)!;

    // ── Resolve by filename (same approach as browse.ts) ──────────────────
    // We check ALL fileinfo entries on each matching doc (not just the
    // primary) so that a deduplicated asset — where two paths with identical
    // content share one Mongo document — resolves correctly for both paths.
    const filename = path.basename(absPath);

    const findDocByPath = async (): Promise<string | null> => {
      const cur = coll.find(
        { 'fileinfo.filename': filename },
        { projection: { _id: 1, fileinfo: 1 } },
      );
      for await (const doc of cur) {
        const entries = (doc.fileinfo ?? []) as Array<{
          path: string;
          filename: string;
          library_id: { toHexString(): string };
          deleted_at?: string | null;
          missing_since?: string | null;
        }>;
        for (const entry of entries) {
          if (entry.deleted_at || entry.missing_since) continue;
          const libRoot = libs.get(entry.library_id.toHexString());
          if (!libRoot) continue;
          const segments = entry.path === '' ? [] : entry.path.split('/');
          const resolved = path.join(libRoot, ...segments, entry.filename);
          if (resolved === absPath) return doc._id.toHexString();
        }
      }
      return null;
    };

    const found = await findDocByPath();

    if (found) {
      resolvedIds.push(found);
      continue;
    }

    // ── Index on-demand ────────────────────────────────────────────────────
    // The file is not yet in the assets collection. Run `handleEvent` —
    // the same per-file code path the discover producer uses — to create
    // the skeleton asset doc. This is lightweight: it hashes the file head
    // and upserts a fileinfo entry; heavy enrichment (thumb, exif, etc.)
    // runs asynchronously on the normal worker schedule.
    log.info({ absPath }, 'pano/stitch: indexing file on-demand');
    const { handleEvent } = await import('../workers/discover/index.ts');
    await handleEvent({ kind: 'created', absPath }, owningFolderId, owningRoot);
    indexedCount++;

    // Re-query after index to get the newly created _id. Use the same
    // all-entries scan so a deduped doc (two files with identical content
    // sharing one row) resolves correctly for the newly appended location.
    const afterId = await findDocByPath();

    if (!afterId) {
      throw Object.assign(new Error(`Failed to index file on-demand: ${absPath}`), {
        status: 500,
        code: 'index_on_demand_failed',
      });
    }
    resolvedIds.push(afterId);
  }

  return { resolvedIds, indexedCount };
}

// ── route group ───────────────────────────────────────────────────────────────

export const panoRoutes = new Elysia({ prefix: '/api/pano' })

  // POST /api/pano/stitch — create a pano_stitch job.
  .post(
    '/stitch',
    async ({ body, set }) => {
      // 1. Check provisioning.
      const dbCfg = await loadPanoConfig();
      const cfg = resolvePanoConfig(dbCfg);
      if (!isPanoProvisioned(cfg)) {
        set.status = 409;
        return {
          error: 'pano_not_provisioned',
          message:
            'Panorama stitching is not configured. Go to Settings > Pano to set the ' +
            'maple-cli path, models directory, and enable the feature.',
        };
      }

      // 2. Reject if a pano_stitch job is already running OR queued.
      // Checking only 'running' lets close-together requests enqueue multiple
      // 'queued' jobs that workers later execute concurrently — pano is
      // ~tens of GB RSS, so concurrent runs OOM the box.
      const active = await listJobs({
        kind: 'pano_stitch',
        statuses: ['queued', 'running'],
        limit: 1,
      });
      if (active.length > 0) {
        set.status = 409;
        return {
          error: 'pano_job_running',
          message: 'A panorama job is already running or queued. Wait for it to finish.',
          jobId: active[0]._id.toHexString(),
        };
      }

      // 3. Resolve asset IDs — server-authoritative to avoid stale-client-map
      //    false-negatives.
      //
      //    The client may send:
      //      (a) `assetPaths` — absolute server-side paths (always fresh).
      //      (b) `assetIds`   — MongoDB ObjectId hexes (fast-path, may be stale).
      //      (c) Both         — paths take precedence (used when client has both).
      //
      //    When `assetPaths` is supplied, we resolve each path to an asset _id,
      //    indexing the file on-demand when it isn't in the collection yet.
      //    The security boundary is enforced here: paths must lie under a
      //    registered library root (verified by `resolveAssetPaths`).
      let resolvedIds: string[];
      let indexedCount = 0;

      if (body.assetPaths && body.assetPaths.length > 0) {
        // Path-based resolution (server-authoritative).
        let resolved: Awaited<ReturnType<typeof resolveAssetPaths>>;
        try {
          resolved = await resolveAssetPaths(body.assetPaths);
        } catch (err) {
          const e = err as { status?: number; code?: string; message?: string };
          if (e.status === 400) {
            set.status = 400;
            return { error: e.code ?? 'invalid_path', message: e.message ?? 'Invalid path.' };
          }
          if (e.status === 500) {
            set.status = 500;
            return { error: e.code ?? 'index_failed', message: e.message ?? 'Index failed.' };
          }
          throw err;
        }
        resolvedIds = resolved.resolvedIds;
        indexedCount = resolved.indexedCount;

        // Guard: need ≥ 2 inputs for a stitch.
        if (resolvedIds.length < 2) {
          set.status = 422;
          return {
            error: 'insufficient_assets',
            message: 'At least 2 valid image paths are required to create a panorama.',
          };
        }
      } else if (body.assetIds && body.assetIds.length >= 2) {
        // Legacy ObjectId-only path (client has known API ids).
        // Validate each is a well-formed ObjectId.
        for (const id of body.assetIds) {
          if (!ObjectId.isValid(id)) {
            set.status = 422;
            return { error: 'invalid_asset_id', message: `Invalid asset id: ${id}` };
          }
        }
        resolvedIds = body.assetIds;
      } else {
        set.status = 422;
        return {
          error: 'insufficient_assets',
          message:
            'Provide at least 2 asset paths (assetPaths) or asset ids (assetIds) to create a panorama.',
        };
      }

      // 4. Probe strategy support.
      const strategySupported = await probeStrategySupported(cfg.maple_cli_path!);

      // 5. Build temp output dir for this job (will be cleaned up by the handler
      //    after importing the result).
      const outputDir = path.join(os.tmpdir(), `maple-pano-${Date.now()}`);

      // 6. Create the job.
      const doc = await createJob({
        kind: 'pano_stitch',
        payload: {
          assetIds: resolvedIds,
          libraryId: body.libraryId,
          outputDir,
          retention: body.options.retention,
          localAlign: body.options.localAlign,
          strategy: body.options.strategy ?? null,
          strategySupported,
          mapleCli: cfg.maple_cli_path!,
          modelsDir: cfg.models_dir,
          ortDylibPath: cfg.ort_dylib_path,
        },
      });
      set.status = 201;
      return { id: doc._id.toHexString(), ...(indexedCount > 0 ? { indexing: indexedCount } : {}) };
    },
    { body: StitchBody },
  )

  // GET /api/pano/jobs/:id — job status.
  .get('/jobs/:id', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const doc = await getJob(new ObjectId(params.id));
    if (!doc || doc.kind !== 'pano_stitch') {
      set.status = 404;
      return { error: 'Pano job not found' };
    }
    return projectJob(doc);
  })

  // DELETE /api/pano/jobs/:id — cancel.
  .delete('/jobs/:id', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid job id' };
    }
    const doc = await getJob(new ObjectId(params.id));
    if (!doc || doc.kind !== 'pano_stitch') {
      set.status = 404;
      return { error: 'Pano job not found' };
    }
    const ok = await requestCancel(new ObjectId(params.id));
    return { ok };
  })

  // GET /api/pano/config — effective config + strategySupported.
  .get('/config', async () => {
    const dbCfg = await loadPanoConfig();
    const cfg = resolvePanoConfig(dbCfg);
    let strategySupported = false;
    if (cfg.maple_cli_path) {
      strategySupported = await probeStrategySupported(cfg.maple_cli_path);
    }
    return { ...cfg, strategy_supported: strategySupported };
  })

  // PUT /api/pano/config — upsert pano settings.
  .put(
    '/config',
    async ({ body }) => {
      await savePanoConfig(body);
      const dbCfg = await loadPanoConfig();
      const cfg = resolvePanoConfig(dbCfg);
      // Invalidate strategy probe cache so the new path is probed fresh.
      _strategyProbeResult = null;
      _strategyProbedPath = null;
      let strategySupported = false;
      if (cfg.maple_cli_path) {
        strategySupported = await probeStrategySupported(cfg.maple_cli_path);
      }
      log.info({ enabled: cfg.enabled }, 'pano config updated');
      return { ok: true, ...cfg, strategy_supported: strategySupported };
    },
    { body: ConfigBody },
  );
