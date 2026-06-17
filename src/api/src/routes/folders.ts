/**
 * /api/folders routes.
 *
 * GET  /api/folders         — list all registered folders
 * POST /api/folders         — register a new folder (triggers scan)
 * GET  /api/folders/:id/assets — paged asset list for a folder
 */

import { Elysia, t } from 'elysia';
import { ObjectId, type Collection, type Document } from 'mongodb';
// Mirror-aware drop-in: uploads, folder moves, and mkdir replicate to the
// library's backup root(s). `rename` is directory-aware for folder moves.
import { readdir, open, rename, stat, unlink, mkdir, utimes, realpath } from '../fs/mirrored.ts';
import type { Dirent } from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha1 } from '@noble/hashes/legacy.js';
import { foldersCollection, assetsCollection } from '../db/client.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { validateRoot } from '../fs/root.ts';
import { RAW_EXTENSIONS, isUnderRoot } from '../fs/browse.ts';
import { SHARP_EXTENSIONS } from '../fs/browse.ts';
import { moveToTrash } from '../fs/trash.ts';
import { DUPLICATES_DIR_NAME } from '../fs/duplicates.ts';
import { listPairedSidecars } from '../fs/xmp.ts';
import { child as childLogger } from '../log.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../runtime/http-etag.ts';
import { handleEvent } from '../workers/discover/index.ts';
import { invalidateLibraryRoots, loadLibraryRoots } from '../indexer/libraries.cache.ts';
import { slugify, dedupeSlug } from '../library/slug.ts';
import { realpathJailCheck } from '../library/address.ts';
import { assetAbsPath, updateLiveLocationCount } from '../indexer/images.repo.ts';
import type { AssetWithId } from '../db/schema.ts';
import { stageManifest, blankStagesSkeleton } from '../workers/stages/manifest.ts';

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
 */
function validateRelPathHeader(
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
  if (nodePath.isAbsolute(rawPath) || rawPath.split('/').includes('..')) {
    return {
      ok: false,
      status: 400,
      error: 'path must be relative and contain no ".." segments',
    };
  }
  const abs = nodePath.join(folderPath, rawPath);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return { ok: false, status: 404, error: 'file not found' };
  }
  // Resolve the library root to its realpath as well, so a symlinked root
  // prefix (e.g. `/var` → `/private/var` on macOS) doesn't falsely reject a
  // valid request: `real` is already symlink-resolved, so the jail check must
  // compare against an equally-resolved root. Best-effort — fall back to the
  // configured path if the root itself can't be resolved.
  let realRoot = folderPath;
  try {
    realRoot = await realpath(folderPath);
  } catch {
    /* keep the configured path */
  }
  if (!isUnderRoot(real, realRoot)) {
    return { ok: false, status: 400, error: 'path escapes the library root' };
  }
  return { ok: true, real };
}

export const foldersRoutes = new Elysia({ prefix: '/api/folders' })
  // List all folders. Body-hash ETag + If-None-Match short-circuit so the
  // File Provider extension can revalidate cheaply on cold Finder open.
  .get('/', async ({ headers }) => {
    const coll = await foldersCollection();
    const docs = await coll.find({}).sort({ created_at: 1 }).toArray();
    const payload = docs.map((d) => ({
      id: d._id.toHexString(),
      // slug is the public M1 address identifier; the web client falls back to
      // the raw ObjectId when it's absent, which breaks /api/folder/:slug.
      slug: d.slug,
      path: d.path,
      label: d.label,
      last_scan: d.last_scan,
      file_count: d.file_count,
      created_at: d.created_at,
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

      const coll = await foldersCollection();
      const existing = await coll.findOne({ path });
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
      // `folders_slug_unique` index catches the collision (Mongo code 11000).
      // On E11000 we increment the suffix and retry (up to 5 attempts) so
      // the request succeeds deterministically without exposing a 500 to the
      // caller.
      const baseSlug = slugify(derivedLabel);
      let slug: string;
      let insertResult: Awaited<ReturnType<typeof coll.insertOne>> | undefined;
      const MAX_SLUG_ATTEMPTS = 5;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        const takenSlugs = await coll
          .find({ slug: { $exists: true } } as never, { projection: { slug: 1 } })
          .toArray()
          .then(
            (rows) =>
              new Set((rows as Array<{ slug?: string }>).map((r) => r.slug!).filter(Boolean)),
          );
        slug = dedupeSlug(baseSlug, takenSlugs);
        try {
          insertResult = await coll.insertOne({
            path,
            label: derivedLabel,
            slug,
            last_scan: null as string | null,
            file_count: 0,
            created_at: now,
          } as never);
          break; // success
        } catch (err) {
          const mongoErr = err as { code?: number; keyPattern?: Record<string, unknown> };
          if (mongoErr.code === 11000 && mongoErr.keyPattern?.['slug'] !== undefined) {
            // Concurrent insert claimed the same slug — retry with fresh taken-set.
            log.warn({ attempt, slug: slug! }, 'slug duplicate-key on insert, retrying');
            continue;
          }
          throw err; // not a slug collision — rethrow
        }
      }
      if (!insertResult) {
        set.status = 500;
        return { error: 'Could not mint a unique slug after retries; please try again' };
      }

      const id = insertResult.insertedId.toHexString();
      const folderId = insertResult.insertedId;

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

      const coll = await assetsCollection();
      const filter = { 'fileinfo.library_id': folderId };
      const [docs, total] = await Promise.all([
        // Multikey path (no positional `.0.`) so the `fileinfo_filename_1`
        // index satisfies the sort. See `routes/search/sort.ts` for the
        // semantics note on multi-entry fileinfo arrays.
        coll.find(filter).sort({ 'fileinfo.filename': 1 }).skip(skip).limit(limit).toArray(),
        coll.countDocuments(filter),
      ]);

      return {
        folder_id: params.id,
        page,
        limit,
        total,
        assets: docs.map((d) => {
          const primary = (d.fileinfo ?? []).find((e) => !e.deleted_at) ?? d.fileinfo?.[0];
          return {
            id: d._id.toHexString(),
            filename: primary?.filename ?? '',
            size: d.size,
            mtime: d.mtime,
            rating: d.rating,
            flag: d.flag,
            color_label: d.color_label,
            indexed_at: d.indexed_at,
            // S2 "Edited" filter chip backing (#628) — true iff the XMP
            // write/delete handlers (Phase 5b) have observed a sidecar
            // next to this asset. Optional because legacy docs predate
            // the flag; client coerces missing as `false`.
            has_xmp: d.has_xmp ?? false,
          };
        }),
      };
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  // Rescan a folder — resets stages.*.version to 0 (and clears dead/attempts/
  // last_error) for every asset doc whose primary fileinfo entry is in the
  // library. The stage controllers pick them up on their next poll cycle.
  .post('/:id/rescan', async ({ params, set }) => {
    const folderIdStr = params.id;
    if (!ObjectId.isValid(folderIdStr)) {
      set.status = 400;
      return { ok: false, error: 'Invalid folderId' };
    }
    const id = new ObjectId(folderIdStr);
    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: id });
    if (!folder) {
      set.status = 404;
      return { ok: false, error: 'Folder not found' };
    }
    const scanRoot = folder.path;

    // Build the $set payload: zero every stage's version and clear
    // dead/attempts/last_error so the claim query picks the docs back up.
    const stageResetFields: Record<string, unknown> = {};
    for (const stage of stageManifest) {
      stageResetFields[`stages.${stage.name}.version`] = 0;
      stageResetFields[`stages.${stage.name}.dead`] = false;
      stageResetFields[`stages.${stage.name}.attempts`] = 0;
      stageResetFields[`stages.${stage.name}.last_error`] = null;
    }

    const assets = await assetsCollection();
    const updateResult = await (assets as unknown as Collection<Document>).updateMany(
      { 'fileinfo.library_id': id },
      { $set: stageResetFields },
    );

    // Re-walk the filesystem so a moved/new file is re-discovered and relinked
    // (handleEvent dedups by maple_id/sha1_head, appends a live fileinfo, and
    // clears deleted_at). Without this the button only zeroed stage versions —
    // it could not recover a file whose only fileinfo was a soft-deleted old
    // path. The walk runs to completion within the request: libraries are
    // bounded and the dedup path is idempotent + concurrency-safe.
    await scanFolderAndDiscover(scanRoot, id, scanRoot);
    const scannedAt = new Date().toISOString();
    await folders.updateOne({ _id: id }, { $set: { last_scan: scannedAt } });

    log.info(
      {
        folderId: folderIdStr,
        path: scanRoot,
        modified: updateResult.modifiedCount,
      },
      'rescan: stage versions zeroed + folder re-walked',
    );

    return {
      ok: true,
      folderId: folderIdStr,
      path: scanRoot,
      reset: updateResult.modifiedCount,
      last_scan: scannedAt,
    };
  })

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
  .post('/:id/scan', async ({ params, set }) => {
    const folderIdStr = params.id;
    if (!ObjectId.isValid(folderIdStr)) {
      set.status = 400;
      return { ok: false, error: 'Invalid folderId' };
    }
    const id = new ObjectId(folderIdStr);
    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: id });
    if (!folder) {
      set.status = 404;
      return { ok: false, error: 'Folder not found' };
    }

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

    await scanFolderAndDiscover(folder.path, id, folder.path);
    const scannedAt = new Date().toISOString();
    await folders.updateOne({ _id: id }, { $set: { last_scan: scannedAt } });

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
  })

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
      let folderId: ObjectId;
      try {
        folderId = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: 'Invalid folder id' };
      }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: folderId });
      if (!folder) {
        set.status = 404;
        return { error: 'Folder not found' };
      }

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
      // Provider can sync everything. Only image files get an `AssetDoc`
      // — the catalog stays image-only. Everything else (video, documents,
      // extensionless files) is stored + synced but never indexed.
      const isMedia = RAW_EXTENSIONS.has(ext) || SHARP_EXTENSIONS.has(ext);

      const absPath = nodePath.join(folder.path, target);

      const dir = nodePath.dirname(absPath);
      await mkdir(dir, { recursive: true });

      // Stream the new body to a tmp file. Streaming keeps RSS bounded
      // regardless of upload size (unlike a buffered `fh.writeFile`
      // over an `ArrayBuffer` body). The atomic rename(tmp, target)
      // happens AFTER any existing file at the target has been moved
      // to trash, so a duplicate upload never destroys the prior copy.
      const assets = await assetsCollection();
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
            // Pre-compute the target fileinfo entry that's about to be
            // overwritten so we can look up the existing row by `(library_id,
            // path, filename)` instead of the retired `abs_path` field.
            const preRelDirRaw = nodePath.dirname(target);
            const preRelDir =
              preRelDirRaw === '.' || preRelDirRaw === ''
                ? ''
                : preRelDirRaw.split(nodePath.sep).join('/');
            const existing = await assets.findOne({
              fileinfo: {
                $elemMatch: { library_id: folderId, path: preRelDir, filename },
              },
              deleted_at: null,
            });
            const moved = await moveToTrash(absPath, folder.path);
            if (moved.kind === 'ok') {
              if (existing) {
                const existingFields = existing as {
                  sha1_head?: string;
                  size?: number;
                };
                // Rewrite the primary fileinfo entry to point at the trash
                // destination so cache resolution + restore can find the row.
                const trashRelDirRaw = nodePath.relative(
                  folder.path,
                  nodePath.dirname(moved.newAbsPath),
                );
                const trashRelDir =
                  trashRelDirRaw === '.' || trashRelDirRaw === ''
                    ? ''
                    : trashRelDirRaw.split(nodePath.sep).join('/');
                const trashFilename = nodePath.basename(moved.newAbsPath);
                await assets.updateOne(
                  { _id: existing._id },
                  {
                    $set: {
                      fileinfo: [
                        {
                          library_id: folderId,
                          path: trashRelDir,
                          filename: trashFilename,
                          deleted_at: null,
                        },
                      ],
                      deleted_at: new Date().toISOString(),
                      original_path: absPath,
                    },
                  },
                );
                // Recompute live count: the fileinfo array was replaced with a
                // single entry (the trashed location). If the old row had 2+
                // live entries the count would otherwise stay stale (#1302).
                await updateLiveLocationCount(assets, existing._id);
                trashed = {
                  docId: existing._id as ObjectId,
                  newAbsPath: moved.newAbsPath,
                  sha1_head: existingFields.sha1_head,
                  size: existingFields.size,
                };
                // Mirror the DELETE route: emit a delete change so consumers
                // (e.g. WorkingSetEnumerator, which removes items only on
                // `.delete`) drop the pre-existing asset. The subsequent
                // `create` for the new bytes still publishes below.
                await recordAndPublishAssetChange({
                  kind: 'delete',
                  asset_id: existing._id as ObjectId,
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

        // Non-media: bytes are stored + synced, but we create no AssetDoc and
        // emit no asset change-feed event. Respond without an `asset_id`.
        if (!isMedia) {
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
              await assets.deleteOne({ _id: trashed.docId });
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
        // fileinfo[0] mirrors the validated target path split into
        // (library-relative directory, filename, library_id). POSIX-normalize
        // `path.sep` → `/` so the stored path obeys the FileInfo docstring
        // contract on every host.
        const relDirRaw = nodePath.dirname(target);
        const relDir =
          relDirRaw === '.' || relDirRaw === '' ? '' : relDirRaw.split(nodePath.sep).join('/');
        const fileinfoEntry = {
          path: relDir,
          filename,
          library_id: folderId,
          deleted_at: null,
        };
        // Upsert by `(library_id, path, filename)` from fileinfo to race-safely
        // cooperate with the discover watcher. If the watcher's chokidar tick
        // observed the just-written file first and already created an asset
        // row, our `$setOnInsert` is a no-op and we update size/mtime over the
        // top. If we win the race, we own the insert.
        let assetID: ObjectId;
        try {
          const updated = await assets.findOneAndUpdate(
            {
              fileinfo: {
                $elemMatch: { library_id: folderId, path: relDir, filename },
              },
            },
            {
              $set: {
                size: st.size,
                mtime: st.mtimeMs,
                indexed_at: nowIso,
                deleted_at: null,
              },
              $setOnInsert: {
                fileinfo: [fileinfoEntry],
                // One live fileinfo entry on insert (#1302). Must be in
                // $setOnInsert (not $set) so an existing-doc update arm
                // never overwrites a count that was already maintained.
                live_location_count: 1,
                rating: 0,
                flag: 0,
                color_label: '',
                exif: null,
                stages: blankStagesSkeleton(),
              },
            },
            { upsert: true, returnDocument: 'after' },
          );
          if (!updated) {
            throw new Error('upsert returned no document');
          }
          assetID = updated._id as ObjectId;
        } catch (err) {
          // Schema validation or anything else: undo the file move so we
          // don't leak an orphan file with no asset doc backing it. The
          // duplicate-key race is already handled by the upsert above.
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
    },
  )

  // Stream the raw bytes of a file addressed by its library-relative path.
  // Used by the File Provider to materialize non-indexed files (which have
  // no AssetDoc, so the `/api/assets/:id/raw` route can't reach them).
  .get('/:id/file', async ({ params, query, set }) => {
    let folderId: ObjectId;
    try {
      folderId = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: 'Invalid folder id' };
    }
    const folder = await (await foldersCollection()).findOne({ _id: folderId });
    if (!folder) {
      set.status = 404;
      return { error: 'Folder not found' };
    }
    const resolved = await resolveFolderRelPath(folder.path, query.path);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(resolved.real);
    } catch {
      set.status = 404;
      return { error: 'file not found' };
    }
    if (!st.isFile()) {
      set.status = 404;
      return { error: 'not a regular file' };
    }
    return new Response(Bun.file(resolved.real).stream(), {
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
  .get('/:id/file-meta', async ({ params, query, set }) => {
    let folderId: ObjectId;
    try {
      folderId = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: 'Invalid folder id' };
    }
    const folder = await (await foldersCollection()).findOne({ _id: folderId });
    if (!folder) {
      set.status = 404;
      return { error: 'Folder not found' };
    }
    const resolved = await resolveFolderRelPath(folder.path, query.path);
    if (!resolved.ok) {
      set.status = resolved.status;
      return { error: resolved.error };
    }
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(resolved.real);
    } catch {
      set.status = 404;
      return { error: 'file not found' };
    }
    if (!st.isFile()) {
      set.status = 404;
      return { error: 'not a regular file' };
    }
    const name = nodePath.basename(resolved.real);
    const dot = name.lastIndexOf('.');
    return {
      name,
      path: resolved.real,
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
  .post('/:id/mkdir', async ({ params, headers, set }) => {
    let folderId: ObjectId;
    try {
      folderId = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: 'Invalid folder id' };
    }

    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: folderId });
    if (!folder) {
      set.status = 404;
      return { error: 'Folder not found' };
    }

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
  })

  // Rename or move a subdirectory within a library root. Source path in
  // `X-Maple-Source-Path`, destination path in `X-Maple-Target-Path`
  // (both URL-encoded, relative to the library root, same validation as
  // `/mkdir`). The whole directory is renamed on disk — paired sidecars
  // and the `.maple/` thumb cache ride along because they live inside
  // it. The DB's `fileinfo` paths are reconciled by the discover watcher
  // (it coalesces the per-file unlink+add into renames), so this route
  // does not touch MongoDB.
  //
  // The File Provider extension calls this when the user renames or
  // moves a folder in Finder (`modifyItem` with `.filename` and/or
  // `.parentItemIdentifier`). Without it, folder rename returned
  // featureUnsupported and Finder surfaced an error while leaving the
  // freshly-created "untitled folder" stranded on the server.
  .post('/:id/move', async ({ params, headers, set }) => {
    let folderId: ObjectId;
    try {
      folderId = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: 'Invalid folder id' };
    }

    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: folderId });
    if (!folder) {
      set.status = 404;
      return { error: 'Folder not found' };
    }

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
  })

  // Paged list of trashed assets for one library, newest-first.
  // Cursor format: "<deleted_at_iso>|<hex_id>" — page where
  // deleted_at < iso, OR (deleted_at == iso AND _id < hex_id).
  // Filters require both deleted_at and original_path so vanished
  // (watcher-removed) assets stay out of Trash.
  .get(
    '/:id/trash',
    async ({ params, query, set }) => {
      let folderId: ObjectId;
      try {
        folderId = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: 'Invalid folder id' };
      }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: folderId });
      if (!folder) {
        set.status = 404;
        return { error: 'Folder not found' };
      }

      // Parse + validate `limit`. `Number("abc")` is `NaN`, which
      // `Math.min/max` preserve; passing `NaN` to MongoDB `.limit()`
      // throws a 500. Reject non-numeric / out-of-range values with 400
      // and clamp valid values into [1, 500].
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
      const filter = buildTrashListFilter(folderId, cursor);

      const assets = await assetsCollection();
      const docs = await assets
        .find(filter)
        .sort({ deleted_at: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const last = pageDocs[pageDocs.length - 1];
      const nextCursor =
        hasMore && last
          ? `${(last as unknown as { deleted_at: string }).deleted_at}|${last._id.toHexString()}`
          : null;

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
      }> = [];
      for (const d of pageDocs) {
        const doc = d as unknown as AssetWithId & {
          mtime: number | string;
          deleted_at: string;
          original_path: string;
        };
        const primary = (doc.fileinfo ?? []).find((e) => !e.deleted_at) ?? doc.fileinfo?.[0];
        if (!primary) continue;
        const orig = doc.original_path;
        const originalRel = orig.startsWith(rootPrefix) ? orig.slice(rootPrefix.length) : orig;
        const absPath = assetAbsPath(doc, libs);
        if (!absPath) continue;
        const trashRel = absPath.startsWith(rootPrefix)
          ? absPath.slice(rootPrefix.length)
          : absPath;
        // `doc.mtime` is stored as `fs.stat().mtimeMs` (a number) by the
        // discover watcher, but may legacy-back as an ISO string from
        // earlier rows. Always emit ISO-8601 over the wire so the Swift
        // `Date` decoder works regardless.
        const mtimeIso =
          typeof doc.mtime === 'number' ? new Date(doc.mtime).toISOString() : doc.mtime;
        items.push({
          asset_id: doc._id.toHexString(),
          filename: primary.filename,
          original_relative_path: originalRel,
          trash_relative_path: trashRel,
          size: doc.size,
          mtime: mtimeIso,
          deleted_at: doc.deleted_at,
        });
      }
      return {
        items,
        next_cursor: nextCursor,
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    },
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the Mongo filter for `GET /api/folders/:id/trash`.
 *
 * Issue #83: the route must include `{ deleted_at: { $type: "string" } }`
 * in the predicate so the planner can prove the `deleted_at_1` partial
 * index (built with `partialFilterExpression: { deleted_at: { $type: "string" } }`)
 * subsumes the query and pick IXSCAN over a per-folder COLLSCAN.
 *
 * Without `$type: "string"` the planner falls back to scanning the
 * `folder_id` keys and filter-after-fetching — 1000s of docsExamined for
 * a 5-row response.
 *
 * Exported for explain() tests in `folders.trash-list.test.ts`.
 */
export function buildTrashListFilter(
  folderId: ObjectId,
  cursor: string | null,
): Record<string, unknown> {
  // Base trash predicate: `$type: "string"` is the load-bearing bit (see
  // doc comment above). Implies `$ne: null` for free but we keep the
  // explicit clause for legacy rows that may have been written with
  // odd shapes.
  const trashPredicate = {
    deleted_at: { $type: 'string' as const, $ne: null },
    original_path: { $ne: null },
  };

  const filter: Record<string, unknown> = {
    'fileinfo.library_id': folderId,
    ...trashPredicate,
  };

  if (!cursor) return filter;
  const sepIdx = cursor.lastIndexOf('|');
  if (sepIdx <= 0) return filter;
  const iso = cursor.slice(0, sepIdx);
  const hex = cursor.slice(sepIdx + 1);
  let cursorId: ObjectId;
  try {
    cursorId = new ObjectId(hex);
  } catch {
    return filter; /* malformed cursor → no cursor */
  }

  // Combine the trash predicate with the cursor's tuple comparison.
  // `$type: "string"` MUST appear inside the $and clause too — the
  // planner unions the index-eligibility analysis across both sides of
  // an $and, so dropping it on the cursor branch reintroduces the bug.
  return {
    'fileinfo.library_id': folderId,
    $and: [
      trashPredicate,
      {
        $or: [
          { deleted_at: { $type: 'string' as const, $lt: iso } },
          {
            deleted_at: { $type: 'string' as const, $eq: iso },
            _id: { $lt: cursorId },
          },
        ],
      },
    ],
  };
}

/** Supported image extensions (lowercase with leading dot). */
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
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
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
