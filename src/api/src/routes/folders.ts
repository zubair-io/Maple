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
import { readdir, open, rename, stat, unlink, mkdir, utimes } from '../fs/mirrored.ts';
import type { Dirent, Stats } from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha1 } from '@noble/hashes/legacy.js';
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
import { findAssetToReplaceAtAddress, upsertUploadedAsset } from '../db/repos/assets.address.ts';
import { hardDelete, markSoftDeleted } from '../db/repos/assets.trash.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { validateRoot } from '../fs/root.ts';
import { rootsConnected } from '../fs/root-connectivity.ts';
import { RAW_EXTENSIONS } from '../fs/browse.ts';
import { SHARP_EXTENSIONS, PSD_HDR_EXTENSIONS } from '../fs/browse.ts';
import { STUB_IMAGE_EXTENSIONS, AUDIO_EXTENSIONS } from '../fs/browse.ts';
import { moveToTrash } from '../fs/trash.ts';
import { DUPLICATES_DIR_NAME } from '../fs/duplicates.ts';
import { listPairedSidecars } from '../fs/xmp-conflict.ts';
import { child as childLogger } from '../log.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../runtime/http-etag.ts';
import { requireFileAccessBeforeHandle } from '../auth/middleware.ts';
import { handleEvent } from '../workers/discover/index.ts';
import { invalidateLibraryRoots, loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { slugify, dedupeSlug } from '../library/slug.ts';
import { realpathJailCheck } from '../library/address.ts';
import { assetAbsPath } from '../indexer/images.repo.ts';
import { ALL_STAGE_NAMES } from '../workers/stages/manifest.ts';
import { classifyMediaType } from '../indexer/media-types.ts';
import { safeObjectId } from '../db/object-id.ts';
import type { FolderWithId } from '../db/schema.ts';

// Mirror of the hash stage's prefix-SHA-1: first 64 KB. Reused here so a
// duplicate upload whose content is byte-identical to the file being
// replaced can drop the trash entry instead of leaving a redundant copy.
const SHA1_HEAD_BYTES = 64 * 1024;
async function sha1HeadHex(absPath: string): Promise<string> {
  const fd = await open(absPath, 'r');
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const digest = sha1(buf.subarray(0, bytesRead));
    let s = '';
    for (let i = 0; i < digest.length; i++) s += digest[i]!.toString(16).padStart(2, '0');
    return s;
  } finally {
    await fd.close();
  }
}

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
    async ({ params, headers, request, set }) => {
      const folder = await folderOrError(params.id);
      if (folder instanceof Response) return folder;
      const folderId = folder._id;

      const validated = decodeAndValidateTargetPath(headers);
      if (!validated.ok) {
        set.status = validated.status;
        return { error: validated.error };
      }
      const { target, parts } = validated;
      const filename = parts[parts.length - 1]!;
      const dot = filename.lastIndexOf('.');
      const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
      // Any file type may be uploaded and stored on disk so the File
      // Provider can sync everything. Only image/video/stub/audio files get
      // an `AssetDoc` — the catalog stays media-only. Everything else
      // (documents, archives, extensionless files) is stored + synced but
      // never indexed. Stub images (eip/braw/afphoto/ai) and audio
      // (mp3/wav/m4a/aac, #1835) get an AssetDoc too — metadata-only, no
      // thumbnail — so an uploaded stub/audio file is indexed rather than
      // silently stored-but-uncataloged.
      const isMedia =
        RAW_EXTENSIONS.has(ext) ||
        SHARP_EXTENSIONS.has(ext) ||
        PSD_HDR_EXTENSIONS.has(ext) ||
        STUB_IMAGE_EXTENSIONS.has(ext) ||
        AUDIO_EXTENSIONS.has(ext);

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
        const stream = request.body as ReadableStream<Uint8Array> | null;
        if (stream === null) {
          const fh = await open(tmp, 'w');
          await fh.close();
        } else {
          const sink = Bun.file(tmp).writer();
          try {
            const reader = stream.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) sink.write(value);
              }
            } finally {
              reader.releaseLock();
            }
            await sink.flush();
          } finally {
            await sink.end();
          }
        }
      } catch (err) {
        try {
          await unlink(tmp);
        } catch {}
        set.status = 500;
        return {
          error: `Upload write failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Serialize the post-write critical section per destination path
      // so two concurrent requests don't both miss the asset-doc upsert
      // and double-insert. The streaming write to the unique tmp above
      // is safe in parallel — only the stat→trash→rename→upsert chain
      // needs ordering. See `withUploadLock` for the rationale.
      return await withUploadLock(absPath, async () => {
        // If a file already lives at the target, move it to trash (RAW +
        // paired sidecars, with `.N` collision suffix) before the rename
        // overwrites it. Tracks the trashed doc's id + prefix-hash + size
        // so the post-write step can purge the trash entry when the new
        // upload is byte-identical to what we just moved aside.
        //
        // Concurrent-upload race: another request to the same target may
        // move the file between our `stat` and our `moveToTrash`. If
        // `moveToTrash` fails AND the file is now gone, treat it as
        // benign (the peer handled the trash + doc update); otherwise
        // surface the error.
        type Trashed = {
          docId: ObjectId;
          newAbsPath: string;
          sha1_head?: string;
          size?: number;
        };
        let trashed: Trashed | undefined;
        // Non-media files have no AssetDoc and no trash semantics — a
        // re-upload simply overwrites the bytes via the atomic rename below.
        if (isMedia)
          try {
            await stat(absPath);
            // Pre-compute the target location that's about to be overwritten
            // so we can look up the existing row by `(library_id, path,
            // filename)` instead of the retired `abs_path` field.
            const preRelDirRaw = nodePath.dirname(target);
            const preRelDir =
              preRelDirRaw === '.' || preRelDirRaw === ''
                ? ''
                : preRelDirRaw.split(nodePath.sep).join('/');
            const existing = await findAssetToReplaceAtAddress(folderId, preRelDir, filename);
            const moved = await moveToTrash(absPath, folder.path);
            if (moved.kind === 'ok') {
              if (existing) {
                // Repoint the asset at the trash destination and stamp it
                // soft-deleted, so cache resolution and restore can still find
                // the row. Passing no `source` keeps the historical
                // single-entry contract: every location is replaced by the one
                // that now holds the bytes. `live_location_count` follows from
                // the triggers on `asset_locations`, so the stale-count bug the
                // hand-maintained field had (#1302) cannot recur.
                await markSoftDeleted({
                  id: existing._id,
                  libraryRoot: folder.path,
                  libraryId: folderId,
                  newAbsPath: moved.newAbsPath,
                  originalAbsPath: absPath,
                });
                trashed = {
                  docId: existing._id,
                  newAbsPath: moved.newAbsPath,
                  sha1_head: existing.sha1_head ?? undefined,
                  size: existing.size,
                };
                // Mirror the DELETE route: emit a delete change so consumers
                // (e.g. WorkingSetEnumerator, which removes items only on
                // `.delete`) drop the pre-existing asset. The subsequent
                // `create` for the new bytes still publishes below.
                await recordAndPublishAssetChange({
                  kind: 'delete',
                  asset_id: existing._id,
                  folder_id: folderId,
                  abs_path: absPath,
                }).catch(() => {});
              }
            } else {
              let stillThere = false;
              try {
                await stat(absPath);
                stillThere = true;
              } catch {}
              if (stillThere) {
                try {
                  await unlink(tmp);
                } catch {}
                set.status = 500;
                return { error: `Upload trash failed: ${moved.error}` };
              }
              // Benign race — peer moved the file, peer owns its trash + doc
              // update. We proceed to rename our tmp into place.
            }
          } catch (err) {
            if ((err as { code?: string }).code !== 'ENOENT') {
              try {
                await unlink(tmp);
              } catch {}
              set.status = 500;
              return {
                error: `Upload pre-trash failed: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }

        try {
          await rename(tmp, absPath);
        } catch (err) {
          try {
            await unlink(tmp);
          } catch {}
          set.status = 500;
          return {
            error: `Upload rename failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        const st = await stat(absPath);
        const mtimeHeader = headers['x-maple-file-mtime'];
        if (typeof mtimeHeader === 'string' && /^\d+$/.test(mtimeHeader)) {
          const epoch = parseInt(mtimeHeader, 10);
          try {
            await utimes(absPath, epoch, epoch);
          } catch {}
        }

        // Non-media: bytes are stored + synced, but we create no AssetDoc.
        // Emit a path-addressed change (`asset_id: null`) so File Provider
        // clients see the new file without waiting for a re-enumeration —
        // `WorkingSetEnumerator.enumerateChanges` (#2535) resolves these via
        // `(folder_id, relative_path)` instead of an asset id.
        if (!isMedia) {
          await recordAndPublishAssetChange({
            kind: 'create',
            asset_id: null,
            folder_id: folderId,
            abs_path: absPath,
            relative_path: target,
          }).catch((err) => {
            log.warn(
              {
                folderId: folderId.toHexString(),
                relativePath: target,
                err: err instanceof Error ? err.message : err,
              },
              'change-feed emit failed after non-media upload (best-effort, ignoring)',
            );
          });
          set.status = 201;
          return {
            abs_path: absPath,
            size: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
          };
        }

        // If the file we just trashed had the same prefix-hash and size
        // as the new upload, the trash entry would be a redundant copy
        // of the freshly-written file — discard it (RAW + any paired
        // sidecars that `moveToTrash` relocated alongside).
        if (trashed && typeof trashed.sha1_head === 'string' && typeof trashed.size === 'number') {
          try {
            const newHead = await sha1HeadHex(absPath);
            if (newHead === trashed.sha1_head && st.size === trashed.size) {
              const sidecars = await listPairedSidecars(trashed.newAbsPath);
              try {
                await unlink(trashed.newAbsPath);
              } catch {}
              for (const sidecar of sidecars) {
                try {
                  await unlink(sidecar);
                } catch {}
              }
              await hardDelete(trashed.docId);
              trashed = undefined;
            }
          } catch (err) {
            log.warn(
              {
                absPath,
                err: err instanceof Error ? err.message : String(err),
              },
              'duplicate-upload identical-content check failed — leaving trash entry in place',
            );
          }
        }

        const nowIso = new Date().toISOString();
        // The canonical location mirrors the validated target path split into
        // (library-relative directory, filename, library_id). POSIX-normalize
        // `path.sep` → `/` so the stored path obeys the FileInfo docstring
        // contract on every host.
        const relDirRaw = nodePath.dirname(target);
        const relDir =
          relDirRaw === '.' || relDirRaw === '' ? '' : relDirRaw.split(nodePath.sep).join('/');
        // Create-or-update by `(library_id, path, filename)` to race-safely
        // cooperate with the discover watcher. If the watcher's chokidar tick
        // observed the just-written file first and already created a row, the
        // insert loses to the UNIQUE index and we update size/mtime over the
        // top; if we win the race, we own the insert.
        let assetID: ObjectId;
        try {
          assetID = await upsertUploadedAsset({
            libraryId: folderId,
            path: relDir,
            filename,
            size: st.size,
            mtimeMs: st.mtimeMs,
            indexedAt: nowIso,
            mediaKind: classifyMediaType(filename),
            stages: ALL_STAGE_NAMES,
          });
        } catch (err) {
          // A constraint violation or anything else: undo the file move so we
          // don't leak an orphan file with no catalog row backing it. The
          // address race is already handled inside the upsert.
          try {
            await unlink(absPath);
          } catch {}
          set.status = 500;
          return {
            error: `Upload metadata failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Best-effort change-feed emit so File Provider clients see the
        // new asset without waiting for the discover watcher to notice
        // the file. `.catch(() => {})` honours the Phase 5b guarantee
        // that change-feed failure is non-fatal to the primary write.
        await recordAndPublishAssetChange({
          kind: 'create',
          asset_id: assetID,
          folder_id: folderId,
          abs_path: absPath,
        }).catch(() => {});

        set.status = 201;
        // `mtime` is emitted as an ISO-8601 string (matches the rest of
        // the API and the Swift `Date` decoder); the raw `st.mtimeMs`
        // float would corrupt an `Int64` decoder client-side.
        return {
          asset_id: assetID.toHexString(),
          abs_path: absPath,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
        };
      });
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
      const folder = await folderOrError(params.id);
      if (folder instanceof Response) return folder;

      const validated = decodeAndValidateTargetPath(headers);
      if (!validated.ok) {
        set.status = validated.status;
        return { error: validated.error };
      }
      const absPath = nodePath.join(folder.path, validated.target);
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

      // Parse + validate `limit`. `Number("abc")` is `NaN`, which
      // `Math.min/max` preserve, and a `NaN` bound as a `LIMIT` is not a
      // page size anyone asked for. Reject non-numeric / out-of-range
      // values with 400 and clamp valid values into [1, 500].
      const limitRaw = query.limit;
      let limit = 100;
      if (typeof limitRaw === 'string' && limitRaw.length > 0) {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          set.status = 400;
          return { error: 'Invalid limit — must be a positive integer' };
        }
        limit = Math.min(500, parsed);
      }
      const cursor =
        typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : null;

      // One more row than the page, so "is there another page" is answered by
      // the read rather than by a second count.
      const docs = await listFolderTrash(folderId, { cursor, limit: limit + 1 });
      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const last = pageDocs[pageDocs.length - 1];
      const nextCursor = hasMore && last ? `${last.deleted_at}|${last._id.toHexString()}` : null;

      const rootPrefix = folder.path.endsWith('/') ? folder.path : folder.path + '/';
      const libs = await loadLibraryRoots();
      const items: Array<{
        asset_id: string;
        filename: string;
        original_relative_path: string;
        trash_relative_path: string;
        size: number;
        mtime: string;
        deleted_at: string;
        /** 'user' — user-initiated trash (restorable copy in .maple/trash);
         * 'reaped' — the missing-reaper soft-deleted it, no copy exists
         * (#2977). Additive field; older clients ignore it. */
        reason: 'user' | 'reaped';
      }> = [];
      for (const doc of pageDocs) {
        const primary = doc.fileinfo.find((e) => !e.deleted_at) ?? doc.fileinfo[0];
        if (!primary) continue;
        const isReaped = doc.deleted_reason === 'reaped';
        // A reaped row has no original_path and no trash copy — both wire
        // paths carry the stored (now-vanished) library-relative location.
        const storedRel =
          primary.path === '' ? primary.filename : `${primary.path}/${primary.filename}`;
        const orig = doc.original_path ?? '';
        const originalRel = isReaped
          ? storedRel
          : orig.startsWith(rootPrefix)
            ? orig.slice(rootPrefix.length)
            : orig;
        const absPath = isReaped ? null : assetAbsPath(doc, libs);
        if (!isReaped && !absPath) continue;
        const trashRel = isReaped
          ? storedRel
          : absPath!.startsWith(rootPrefix)
            ? absPath!.slice(rootPrefix.length)
            : absPath!;
        // `mtime` is `fs.stat().mtimeMs`, an epoch-millisecond number. Emit
        // ISO-8601 over the wire so the Swift `Date` decoder reads it.
        const mtimeIso = new Date(doc.mtime).toISOString();
        items.push({
          asset_id: doc._id.toHexString(),
          filename: primary.filename,
          original_relative_path: originalRel,
          trash_relative_path: trashRel,
          size: doc.size,
          mtime: mtimeIso,
          deleted_at: doc.deleted_at,
          reason: isReaped ? 'reaped' : 'user',
        });
      }
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
