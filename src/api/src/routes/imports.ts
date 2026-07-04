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
import type { ImportFileEntry, ImportStatus, ImportWithId } from '../db/schema.ts';
import { foldersCollection } from '../db/client.ts';
import { browseRoots, isUnderRoot } from '../fs/browse.ts';
import { scanFolder, buildImportFiles } from '../imports/scan.ts';
import { isSafeLabel } from '../imports/dest.ts';
import {
  createImport,
  getImport,
  getImportFiles,
  listImports,
  requestImportCancel,
  retryImport,
} from '../imports/repo.ts';
import { loadNearbyAssetCandidates } from '../imports/nearby.ts';

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

/** True when `source` IS `lib` or sits INSIDE it. Both should be absolute,
 * normalized (realpath) paths. We only reject this direction — importing from
 * a PARENT of the library (e.g. `/`) is allowed; the library's own files
 * dedup-skip, and loose files outside it import normally. */
function isInsideLibrary(source: string, lib: string): boolean {
  const s = source.replace(/\/+$/, '') || '/';
  const l = lib.replace(/\/+$/, '') || '/';
  if (s === l) return true;
  // `/` is a prefix of everything; otherwise add the separator so `/ab` isn't
  // treated as inside `/a`.
  const lPrefix = l === '/' ? '/' : l + '/';
  return s.startsWith(lPrefix);
}

interface ImportView {
  id: string;
  status: ImportStatus;
  source_root: string;
  library_id: string;
  library_root: string;
  files: ImportFileEntry[];
  /** Auto Import awaiting the worker's deferred scan (files not yet resolved). */
  scan_pending: boolean;
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
    scan_pending: doc.scan_pending ?? false,
    progress: doc.progress,
    counts: doc.counts,
    error: doc.error,
    cancel_requested: doc.cancel_requested,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

async function projectImport(doc: ImportWithId): Promise<ImportView> {
  // `files` lives in the `import_files` collection now (split out of the
  // import doc so a huge folder can't exceed MongoDB's 16 MiB doc limit).
  //
  // While an Auto Import is still `scan_pending`, the worker hasn't resolved
  // (or is mid-insert of) the file rows — present an empty list rather than a
  // partial one. Otherwise drop the internal `idx` field so the wire shape
  // stays exactly the pre-split `ImportFileEntry[]`.
  const files: ImportFileEntry[] = doc.scan_pending
    ? []
    : (await getImportFiles(doc._id)).map(({ idx: _idx, ...entry }) => entry);
  return { ...projectImportSummary(doc), files };
}

const ScanBody = t.Object({
  source_root: t.String(),
  /** Target library — optional so the endpoint still works before a library
   * is chosen, but when given, the preview also resolves nearby-asset
   * matches (see `ScanBucket.nearbyMatchCount`) against that library. */
  library_id: t.Optional(t.String()),
});

const CreateBody = t.Object({
  source_root: t.String(),
  library_id: t.String(),
  /** Per-bucket label overrides, keyed on the `${year}/${mm}` bucket key. */
  labels: t.Optional(t.Record(t.String(), t.String())),
  /** Auto Import — queue immediately and let the worker scan + resolve files
   * (default `MM` labels) instead of resolving them in this request. */
  auto: t.Optional(t.Boolean()),
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
      if (body.library_id !== undefined && !ObjectId.isValid(body.library_id)) {
        set.status = 400;
        return { error: 'Invalid library_id' };
      }
      const libraryId = body.library_id !== undefined ? new ObjectId(body.library_id) : null;
      const result = await scanFolder(jail.real, {
        loadNearbyCandidates:
          libraryId !== null
            ? (minMs, maxMs) => loadNearbyAssetCandidates(libraryId, minMs, maxMs)
            : undefined,
      });
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

      // Refuse to import from the target library itself or a folder inside it
      // — copying a library's files back into it produces duplicates /
      // copy-into-self. Resolve the library path too (the source is already a
      // realpath) so a library registered via a symlink or non-canonical path
      // can't slip past the check. A stale registration whose path no longer
      // resolves falls back to the stored value. (A PARENT of the library is
      // allowed — the library's own files dedup-skip.)
      let libReal = folder.path;
      try {
        libReal = await realpath(folder.path);
      } catch {
        // Library path missing on disk — compare against the stored path.
      }
      if (isInsideLibrary(jail.real, libReal)) {
        set.status = 400;
        return {
          error:
            'Source folder is the target library or inside it. Pick a source outside the library.',
        };
      }

      // Auto Import: queue immediately with no files; the worker scans
      // `source_root` (default `misc/<folder>` labels, or a nearby-asset/
      // shot-folder match — see `buildImportFiles`) and resolves destinations
      // when it claims the job. Keeps the click instant even for huge folders.
      if (body.auto) {
        const doc = await createImport({
          source_root: jail.real,
          library_id: folder._id,
          library_root: folder.path,
          files: [],
          scan_pending: true,
        });
        set.status = 201;
        return { id: doc._id.toHexString() };
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

      // buildImportFiles is resilient: an unsafe filename is recorded as a
      // failed entry (with its reason) rather than throwing and 400-ing the
      // whole folder. It only returns empty when the folder has nothing
      // importable at all.
      const files = await buildImportFiles(jail.real, labels, {
        loadNearbyCandidates: (minMs, maxMs) => loadNearbyAssetCandidates(folder._id, minMs, maxMs),
      });
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
      return query.summary === '1' ? projectImportSummary(doc) : await projectImport(doc);
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
  })

  // Re-queue a failed (or partially-failed) import: reset its failed files to
  // pending and clear the lease so a worker re-claims it. Already-copied files
  // stay copied (they dedup-skip on the re-run). Only valid for a `failed`
  // import or a `done` import with `counts.failed > 0`.
  .post('/:id/retry', async ({ params, set }) => {
    if (!ObjectId.isValid(params.id)) {
      set.status = 400;
      return { error: 'Invalid import id' };
    }
    const ok = await retryImport(new ObjectId(params.id));
    if (!ok) {
      set.status = 409;
      return { error: 'Import not found or not in a retryable state' };
    }
    return { ok: true };
  });
