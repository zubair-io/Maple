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
import type { JobStatus, JobWithId } from '../db/schema.ts';

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

const StitchBody = t.Object({
  assetIds: t.Array(t.String(), { minItems: 2 }),
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

      // 3. Probe strategy support.
      const strategySupported = await probeStrategySupported(cfg.maple_cli_path!);

      // 4. Build temp output dir for this job (will be cleaned up by the handler
      //    after importing the result).
      const outputDir = path.join(os.tmpdir(), `maple-pano-${Date.now()}`);

      // 5. Create the job.
      const doc = await createJob({
        kind: 'pano_stitch',
        payload: {
          assetIds: body.assetIds,
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
      return { id: doc._id.toHexString() };
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
