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
import { admitPanoStitch, panoJobRunning } from '../pano/pano-admission.ts';
import { resolveAssetPaths } from '../pano/pano-path-inputs.ts';

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
    boundaryWarp: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
    autoCrop: t.Optional(t.Boolean()),
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
    : { strategy: false, featuresEngine: false, preview: false, edges: false };
  return {
    ...cfg,
    strategy_supported: capabilities.strategy,
    features_engine_supported: capabilities.featuresEngine,
    preview_supported: capabilities.preview,
    edges_supported: capabilities.edges,
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

/** The 409 for a request that asks for the edge options of a binary without them. */
export function edgesRefusal(plan: StitchPlan, request: StitchRequest) {
  const asked = (request.options.boundaryWarp ?? 0) > 0 || request.options.autoCrop === true;
  return asked && !plan.capabilities.edges
    ? {
        error: 'pano_edges_unsupported',
        message: 'The configured maple-cli predates Boundary Warp and Auto Crop.',
      }
    : null;
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
    boundaryWarp: request.options.boundaryWarp ?? 0,
    autoCrop: request.options.autoCrop ?? false,
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

      const unsupportedEdges = edgesRefusal(stitchPlan, body);
      if (unsupportedEdges) {
        set.status = 409;
        return unsupportedEdges;
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
