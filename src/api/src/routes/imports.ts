/**
 * /api/imports — Imports HTTP surface (ticket #742).
 *
 *   POST /api/imports/scan        — scan a server-local folder, return buckets
 *   POST /api/imports             — create a pending import, returns `{ id }`
 *   GET  /api/imports?status=&limit=  — list imports (newest first)
 *   GET  /api/imports/:id         — full import doc with per-file progress
 *   POST /api/imports/:id/cancel  — request cancel (between-files granularity)
 *
 * Registered behind `requireAuth` in `src/index.ts`. Security: the source
 * folder must pass the MAPLE_ROOTS jail, and every bucket label is
 * re-validated server-side as a safe directory segment — the UI's check is
 * not trusted. See `docs/plans/2026-05-31-imports-feature.md`.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ImportStatus, ImportWithId } from '../db/schema.ts';
import { foldersCollection } from '../db/client.ts';
import { browseRoots, isUnderRoot } from '../fs/browse.ts';
import { scanFolder, buildImportFiles } from '../imports/scan.ts';
import { isSafeLabel } from '../imports/dest.ts';
import { createImport, getImport, listImports, requestImportCancel } from '../imports/repo.ts';

const KNOWN_STATUSES: ReadonlySet<ImportStatus> = new Set([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

/** Resolve `reqPath` and confirm it sits inside the MAPLE_ROOTS jail.
 * Returns the realpath on success, or an error string. */
async function resolveJailed(
  reqPath: string,
): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
  if (!reqPath || !path.isAbsolute(reqPath)) {
    return { ok: false, error: 'Path must be absolute.' };
  }
  let real: string;
  try {
    real = await realpath(reqPath);
  } catch (err) {
    return {
      ok: false,
      error: `Cannot access "${reqPath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const roots = await browseRoots();
  if (!roots.some((r) => isUnderRoot(real, r))) {
    return {
      ok: false,
      error: `Path "${real}" is outside MAPLE_ROOTS [${roots.join(', ')}]`,
    };
  }
  return { ok: true, real };
}

interface ImportView {
  id: string;
  status: ImportStatus;
  source_root: string;
  library_id: string;
  library_root: string;
  files: ImportWithId['files'];
  progress: { current: number; total: number };
  counts: { copied: number; skipped: number; failed: number };
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

/** Everything except the per-file `files` array — the only field that grows
 * with file count. List views and progress polling use this so they never
 * transfer a tens-of-thousands-entry array. */
type ImportSummaryView = Omit<ImportView, 'files'>;

function projectImportSummary(doc: ImportWithId): ImportSummaryView {
  return {
    id: doc._id.toHexString(),
    status: doc.status,
    source_root: doc.source_root,
    library_id: doc.library_id.toHexString(),
    library_root: doc.library_root,
    progress: doc.progress,
    counts: doc.counts,
    error: doc.error,
    cancel_requested: doc.cancel_requested,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function projectImport(doc: ImportWithId): ImportView {
  return { ...projectImportSummary(doc), files: doc.files };
}

const ScanBody = t.Object({ source_root: t.String() });

const CreateBody = t.Object({
  source_root: t.String(),
  library_id: t.String(),
  /** Per-bucket label overrides, keyed on the `${year}/${mm}` bucket key. */
  labels: t.Optional(t.Record(t.String(), t.String())),
});

const ListQuery = t.Object({
  status: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

const DetailQuery = t.Object({
  /** `1` → return the lightweight summary (no per-file `files` array). */
  summary: t.Optional(t.String()),
});

export const importsRoutes = new Elysia({ prefix: '/api/imports' })
  .post(
    '/scan',
    async ({ body, set }) => {
      const jail = await resolveJailed(body.source_root);
      if (!jail.ok) {
        set.status = 400;
        return { error: jail.error };
      }
      const result = await scanFolder(jail.real);
      return result;
    },
    { body: ScanBody },
  )

  .post(
    '/',
    async ({ body, set }) => {
      const jail = await resolveJailed(body.source_root);
      if (!jail.ok) {
        set.status = 400;
        return { error: jail.error };
      }
      if (!ObjectId.isValid(body.library_id)) {
        set.status = 400;
        return { error: 'Invalid library_id' };
      }
      const folder = await (
        await foldersCollection()
      ).findOne({ _id: new ObjectId(body.library_id) });
      if (!folder) {
        set.status = 404;
        return { error: 'Library not found' };
      }

      const labels: Record<string, string> = body.labels ?? {};
      // Re-validate every override server-side — a label becomes a directory
      // name, so the UI's check cannot be trusted.
      for (const [key, label] of Object.entries(labels)) {
        if (!isSafeLabel(label.trim())) {
          set.status = 400;
          return { error: `Unsafe bucket label for ${key}: ${JSON.stringify(label)}` };
        }
      }

      let files;
      try {
        files = await buildImportFiles(jail.real, labels);
      } catch (err) {
        // destRelPath throws on an unsafe label/filename it didn't expect.
        set.status = 400;
        return { error: err instanceof Error ? err.message : String(err) };
      }
      if (files.length === 0) {
        set.status = 400;
        return { error: 'No importable files found in the selected folder.' };
      }

      const doc = await createImport({
        source_root: jail.real,
        library_id: folder._id,
        library_root: folder.path,
        files,
      });
      set.status = 201;
      return { id: doc._id.toHexString() };
    },
    { body: CreateBody },
  )

  .get(
    '/',
    async ({ query, set }) => {
      const filter: { status?: ImportStatus; limit?: number } = {};
      if (query.status) {
        if (!KNOWN_STATUSES.has(query.status as ImportStatus)) {
          set.status = 400;
          return { error: `Unknown status: ${query.status}` };
        }
        filter.status = query.status as ImportStatus;
      }
      if (query.limit !== undefined && query.limit !== '') {
        const n = Number(query.limit);
        if (!Number.isFinite(n) || n < 1) {
          set.status = 400;
          return { error: `Invalid limit: ${query.limit}` };
        }
        filter.limit = Math.min(200, Math.floor(n));
      }
      const docs = await listImports(filter);
      // List omits `files` — only summary fields are needed here.
      return { imports: docs.map(projectImportSummary) };
    },
    { query: ListQuery },
  )

  .get(
    '/:id',
    async ({ params, query, set }) => {
      if (!ObjectId.isValid(params.id)) {
        set.status = 400;
        return { error: 'Invalid import id' };
      }
      const doc = await getImport(new ObjectId(params.id));
      if (!doc) {
        set.status = 404;
        return { error: 'Import not found' };
      }
      // `?summary=1` returns just status/progress/counts — the shape progress
      // polling needs, without the (potentially huge) per-file `files` array.
      return query.summary === '1' ? projectImportSummary(doc) : projectImport(doc);
    },
    { query: DetailQuery },
  )

  .post('/:id/cancel', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid import id' };
    }
    const ok = await requestImportCancel(new ObjectId(params.id));
    if (!ok) {
      set.status = 404;
      return { error: 'Import not found or already finished' };
    }
    return { ok: true };
  });
