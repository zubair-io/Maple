/**
 * /api/pano — panorama stitching HTTP surface (#1231).
 *
 *   POST   /api/pano/stitch        — create a pano_stitch job, returns { id }
 *   GET    /api/pano/jobs/:id      — job status + progress
 *   DELETE /api/pano/jobs/:id      — cancel an in-flight job
 *   GET    /api/pano/config        — effective pano config + strategySupported
 *   PUT    /api/pano/config        — save pano config
 *
 * All routes mount behind `requireAuth` (also embedded here so the module is
 * self-gating); `PUT /config` is additionally owner-only (#4743).
 *
 * Provisioning: when pano is not provisioned (enabled=false or no binary
 * path), POST returns 409 { error: 'pano_not_provisioned', message: '...' }.
 * How the matcher is chosen — including the classical fallback for an ML
 * matcher without its paths (#5487) and the 409 for a pre-#4523 binary that
 * can only run ML (`pano_cli_outdated`) — is `pano/pano-engine.ts`.
 *
 * Concurrency: one pano_stitch job may run at a time (they are heavy:
 * ~6 min, tens of GB RSS). POST returns 409 { error: 'pano_job_running' }
 * when a running job exists, unless the request repeats that job's — then it
 * answers with that job's id (`pano/pano-stitch-rejoin.ts`).
 *
 * Optional flags: `--strategy`, `--features-engine` and the preview flags are
 * probed from `maple-cli pano stitch --help` (`pano/pano-cli-probe.ts`) and
 * reported as `strategy_supported` / `features_engine_supported` /
 * `preview_supported` on the config response.
 *
 * Quick preview (#4580): `routes/pano-preview.ts`. A stitch body may name a
 * done preview job in `alignmentFrom`; its solved alignment is handed to the
 * CLI so matching is not repeated. Preview and stitch get the same plan from
 * `planStitch`, so both run the same matcher.
 */

import { Elysia, t } from 'elysia';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { child as childLogger } from '../log.ts';
import { requireAuth, requireOwnerBeforeHandle } from '../auth/middleware.ts';
import { jailExecutablePaths, loadEffectivePanoConfig } from '../pano/pano-config-paths.ts';
import {
  isPanoProvisioned,
  savePanoConfig,
  type PanoConfigResolution,
} from '../pano/pano-config.repo.ts';
import { invalidatePanoCliProbe, probePanoCli } from '../pano/pano-cli-probe.ts';
import { planPanoEngine, withExistingMlPaths } from '../pano/pano-engine.ts';
import { getJob, requestCancel } from '../job-runner/jobs.repo.ts';
import { ownedPreviewDir, PREVIEW_FILES } from '../pano/pano-previews.ts';
import type { JobWithId } from '../db/schema.ts';
import {
  findAssetLocationsByFilenames,
  type AssetLocationsRow,
} from '../db/repos/assets.by-filename.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { admitPanoStitch, panoJobRunning } from '../pano/pano-admission.ts';
import { isUnderRoot } from '../fs/browse.ts';

const log = childLogger('pano:routes');

// ── body / query schemas ──────────────────────────────────────────────────────

// Per selected asset the client sends its best single reference: `assetPaths`
// (absolute server-side filesystem paths, always fresh) when it has one, else
// `assetIds` (24-character asset ids) for assets it can only name by id.
// The two arrays are disjoint at the asset level — the client never sends both
// a path and an id for the same asset, so a stale cached id can never shadow a
// fresh path. The route resolves paths → ids and unions them with the supplied
// ids. Both are optional here; the ≥2-distinct-inputs invariant is validated in
// the handler.
export const StitchBody = t.Object({
  assetIds: t.Optional(t.Array(t.String())),
  assetPaths: t.Optional(t.Array(t.String())),
  libraryId: t.String(),
  options: t.Object({
    retention: t.Union([t.Literal('keep'), t.Literal('strict')]),
    localAlign: t.Union([t.Literal('mesh'), t.Literal('off')]),
    strategy: t.Optional(t.Union([t.Literal('auto'), t.Literal('rotation'), t.Literal('tile')])),
  }),
  alignmentFrom: t.Optional(t.String()),
});

export type StitchRequest = typeof StitchBody.static;

const ConfigBody = t.Object({
  maple_cli_path: t.Optional(t.Union([t.String(), t.Null()])),
  models_dir: t.Optional(t.Union([t.String(), t.Null()])),
  ort_dylib_path: t.Optional(t.Union([t.String(), t.Null()])),
  enabled: t.Optional(t.Union([t.Boolean(), t.Null()])),
  matcher: t.Optional(t.Union([t.Literal('classical'), t.Literal('ml'), t.Null()])),
});

async function withProbedFlags(cfg: PanoConfigResolution) {
  const capabilities = cfg.maple_cli_path
    ? await probePanoCli(cfg.maple_cli_path)
    : { strategy: false, featuresEngine: false, preview: false };
  return {
    ...cfg,
    strategy_supported: capabilities.strategy,
    features_engine_supported: capabilities.featuresEngine,
    preview_supported: capabilities.preview,
  };
}

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

const PANO_JOB_KINDS: ReadonlySet<string> = new Set(['pano_stitch', 'pano_preview']);

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

/** Every registered library root, as realpath sees it. */
interface CanonicalRoots {
  /** Canonical root → the folder that owns it. */
  canonRootToFolderId: Map<string, ObjectId>;
  /** The jail: the same roots, as a list to scan. */
  canonRoots: string[];
  /** Folder id → canonical root, for rebuilding an entry's absolute path. */
  libIdToCanonRoot: Map<string, string>;
}

/**
 * Canonicalises every registered root through `realpath`.
 *
 * Without this the jail check fails on macOS, where `/tmp` is really
 * `/private/tmp` and a stored root of `/var/folders/…` never equals the
 * realpath-resolved path of a file inside it. A root that does not exist on
 * disk is kept as stored — an offline volume is not a reason to drop a library
 * out of the jail.
 */
async function canonicaliseRoots(libs: ReadonlyMap<string, string>): Promise<CanonicalRoots> {
  const canonRootToFolderId = new Map<string, ObjectId>();
  const canonRoots: string[] = [];
  const libIdToCanonRoot = new Map<string, string>();
  for (const [id, root] of libs) {
    const canonRoot = await fs.realpath(root).catch(() => root);
    canonRootToFolderId.set(canonRoot, new ObjectId(id));
    canonRoots.push(canonRoot);
    libIdToCanonRoot.set(id, canonRoot);
  }
  return { canonRootToFolderId, canonRoots, libIdToCanonRoot };
}

/**
 * Groups candidate rows by the filenames they hold, so matching one path walks
 * only the rows that could match it rather than every row fetched.
 */
function byFilename(docs: readonly AssetLocationsRow[]): Map<string, AssetLocationsRow[]> {
  const index = new Map<string, AssetLocationsRow[]>();
  for (const doc of docs) {
    for (const entry of doc.fileinfo) {
      const rows = index.get(entry.filename);
      if (rows === undefined) index.set(entry.filename, [doc]);
      else rows.push(doc);
    }
  }
  return index;
}

/**
 * Resolve a list of absolute filesystem paths to asset ids.
 *
 * Security: every path is validated against the registered library roots
 * (longest-prefix match from `loadLibraryRoots`). Paths outside every root
 * are rejected with a 400 error. This is the sole security boundary —
 * arbitrary server paths can never be indexed or stitched.
 *
 * For each path:
 *   (a) Look up the asset doc by filename match + canonical path comparison
 *       (the realpath-normalized absolute path must equal the path rebuilt
 *       from the doc's library root + stored relative path).
 *   (b) If not found: index the file on-demand by firing `handleEvent` (the
 *       discover producer's per-file insert path). This is a light index —
 *       skeleton doc + fileinfo only. The stitch reads the RAW file by path
 *       directly, so heavy enrichment (exif, thumb, face, describe) can stay
 *       deferred to the normal worker pipeline.
 *
 * Returns `{ resolvedIds, indexedCount }` where:
 *   `resolvedIds` — 24-character asset ids, one per input path, same order.
 *   `indexedCount` — number of assets that were indexed on-demand.
 *
 * Throws a structured error when a path escapes the library roots.
 */
async function resolveAssetPaths(
  paths: string[],
): Promise<{ resolvedIds: string[]; indexedCount: number }> {
  const libs = await loadLibraryRoots();
  const { canonRootToFolderId, canonRoots, libIdToCanonRoot } = await canonicaliseRoots(libs);

  const resolvedIds: string[] = [];
  let indexedCount = 0;

  // ── 1. Normalize all paths ─────────────────────────────────────────────
  const normalized = await Promise.all(
    paths.map(async (rawPath) => {
      let absPath: string;
      try {
        absPath = await fs.realpath(rawPath);
      } catch {
        throw Object.assign(new Error(`Path does not exist or cannot be accessed: ${rawPath}`), {
          status: 400,
          code: 'path_not_found',
        });
      }

      const owningRoot = canonRoots.find((root) => isUnderRoot(absPath, root));
      if (!owningRoot) {
        throw Object.assign(
          new Error(
            `Path is outside every registered library root and cannot be stitched: ${absPath}`,
          ),
          { status: 400, code: 'path_outside_library' },
        );
      }
      const owningFolderId = canonRootToFolderId.get(owningRoot)!;
      const filename = path.basename(absPath);
      return { rawPath, absPath, owningRoot, owningFolderId, filename };
    }),
  );

  // ── 2. Bulk-fetch candidate docs by filename ───────────────────────────
  const allFilenames = [...new Set(normalized.map((p) => p.filename))];
  const candidateDocs = await findAssetLocationsByFilenames(allFilenames);

  const candidatesByFilename = byFilename(candidateDocs);

  // Helper to match a normalized path against a pre-filtered subset of docs
  // (keyed by filename) or a fresh flat list (used after on-demand indexing).
  const findInDocs = (
    absPath: string,
    filename: string,
    docs: AssetLocationsRow[],
  ): string | null => {
    for (const doc of docs) {
      for (const entry of doc.fileinfo) {
        if (entry.filename !== filename) continue;
        if (entry.deleted_at || entry.missing_since) continue;
        const libId = entry.library_id.toHexString();
        const libRoot = libIdToCanonRoot.get(libId) ?? libs.get(libId);
        if (!libRoot) continue;
        const segments = entry.path === '' ? [] : entry.path.split('/');
        const resolved = path.join(libRoot, ...segments, entry.filename);
        if (resolved === absPath) return doc._id.toHexString();
      }
    }
    return null;
  };

  // ── 3. Resolve each path ───────────────────────────────────────────────
  for (const p of normalized) {
    const found = findInDocs(p.absPath, p.filename, candidatesByFilename.get(p.filename) ?? []);

    if (found) {
      resolvedIds.push(found);
      continue;
    }

    // ── Index on-demand ──────────────────────────────────────────────────
    // The file is not yet in the assets collection. Run `handleEvent` —
    // the same per-file code path the discover producer uses — to create
    // the skeleton asset doc. This is lightweight: it hashes the file head
    // and upserts a fileinfo entry; heavy enrichment (thumb, exif, etc.)
    // runs asynchronously on the normal worker schedule.
    log.info({ absPath: p.absPath }, 'pano/stitch: indexing file on-demand');
    const { handleEvent } = await import('../workers/discover/index.ts');
    await handleEvent({ kind: 'created', absPath: p.absPath }, p.owningFolderId, p.owningRoot);
    indexedCount++;

    // Re-query after index to get the newly created id.
    const freshDocs = await findAssetLocationsByFilenames([p.filename]);
    const afterId = findInDocs(p.absPath, p.filename, freshDocs);

    if (!afterId) {
      throw Object.assign(new Error(`Failed to index file on-demand: ${p.absPath}`), {
        status: 500,
        code: 'index_on_demand_failed',
      });
    }
    resolvedIds.push(afterId);
  }

  return { resolvedIds, indexedCount };
}

const NOT_PROVISIONED = {
  error: 'pano_not_provisioned',
  message:
    'Panorama stitching is not configured. Go to Settings > Pano to set the ' +
    'maple-cli path and enable the feature.',
} as const;

/**
 * Provisioning, the binary's capabilities and the matcher, shared by the
 * stitch and preview routes — or the 409 body to refuse with.
 */
export async function planStitch() {
  const loaded = await loadEffectivePanoConfig();
  if (!isPanoProvisioned(loaded)) return { refusal: NOT_PROVISIONED };
  const cfg = await withExistingMlPaths(loaded);
  const mapleCli = cfg.maple_cli_path!;
  const capabilities = await probePanoCli(mapleCli);
  const plan = planPanoEngine(cfg, capabilities.featuresEngine);
  return plan.kind === 'refuse'
    ? { refusal: { error: plan.error, message: plan.message } }
    : { cfg: { ...cfg, maple_cli_path: mapleCli }, capabilities, plan };
}

type StitchPlan = Exclude<Awaited<ReturnType<typeof planStitch>>, { refusal: unknown }>;

type StitchInputs =
  | { uniqueIds: string[]; indexedCount: number }
  | { status: number; rejection: { error: string; message: string } };

const PATH_FAILURE_DEFAULTS: Record<number, { error: string; message: string }> = {
  400: { error: 'invalid_path', message: 'Invalid path.' },
  500: { error: 'index_failed', message: 'Index failed.' },
};

async function resolvePathInputs(
  assetPaths: string[] | undefined,
): Promise<
  { resolvedIds: string[]; indexedCount: number } | Extract<StitchInputs, { rejection: unknown }>
> {
  if (!assetPaths || assetPaths.length === 0) return { resolvedIds: [], indexedCount: 0 };
  try {
    return await resolveAssetPaths(assetPaths);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    const fallback = e.status === undefined ? undefined : PATH_FAILURE_DEFAULTS[e.status];
    if (!fallback) throw err;
    return {
      status: e.status!,
      rejection: { error: e.code ?? fallback.error, message: e.message ?? fallback.message },
    };
  }
}

/**
 * Server-authoritative input resolution. Per selected asset the client sends
 * its best reference: an absolute path (always fresh) or, only for an asset it
 * cannot name by path, an id. Paths are resolved to ids (indexing on demand,
 * jailed to the library roots) and unioned with the ids, so a mixed selection
 * stitches every asset instead of dropping one set.
 */
export async function resolveStitchInputs(body: {
  assetIds?: string[];
  assetPaths?: string[];
}): Promise<StitchInputs> {
  const fromPaths = await resolvePathInputs(body.assetPaths);
  if ('rejection' in fromPaths) return fromPaths;
  const assetIds = body.assetIds ?? [];
  const invalidId = assetIds.find((id) => !ObjectId.isValid(id));
  if (invalidId !== undefined) {
    return {
      status: 422,
      rejection: { error: 'invalid_asset_id', message: `Invalid asset id: ${invalidId}` },
    };
  }
  // A path and an id can resolve to the same deduplicated asset (identical
  // content shares one id); the stitcher must not receive one input twice.
  const uniqueIds = [...new Set([...fromPaths.resolvedIds, ...assetIds])];
  return uniqueIds.length < 2
    ? {
        status: 422,
        rejection: {
          error: 'insufficient_assets',
          message:
            'At least 2 valid images (via assetPaths or assetIds) are required to create a panorama.',
        },
      }
    : { uniqueIds, indexedCount: fromPaths.indexedCount };
}

/**
 * The alignment file of a finished preview, or null when the id does not name
 * one — the stitch then simply solves its own alignment. The path is rebuilt
 * from the server-written payload, never taken from the client.
 */
async function previewAlignment(previewJobId: string | undefined): Promise<string | null> {
  if (previewJobId === undefined || !ObjectId.isValid(previewJobId)) return null;
  const doc = await getJob(new ObjectId(previewJobId));
  if (doc?.kind !== 'pano_preview' || doc.status !== 'done') return null;
  const dir = ownedPreviewDir(doc.payload.outputDir);
  if (dir === null) return null;
  const file = path.join(dir, PREVIEW_FILES.alignment);
  return (await Bun.file(file).exists()) ? file : null;
}

export async function panoJobPayload(
  { cfg, capabilities, plan }: StitchPlan,
  request: StitchRequest,
  assetIds: string[],
  outputDir: string,
) {
  return {
    assetIds,
    libraryId: request.libraryId,
    outputDir,
    retention: request.options.retention,
    localAlign: request.options.localAlign,
    strategy: request.options.strategy ?? null,
    strategySupported: capabilities.strategy,
    mapleCli: cfg.maple_cli_path,
    featuresEngine: plan.featuresEngine,
    modelsDir: cfg.models_dir,
    ortDylibPath: cfg.ort_dylib_path,
    matcherNote: plan.matcherNote,
    alignmentIn: capabilities.preview ? await previewAlignment(request.alignmentFrom) : null,
  };
}

/** A pano job of one of `kinds` by id, or the 400/404 to answer with. */
export async function findPanoJob(
  id: string,
  kinds: ReadonlySet<string>,
): Promise<{ doc: JobWithId } | { status: 400 | 404; error: string }> {
  if (!ObjectId.isValid(id)) return { status: 400, error: 'Invalid job id' };
  const doc = await getJob(new ObjectId(id));
  return doc && kinds.has(doc.kind) ? { doc } : { status: 404, error: 'Pano job not found' };
}

// ── route group ───────────────────────────────────────────────────────────────

export const panoRoutes = new Elysia({ prefix: '/api/pano' })
  .use(requireAuth)

  // POST /api/pano/stitch — create a pano_stitch job.
  .post(
    '/stitch',
    async ({ body, set }) => {
      const stitchPlan = await planStitch();
      if ('refusal' in stitchPlan) {
        set.status = 409;
        return stitchPlan.refusal;
      }

      // The handler does `new ObjectId(payload.libraryId)`; a malformed id
      // would create a job guaranteed to crash at run time.
      if (!ObjectId.isValid(body.libraryId)) {
        set.status = 422;
        return {
          error: 'invalid_library_id',
          message: `Invalid library id: ${body.libraryId}`,
        };
      }

      const inputs = await resolveStitchInputs(body);
      if ('rejection' in inputs) {
        set.status = inputs.status;
        return inputs.rejection;
      }

      // The handler removes this temp dir after importing the result.
      const outputDir = path.join(os.tmpdir(), `maple-pano-${randomBytes(8).toString('hex')}`);
      const payload = await panoJobPayload(stitchPlan, body, inputs.uniqueIds, outputDir);
      const admitted = await admitPanoStitch(payload);
      if ('running' in admitted) {
        set.status = 409;
        return panoJobRunning(admitted.running._id);
      }
      if ('rejoined' in admitted) {
        return {
          id: admitted.rejoined._id.toHexString(),
          alignmentReused: admitted.rejoined.payload.alignmentIn != null,
        };
      }
      set.status = 201;
      return {
        id: admitted.created._id.toHexString(),
        alignmentReused: payload.alignmentIn !== null,
        ...(inputs.indexedCount > 0 ? { indexing: inputs.indexedCount } : {}),
      };
    },
    { body: StitchBody },
  )

  // GET /api/pano/jobs/:id — job status.
  .get('/jobs/:id', async ({ params, set }) => {
    const found = await findPanoJob(params.id, PANO_JOB_KINDS);
    if ('status' in found) {
      set.status = found.status;
      return { error: found.error };
    }
    return projectJob(found.doc);
  })

  // DELETE /api/pano/jobs/:id — cancel.
  .delete('/jobs/:id', async ({ params, set }) => {
    const found = await findPanoJob(params.id, PANO_JOB_KINDS);
    if ('status' in found) {
      set.status = found.status;
      return { error: found.error };
    }
    return { ok: await requestCancel(found.doc._id) };
  })

  // GET /api/pano/config — effective config + probed optional flags.
  .get('/config', async () => withProbedFlags(await loadEffectivePanoConfig()))

  // PUT /api/pano/config — upsert pano settings. Owner-only (#4743): the saved
  // binary and dylib are executed by the server.
  .put(
    '/config',
    async ({ body, set }) => {
      const jailed = await jailExecutablePaths(body);
      if (!jailed.ok) {
        set.status = 400;
        return { error: jailed.error };
      }
      await savePanoConfig({ ...body, ...jailed.canonical });
      invalidatePanoCliProbe();
      const cfg = await withProbedFlags(await loadEffectivePanoConfig());
      log.info({ enabled: cfg.enabled }, 'pano config updated');
      return { ok: true, ...cfg };
    },
    { body: ConfigBody, beforeHandle: requireOwnerBeforeHandle },
  );
