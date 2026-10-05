/**
 * /api/folders routes.
 *
 * GET  /api/folders         — list all registered folders
 * POST /api/folders         — register a new folder (triggers scan)
 * GET  /api/folders/:id/assets — paged asset list for a folder
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
// Mirror-aware drop-in: uploads, folder moves, and mkdir replicate to the
// library's backup root(s). `rename` is directory-aware for folder moves.
import { readdir, rename, stat, mkdir } from '../fs/mirrored.ts';
import type { Dirent, Stats } from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  findFolderById,
  findFolderByPath,
  isSlugConflict,
  listFolderSlugs,
  listFolders,
  registerFolder,
  setFolderLastScan,
} from '../db/repos/folders.repo.ts';
import {
  listFolderAssets,
  listFolderTrash,
  resetFolderStages,
} from '../db/repos/folder-assets.repo.ts';
import { isIndexedUpload, streamUploadedBody, finalizeUploadedFile } from './folders.upload.ts';
import { parseFolderTrashPage, folderTrashItem } from './folders.trash-page.ts';
import { validateRoot } from '../fs/root.ts';
import { rootsConnected } from '../fs/root-connectivity.ts';
import { DUPLICATES_DIR_NAME } from '../fs/duplicates.ts';
import { child as childLogger } from '../log.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../runtime/http-etag.ts';
import { requireFileAccessBeforeHandle } from '../auth/middleware.ts';
import { handleEvent } from '../workers/discover/index.ts';
import { invalidateLibraryRoots, loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { slugify, dedupeSlug } from '../library/slug.ts';
import { realpathJailCheck } from '../library/address.ts';
import { safeObjectId } from '../db/object-id.ts';
import type { FolderWithId } from '../db/schema.ts';

const log = childLogger('folders');

// Auto-scan-on-open de-bounce window. `POST /:id/scan` (the content-aware
// re-discover the web fires when a folder is opened) short-circuits when the
// folder was scanned within this window, so rapid navigation across a
// library's sub-folders doesn't re-walk the tree on every click. The manual
// `POST /:id/rescan` button is NOT gated — an explicit user action always
// re-walks. A few minutes is long enough to absorb a burst of navigation and
// short enough that re-opening a folder after stepping away picks up moves.
const SCAN_RECENT_WINDOW_MS = 3 * 60 * 1000;

// In-process serialization for the upload route's post-write critical
// section (stat → trash → rename → upsert), keyed by destination abs
// path. Two concurrent uploads to the same target previously raced inside
// `findOneAndUpdate({fileinfo match}, ..., {upsert:true})` — without the
// unique `(folder_id, filename)` index that the drop-abs-path-2026-05-21
// migration retired, both ops can miss the find and each insert a doc,
// yielding two live rows for one path. Serializing by `absPath` makes
// the second request observe the first's freshly-written file + asset
// row and go down the duplicate-replace branch (trash + upsert reuse)
// instead. Cross-replica races still need a database-level constraint;
// this lock only covers a single bun instance.
const uploadLocks = new Map<string, Promise<unknown>>();
async function withUploadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = uploadLocks.get(key) ?? Promise.resolve();
  // `prior.then(fn, fn)` runs `fn` whether the prior link resolved or
  // rejected — a failed earlier upload shouldn't wedge the chain.
  const next = prior.then(fn, fn) as Promise<T>;
  uploadLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (uploadLocks.get(key) === next) {
      uploadLocks.delete(key);
    }
  }
}

/**
 * Decode + validate one percent-encoded relative-path header. `label`
 * names the header in error messages. Returns a discriminated result —
 * callers set `set.status` to the embedded status on failure and return
 * the embedded body. Validation rules:
 *   - header must be present and non-empty
 *   - percent-decoding must not throw (no `%ZZ`)
 *   - path must be relative (no leading `/`)
 *   - no empty paths after splitting on `/`
 *   - no `..` or `.` components
 *   - no leading-dot components (blocks writes into `.maple/`)
 *
 * Exported so `routes/folders-trash.ts` (#2630) can validate its own
 * `X-Maple-Target-Path` header with the exact same rules `/mkdir` and
 * `/move` use, instead of hand-rolling a second copy.
 */
export function validateRelPathHeader(
  raw: string | undefined,
  label: string,
): { ok: true; target: string; parts: string[] } | { ok: false; status: number; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, status: 400, error: `Missing ${label}` };
  }
  let target: string;
  try {
    target = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 400, error: `Invalid ${label} encoding` };
  }
  // Reject backslashes outright: the rest of the validator splits on
  // `/` only, so a Windows-style separator would smuggle path
  // components through as a single "filename" string and the resolved
  // `absPath` (via `nodePath.join`) would disagree with the `parts`
  // breakdown on any non-POSIX host. FileInfo.path is POSIX-only by
  // contract, so refusing backslashes here keeps the writer side
  // honest. Mirrors the discover watcher's POSIX-normalization invariant.
  if (target.includes('\\')) {
    return { ok: false, status: 400, error: 'Backslashes not allowed in path' };
  }
  if (target.startsWith('/')) {
    return { ok: false, status: 400, error: 'Path must be relative' };
  }
  const parts = target.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { ok: false, status: 400, error: 'Empty path' };
  }
  for (const part of parts) {
    if (part === '..' || part === '.') {
      return { ok: false, status: 400, error: 'Path traversal not allowed' };
    }
    if (part.startsWith('.')) {
      return {
        ok: false,
        status: 400,
        error: 'Hidden path components not allowed',
      };
    }
  }
  return { ok: true, target, parts };
}

/**
 * Decode + validate the `X-Maple-Target-Path` header shared by
 * `/upload`, `/mkdir`, and `/move`.
 */
function decodeAndValidateTargetPath(
  headers: Record<string, string | undefined>,
): { ok: true; target: string; parts: string[] } | { ok: false; status: number; error: string } {
  return validateRelPathHeader(headers['x-maple-target-path'], 'X-Maple-Target-Path');
}

/**
 * Resolve a library-relative `?path=` query param against a folder root and
 * confirm the symlink-resolved result stays inside that root. Shared by the
 * file download + stat endpoints (the path-addressed reads the File Provider
 * uses for non-indexed files). Defends against `..`, absolute paths, and
 * symlink escapes the same way the browse jail does.
 */
async function resolveFolderRelPath(
  folderPath: string,
  rawPath: string | undefined,
): Promise<{ ok: true; real: string } | { ok: false; status: number; error: string }> {
  if (typeof rawPath !== 'string' || rawPath === '') {
    return { ok: false, status: 400, error: 'missing path query param' };
  }
  // Centralised jail (single source of truth in library/address.ts): rejects
  // `..`/`.`/backslash/absolute, realpath-resolves the target and the root, and
  // confirms the result stays inside the library root.
  return realpathJailCheck(folderPath, rawPath);
}

/**
 * The library a `:id` route addresses, or the response to send instead.
 *
 * Six handlers opened by parsing the id, refusing an unparseable one with 400,
 * looking the row up and refusing a missing one with 404 — thirteen identical
 * lines each, which is most of what the duplication gate was seeing in this
 * file. The two scan routes are deliberately NOT folded in: their bodies carry
 * `ok: false` alongside the message and spell the field `folderId`, and both
 * are on the wire.
 *
 * Callers that need the id read it back from the row as `folder._id`, which is
 * the same value the parse produced.
 */
async function folderOrError(rawId: string): Promise<FolderWithId | Response> {
  const id = safeObjectId(rawId);
  if (id === null) return Response.json({ error: 'Invalid folder id' }, { status: 400 });
  const folder = await findFolderById(id);
  return folder ?? Response.json({ error: 'Folder not found' }, { status: 404 });
}

/** Upload and mkdir share the same library and target-header admission. */
async function folderTargetOrError(rawId: string, headers: Record<string, string | undefined>) {
  const folder = await folderOrError(rawId);
  if (folder instanceof Response) return folder;
  const validated = decodeAndValidateTargetPath(headers);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: validated.status });
  return { folder, target: validated.target, parts: validated.parts };
}

/**
 * One regular file inside a library, addressed by its library-relative path —
 * or the response to send instead.
 *
 * The two path-addressed reads the File Provider uses for non-indexed files
 * (`/:id/file` streams the bytes, `/:id/file-meta` answers size and mtime)
 * agree exactly on how to get from a `:id` and a `?path=` to a file, and
 * disagree only on what they do with it. Looking the library up, the jail
 * check, the `stat` and the refusal to serve anything that is not a regular
 * file are that agreement.
 */
async function folderFileOrError(
  rawId: string,
  rawPath: string | undefined,
): Promise<Response | { real: string; stat: Stats }> {
  const folder = await folderOrError(rawId);
  if (folder instanceof Response) return folder;
  const resolved = await resolveFolderRelPath(folder.path, rawPath);
  if (!resolved.ok) return Response.json({ error: resolved.error }, { status: resolved.status });
  const st = await stat(resolved.real).catch(() => null);
  if (st === null) return Response.json({ error: 'file not found' }, { status: 404 });
  if (!st.isFile()) return Response.json({ error: 'not a regular file' }, { status: 404 });
  return { real: resolved.real, stat: st };
}

/**
 * As {@link folderOrError}, for the two scan routes, whose refusals carry
 * `ok: false` and spell the field `folderId`.
 *
 * A second function rather than a flag on the first: both envelopes are on the
 * wire, and a boolean argument that silently decides which one a client parses
 * is the kind of thing that gets passed wrong once and is never noticed.
 */
async function scanTargetOrError(rawId: string): Promise<FolderWithId | Response> {
  const id = safeObjectId(rawId);
  if (id === null) {
    return Response.json({ ok: false, error: 'Invalid folderId' }, { status: 400 });
  }
  const folder = await findFolderById(id);
  return folder ?? Response.json({ ok: false, error: 'Folder not found' }, { status: 404 });
}

/**
 * Re-walks a library and stamps the time it finished, which is what both scan
 * routes mean by scanning: the walk pushes every supported file through the
 * discover producer, and `last_scan` is what the de-bounce on `/:id/scan`
 * reads afterwards. Returns the stamp so the caller can hand it back.
 */
async function rewalkFolder(folder: FolderWithId): Promise<string> {
  await scanFolderAndDiscover(folder.path, folder._id, folder.path);
  const scannedAt = new Date().toISOString();
  await setFolderLastScan(folder._id, scannedAt);
  return scannedAt;
}

export const foldersRoutes = new Elysia({ prefix: '/api/folders' })
  // List all folders. Body-hash ETag + If-None-Match short-circuit so the
  // File Provider extension can revalidate cheaply on cold Finder open.
  .get('/', async ({ headers, query }) => {
    const docs = await listFolders();
    // Timeout-capped + briefly cached, so a dead SMB mount can't hang the
    // sidebar's boot request (#2892) — see fs/root-connectivity.ts.
    // `?fresh=1` (Settings → Sources "Check again") bypasses the cache.
    const connectivity = await rootsConnected(
      // file_count passes through RAW: undefined (legacy doc) must not be
      // conflated with a known-empty 0 — see root-connectivity.ts's policy.
      docs.map((d) => ({ path: d.path, fileCount: d.file_count })),
      { fresh: query.fresh === '1' },
    );
    const payload = docs.map((d) => ({
      id: d._id.toHexString(),
      // slug is the public M1 address identifier; the web client falls back to
      // the raw ObjectId when it's absent, which breaks /api/folder/:slug.
      slug: d.slug,
      path: d.path,
      label: d.label,
      last_scan: d.last_scan,
      // Pre-slug-era docs can miss file_count; the DTO promises a number.
      file_count: d.file_count ?? 0,
      created_at: d.created_at,
      connected: connectivity.get(d.path) ?? false,
    }));
    const body = JSON.stringify(payload);
    const etag = computeBodyETag(body);
    const ifNoneMatch = headers['if-none-match'];
    if (ifNoneMatchEqual(typeof ifNoneMatch === 'string' ? ifNoneMatch : undefined, etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { ETag: etag, 'Content-Type': 'application/json' },
    });
  })

  // Register a new folder
  .post(
    '/',
    async ({ body, set }) => {
      const { path, label } = body;

      // Validate path exists and is accessible
      const validation = await validateRoot(path);
      if (!validation.ok) {
        set.status = 400;
        return { error: validation.error };
      }

      const existing = await findFolderByPath(path);
      if (existing) {
        set.status = 409;
        return {
          error: 'Folder already registered',
          id: existing._id.toHexString(),
        };
      }

      const now = new Date().toISOString();
      const derivedLabel = label ?? path.split('/').filter(Boolean).pop() ?? path;

      // Mint a unique slug and insert atomically with retry on duplicate-key.
      //
      // The in-memory deduplication races against concurrent POST /folders
      // requests: two simultaneous calls may both read the same taken-set,
      // mint the same slug, and then both attempt the insert. The unique
      // `folders_slug_unique` index catches the collision, and `isSlugConflict`
      // is what tells that apart from a duplicate `path` — which is a genuine
      // "already registered" answer, not something to retry. On a slug
      // collision we widen the suffix and retry (up to 5 attempts) so the
      // request succeeds deterministically without exposing a 500 to the
      // caller.
      //
      // The taken-set is queried ONCE, before the loop — not re-queried on
      // every retry. A re-query-per-attempt would keep reading the same
      // pre-collision snapshot until the OTHER request's insert actually
      // commits, so most retries would recompute the identical colliding
      // slug and burn all 5 attempts on it, turning a recoverable race into
      // a 500. Instead, each collision adds the slug that just lost to this
      // in-memory set and re-runs `dedupeSlug` against the widened set — the
      // retry loop stays entirely in-memory and always picks a new candidate.
      const baseSlug = slugify(derivedLabel);
      let slug: string;
      let folderId: ObjectId | undefined;
      const MAX_SLUG_ATTEMPTS = 5;
      const takenSlugs = new Set((await listFolderSlugs()).filter(Boolean));
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        slug = dedupeSlug(baseSlug, takenSlugs);
        try {
          folderId = await registerFolder({
            path,
            label: derivedLabel,
            slug,
            createdAt: now,
          });
          break; // success
        } catch (err) {
          if (isSlugConflict(err)) {
            // Concurrent insert claimed this slug — widen the in-memory
            // taken-set with the collision and retry (no re-query).
            log.warn({ attempt, slug: slug! }, 'slug duplicate-key on insert, retrying');
            takenSlugs.add(slug!);
            continue;
          }
          throw err; // not a slug collision — rethrow
        }
      }
      if (!folderId) {
        set.status = 500;
        return {
          error: 'Could not mint a unique slug after retries; please try again',
        };
      }

      const id = folderId.toHexString();

      // The library-roots cache (used by every fileinfo[] resolver) must
      // re-read after this insert so the new library is visible.
      invalidateLibraryRoots();

      // Fire-and-forget: walk the new folder and push each supported image
      // file through the discover producer so the pipeline starts indexing
      // immediately without waiting for the next watcher tick. The library
      // root is `path` itself (we just inserted the row with that path),
      // passed through so handleEvent doesn't re-fetch the folder doc.
      void scanFolderAndDiscover(path, folderId, path).catch((err) =>
        log.warn(
          { path, err: err instanceof Error ? err.message : err },
          'initial folder scan failed — files will be indexed on next watcher tick',
        ),
      );

      set.status = 201;
      return {
        id,
        path,
        label: derivedLabel,
        slug: slug!,
        last_scan: null,
        file_count: 0,
        created_at: now,
      };
    },
    {
      beforeHandle: requireFileAccessBeforeHandle,
      body: t.Object({
        path: t.String({ minLength: 1 }),
        label: t.Optional(t.String()),
      }),
    },
  )

  // Paged asset list for a folder
  .get(
    '/:id/assets',
    async ({ params, query, set }) => {
      let folderId: ObjectId;
      try {
        folderId = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: 'Invalid folder id' };
      }

      const page = Math.max(1, Number(query.page ?? 1));
      const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
      const skip = (page - 1) * limit;

      // Name-ordered, and the name is one this library actually holds: the
      // page groups the library's own location rows, where the Mongo
      // projection picked the asset's first live `fileinfo` entry whatever
      // library it pointed at.
      const { items, total } = await listFolderAssets(folderId, { skip, limit });

      return {
        folder_id: params.id,
        page,
        limit,
        total,
        assets: items.map((row) => ({
          id: row.id,
          filename: row.filename,
          size: row.size,
          mtime: row.mtime,
          rating: row.rating,
          flag: row.flag,
          color_label: row.color_label,
          indexed_at: row.indexed_at,
          // S2 "Edited" filter chip backing (#628) — true iff the XMP
          // write/delete handlers (Phase 5b) have observed a sidecar
          // next to this asset.
          has_xmp: row.has_xmp === 1,
          owner_id: row.owner_id,
          owner: row.owner,
        })),
      };
    },
    {
      beforeHandle: requireFileAccessBeforeHandle,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  // Rescan a folder — resets stages.*.version to 0 (and clears dead/attempts/
  // last_error) for every asset doc whose primary fileinfo entry is in the
  // library. The stage controllers pick them up on their next poll cycle.
  .post(
    '/:id/rescan',
    async ({ params }) => {
      const folderIdStr = params.id;
      const folder = await scanTargetOrError(folderIdStr);
      if (folder instanceof Response) return folder;
      const id = folder._id;
      const scanRoot = folder.path;

      // Zero every stage's version and clear dead/attempts/last_error so the
      // claim query picks the assets back up. Reported as assets rather than
      // stage rows — one library-wide `updateMany` over documents became one
      // over the `stage_state` rows those documents' `stages.*` became.
      const resetCount = await resetFolderStages(id);

      // Re-walk the filesystem so a moved/new file is re-discovered and relinked
      // (handleEvent dedups by maple_id/sha1_head, appends a live fileinfo, and
      // clears deleted_at). Without this the button only zeroed stage versions —
      // it could not recover a file whose only fileinfo was a soft-deleted old
      // path. The walk runs to completion within the request: libraries are
      // bounded and the dedup path is idempotent + concurrency-safe.
      const scannedAt = await rewalkFolder(folder);

      log.info(
        {
          folderId: folderIdStr,
          path: scanRoot,
          modified: resetCount,
        },
        'rescan: stage versions zeroed + folder re-walked',
      );

      return {
        ok: true,
        folderId: folderIdStr,
        path: scanRoot,
        reset: resetCount,
        last_scan: scannedAt,
      };
    },
    { beforeHandle: requireFileAccessBeforeHandle },
  )

  // Content-aware re-discover for auto-scan-on-open (#804). Walks the folder
  // tree and pushes every supported file through the discover producer, which
  // dedups by maple_id/sha1_head and RELINKS moved/new files (appends a live
  // fileinfo, clears deleted_at) onto their existing asset row. Unlike
  // `/:id/rescan` this does NOT zero stage versions — zeroing on every folder
  // open would reprocess the whole library. Gated by `last_scan`: a folder
  // scanned within SCAN_RECENT_WINDOW_MS short-circuits so rapid navigation
  // doesn't re-walk. The walk runs to completion within the request (bounded
  // libraries; the dedup path is idempotent + concurrency-safe), so callers
  // get an authoritative "scan done" before refreshing their listing.
  .post(
    '/:id/scan',
    async ({ params }) => {
      const folderIdStr = params.id;
      const folder = await scanTargetOrError(folderIdStr);
      if (folder instanceof Response) return folder;

      // last_scan de-bounce: skip the re-walk when the folder was scanned
      // within the recent window. Repeated/concurrent calls are safe either
      // way (the discover path is idempotent), but skipping avoids redundant
      // filesystem walks on rapid navigation.
      const lastScan = folder.last_scan ? Date.parse(folder.last_scan) : NaN;
      if (Number.isFinite(lastScan) && Date.now() - lastScan < SCAN_RECENT_WINDOW_MS) {
        return {
          ok: true,
          folderId: folderIdStr,
          path: folder.path,
          skipped: 'recent' as const,
          last_scan: folder.last_scan,
        };
      }

      const scannedAt = await rewalkFolder(folder);

      log.info(
        { folderId: folderIdStr, path: folder.path },
        'scan: folder re-walked (discover-only)',
      );

      return {
        ok: true,
        folderId: folderIdStr,
        path: folder.path,
        last_scan: scannedAt,
      };
    },
    { beforeHandle: requireFileAccessBeforeHandle },
  )

  // Streaming upload: body is raw file bytes, target path in X-Maple-Target-Path.
  //
  // The route reads `request.body` directly as a Web ReadableStream and
  // pipes it to disk chunk-by-chunk via `Bun.write`. Earlier revisions
  // used `type: "arrayBuffer"`, which made Elysia buffer the entire
  // body in RAM before the handler ran — a 1 GB upload would have
  // spiked server RSS by 1 GB. Streaming keeps the working set bounded
  // to a few KB regardless of file size.
  .post(
    '/:id/upload',
    async (ctx) => {
      const { params, headers, request, set } = ctx;
      const ownerId = (ctx as { auth?: { user?: { sub?: string } } }).auth?.user?.sub;
      const destination = await folderTargetOrError(params.id, headers);
      if (destination instanceof Response) return destination;
      const { folder, target, parts } = destination;
      const filename = parts[parts.length - 1]!;
      const isMedia = isIndexedUpload(filename);

      const absPath = nodePath.join(folder.path, target);

      const dir = nodePath.dirname(absPath);
      await mkdir(dir, { recursive: true });

      // Stream the new body to a tmp file. Streaming keeps RSS bounded
      // regardless of upload size (unlike a buffered `fh.writeFile`
      // over an `ArrayBuffer` body). The atomic rename(tmp, target)
      // happens AFTER any existing file at the target has been moved
      // to trash, so a duplicate upload never destroys the prior copy.
      const tmp = nodePath.join(dir, `.upload-${randomUUID()}`);
      try {
        await streamUploadedBody(tmp, request.body as ReadableStream<Uint8Array> | null);
        // Serialize only the publication/Trash/catalog section. Body writes
        // remain streamed in parallel to independent temporary paths.
        const result = await withUploadLock(absPath, () =>
          finalizeUploadedFile({
            folder,
            target,
            filename,
            absPath,
            tmp,
            isMedia,
            mtimeHeader: headers['x-maple-file-mtime'],
            ownerId,
          }),
        );
        set.status = 201;
        return result;
      } catch (error) {
        set.status = 500;
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    {
      // Skip Elysia body parsing — the handler consumes `request.body`
      // as a ReadableStream directly so it can stream to disk without
      // buffering. With no `type:` / `parse:` set, Elysia leaves the
      // body untouched.
      parse: 'none',
      beforeHandle: requireFileAccessBeforeHandle,
    },
  )

  // Stream the raw bytes of a file addressed by its library-relative path.
  // Used by the File Provider to materialize non-indexed files (which have
  // no AssetDoc, so the `/api/assets/:id/raw` route can't reach them).
  .get('/:id/file', async ({ params, query }) => {
    const file = await folderFileOrError(params.id, query.path);
    if (file instanceof Response) return file;
    const { real, stat: st } = file;
    return new Response(Bun.file(real).stream(), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(st.size),
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      },
    });
  })

  // Stat a file addressed by its library-relative path. Lets the File
  // Provider resolve a bare `.file(folderID, relativePath)` identifier to an
  // item (size + mtime) without downloading the bytes.
  .get('/:id/file-meta', async ({ params, query }) => {
    const file = await folderFileOrError(params.id, query.path);
    if (file instanceof Response) return file;
    const { real, stat: st } = file;
    const name = nodePath.basename(real);
    const dot = name.lastIndexOf('.');
    return {
      name,
      path: real,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      ext: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
    };
  })

  // Create a subdirectory under a library root. Target path in the
  // `X-Maple-Target-Path` header (URL-encoded), same validation rules
  // as the upload route. Idempotent — `mkdir -p` doesn't fail when the
  // target already exists.
  //
  // The File Provider extension calls this when the user creates a new
  // folder in Finder, or drags a folder of files in (the OS triggers a
  // folder createItem first, then per-file createItems against the new
  // folder as parent). Without an explicit mkdir hook the folder
  // createItem fell into featureUnsupported and the whole drag aborted
  // before any child file got a chance to upload.
  .post(
    '/:id/mkdir',
    async ({ params, headers, set }) => {
      const destination = await folderTargetOrError(params.id, headers);
      if (destination instanceof Response) return destination;
      const absPath = nodePath.join(destination.folder.path, destination.target);
      try {
        await mkdir(absPath, { recursive: true });
      } catch (err) {
        set.status = 500;
        return {
          error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      set.status = 201;
      return { abs_path: absPath };
    },
    { beforeHandle: requireFileAccessBeforeHandle },
  )

  // Rename or move a subdirectory within a library root. Source path in
  // `X-Maple-Source-Path`, destination path in `X-Maple-Target-Path`
  // (both URL-encoded, relative to the library root, same validation as
  // `/mkdir`). The whole directory is renamed on disk — paired sidecars
  // and the `.maple/` thumb cache ride along because they live inside
  // it. The DB's `fileinfo` paths are reconciled by the discover watcher
  // (it coalesces the per-file unlink+add into renames), so this route
  // does not touch the database.
  //
  // The File Provider extension calls this when the user renames or
  // moves a folder in Finder (`modifyItem` with `.filename` and/or
  // `.parentItemIdentifier`). Without it, folder rename returned
  // featureUnsupported and Finder surfaced an error while leaving the
  // freshly-created "untitled folder" stranded on the server.
  .post(
    '/:id/move',
    async ({ params, headers, set }) => {
      const folder = await folderOrError(params.id);
      if (folder instanceof Response) return folder;

      const source = validateRelPathHeader(headers['x-maple-source-path'], 'X-Maple-Source-Path');
      if (!source.ok) {
        set.status = source.status;
        return { error: source.error };
      }
      const target = validateRelPathHeader(headers['x-maple-target-path'], 'X-Maple-Target-Path');
      if (!target.ok) {
        set.status = target.status;
        return { error: target.error };
      }

      const absSource = nodePath.join(folder.path, source.target);
      const absTarget = nodePath.join(folder.path, target.target);

      // Reject moving a folder onto itself or into its own subtree — that
      // would either be a no-op or an `fs.rename` error, and silently
      // mangles the tree if it ever succeeded.
      const rel = nodePath.relative(absSource, absTarget);
      if (rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel))) {
        set.status = 400;
        return { error: 'Cannot move a folder into itself or its own subtree' };
      }

      let srcStat;
      try {
        srcStat = await stat(absSource);
      } catch {
        set.status = 404;
        return { error: 'Source folder not found' };
      }
      if (!srcStat.isDirectory()) {
        set.status = 400;
        return { error: 'Source is not a directory' };
      }

      // Refuse to clobber an existing destination. `fs.rename` would
      // overwrite an empty dir or fail on a non-empty one; an explicit
      // 409 lets Finder surface a name collision instead. Only ENOENT
      // (target is free) is the happy path — any other stat error
      // (permissions, transient IO) is surfaced as a 500 rather than
      // silently proceeding to rename.
      try {
        await stat(absTarget);
        set.status = 409;
        return { error: 'Target already exists' };
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') {
          set.status = 500;
          return {
            error: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      try {
        await mkdir(nodePath.dirname(absTarget), { recursive: true });
        await rename(absSource, absTarget);
      } catch (err) {
        set.status = 500;
        return {
          error: `move failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      set.status = 200;
      return { abs_path: absTarget };
    },
    { beforeHandle: requireFileAccessBeforeHandle },
  )

  // Paged list of trashed assets for one library, newest-first.
  // Cursor format: "<deleted_at_iso>|<hex_id>" — page where
  // deleted_at < iso, OR (deleted_at == iso AND _id < hex_id).
  // Filters require both deleted_at and original_path so vanished
  // (watcher-removed) assets stay out of Trash.
  .get(
    '/:id/trash',
    async ({ params, query, set }) => {
      const folder = await folderOrError(params.id);
      if (folder instanceof Response) return folder;
      const folderId = folder._id;

      const options = parseFolderTrashPage(query);
      if ('error' in options) {
        set.status = 400;
        return { error: options.error };
      }
      const { limit, cursor } = options;

      // One more row than the page, so "is there another page" is answered by
      // the read rather than by a second count.
      const docs = await listFolderTrash(folderId, { cursor, limit: limit + 1 });
      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const last = pageDocs[pageDocs.length - 1];
      const nextCursor = hasMore && last ? `${last.deleted_at}|${last._id.toHexString()}` : null;

      const rootPrefix = folder.path.endsWith('/') ? folder.path : folder.path + '/';
      const libs = await loadLibraryRoots();
      const items = pageDocs
        .map((doc) => folderTrashItem(doc, rootPrefix, libs))
        .filter((item) => item !== null);
      return {
        items,
        next_cursor: nextCursor,
      };
    },
    {
      beforeHandle: requireFileAccessBeforeHandle,
      query: t.Object({
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    },
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Supported image extensions (lowercase with leading dot). Pre-filter for
 * `scanFolderAndDiscover` below — cheap to skip an unsupported file here
 * rather than calling `handleEvent` (which is itself gated by the canonical
 * `SUPPORTED_EXTS` in `workers/discover/types.ts`) and having it no-op.
 * Note: this list has drifted narrower than the canonical one (missing
 * video/psd/psb/hdr) — out of scope to reconcile here; adding the #1835
 * metadata-only stub/audio formats so a newly-registered folder containing
 * them gets those files indexed on the initial scan, not just via the live
 * file watcher. */
const SUPPORTED_EXTS = new Set([
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.x3f',
  '.3fr',
  '.mef',
  '.erf',
  '.mrw',
  '.raw',
  '.fff',
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  // Metadata-only stub images + audio (#1835) — see media-types.ts.
  '.eip',
  '.braw',
  '.afphoto',
  '.ai',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
]);

/**
 * Bounded async dispatcher — runs at most `limit` concurrent invocations of
 * `run` across all `items`. Errors from individual items are swallowed (callers
 * log before throwing or after the pool drains).
 */
async function dispatchPool<T>(
  items: T[],
  limit: number,
  run: (i: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const item = items[idx++]!;
      await run(item).catch(() => {});
    }
  });
  await Promise.all(workers);
}

/**
 * Recursively walk `rootPath` and call `handleEvent({ kind: "created" })` for
 * every supported image file found. Uses a bounded directory queue (CONCURRENCY=8)
 * to avoid file-descriptor exhaustion and a dispatchPool to limit concurrent
 * handleEvent calls (also 8) so DB write pressure stays bounded on large trees.
 * Silently skips permission-denied subtrees.
 */
async function scanFolderAndDiscover(
  rootPath: string,
  folderId: ObjectId,
  libraryRoot: string,
): Promise<void> {
  const CONCURRENCY = 8;
  const queue: string[] = [rootPath];

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    const fileBatch: string[] = [];

    await Promise.all(
      batch.map(async (dir) => {
        let entries: Dirent[];
        try {
          entries = (await readdir(dir, {
            withFileTypes: true,
          })) as unknown as Dirent[];
        } catch {
          return; // permission denied or not a directory
        }
        for (const entry of entries) {
          const entryName = entry.name as unknown as string;
          // Skip dotdirs (`.maple`, `.thumbnails`, …) and the DeDuplicate
          // quarantine — `_duplicates` holds relocated copies that must not be
          // re-indexed (they are byte-identical to the kept originals).
          if (entryName.startsWith('.') || entryName === DUPLICATES_DIR_NAME) continue;
          const absPath = nodePath.join(dir, entryName);
          if (entry.isDirectory()) {
            queue.push(absPath);
          } else if (entry.isFile()) {
            const ext = nodePath.extname(entryName).toLowerCase();
            if (!SUPPORTED_EXTS.has(ext)) continue;
            fileBatch.push(absPath);
          }
        }
      }),
    );

    // Dispatch the files found in this directory batch with bounded concurrency.
    await dispatchPool(fileBatch, CONCURRENCY, async (absPath) => {
      await handleEvent({ kind: 'created', absPath }, folderId, libraryRoot).catch((err) =>
        log.warn(
          { absPath, err: err instanceof Error ? err.message : err },
          'discover upsert failed during initial folder scan',
        ),
      );
    });
  }
}
