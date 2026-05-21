/**
 * /api/folders routes.
 *
 * GET  /api/folders         — list all registered folders
 * POST /api/folders         — register a new folder (triggers scan)
 * GET  /api/folders/:id/assets — paged asset list for a folder
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { readdir, open, rename, stat, unlink, mkdir, utimes } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha1 } from '@noble/hashes/legacy.js';
import { foldersCollection, assetsCollection } from '../db/client.ts';
import { recordAndPublishAssetChange } from '../db/changes.repo.ts';
import { validateRoot } from '../fs/root.ts';
import { RAW_EXTENSIONS } from '../fs/browse.ts';
import { SHARP_EXTENSIONS } from '../thumbs/render.ts';
import { moveToTrash } from '../fs/trash.ts';
import { listPairedSidecars } from '../fs/xmp.ts';
import { child as childLogger } from '../log.ts';
import { computeBodyETag, ifNoneMatchEqual } from '../runtime/http-etag.ts';
import { handleEvent } from '../workers/discover/index.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
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

/**
 * Decode + validate the `X-Maple-Target-Path` header shared by
 * `/upload` and `/mkdir`. Returns a discriminated result — callers
 * set `set.status` to the embedded status on failure and return the
 * embedded body. Validation rules:
 *   - header must be present and non-empty
 *   - percent-decoding must not throw (no `%ZZ`)
 *   - path must be relative (no leading `/`)
 *   - no empty paths after splitting on `/`
 *   - no `..` or `.` components
 *   - no leading-dot components (blocks writes into `.maple/`)
 */
function decodeAndValidateTargetPath(
  headers: Record<string, string | undefined>,
): { ok: true; target: string; parts: string[] } | { ok: false; status: number; error: string } {
  const raw = headers['x-maple-target-path'];
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, status: 400, error: 'Missing X-Maple-Target-Path' };
  }
  let target: string;
  try {
    target = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 400, error: 'Invalid X-Maple-Target-Path encoding' };
  }
  if (target.startsWith('/')) {
    return { ok: false, status: 400, error: 'Path must be relative' };
  }
  const parts = target.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { ok: false, status: 400, error: 'Empty target path' };
  }
  for (const part of parts) {
    if (part === '..' || part === '.') {
      return { ok: false, status: 400, error: 'Path traversal not allowed' };
    }
    if (part.startsWith('.')) {
      return { ok: false, status: 400, error: 'Hidden path components not allowed' };
    }
  }
  return { ok: true, target, parts };
}

export const foldersRoutes = new Elysia({ prefix: '/api/folders' })
  // List all folders. Body-hash ETag + If-None-Match short-circuit so the
  // File Provider extension can revalidate cheaply on cold Finder open.
  .get('/', async ({ headers }) => {
    const coll = await foldersCollection();
    const docs = await coll.find({}).sort({ created_at: 1 }).toArray();
    const payload = docs.map((d) => ({
      id: d._id.toHexString(),
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
        return { error: 'Folder already registered', id: existing._id.toHexString() };
      }

      const now = new Date().toISOString();
      const doc = {
        path,
        label: label ?? path.split('/').filter(Boolean).pop() ?? path,
        last_scan: null as string | null,
        file_count: 0,
        created_at: now,
      };

      const result = await coll.insertOne(doc);
      const id = result.insertedId.toHexString();
      const folderId = result.insertedId;

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
        path: doc.path,
        label: doc.label,
        last_scan: doc.last_scan,
        file_count: doc.file_count,
        created_at: doc.created_at,
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
      const [docs, total] = await Promise.all([
        coll.find({ folder_id: folderId }).sort({ filename: 1 }).skip(skip).limit(limit).toArray(),
        coll.countDocuments({ folder_id: folderId }),
      ]);

      return {
        folder_id: params.id,
        page,
        limit,
        total,
        assets: docs.map((d) => ({
          id: d._id.toHexString(),
          filename: d.filename,
          size: d.size,
          mtime: d.mtime,
          rating: d.rating,
          flag: d.flag,
          color_label: d.color_label,
          indexed_at: d.indexed_at,
        })),
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
  // last_error) for every asset doc whose abs_path is under the folder's path
  // tree. The stage controllers pick them up on their next poll cycle.
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

    // Escape special regex chars in the path before embedding it.
    const escapedRoot = scanRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const assets = await assetsCollection();
    const updateResult = await (
      assets as import('mongodb').Collection<import('mongodb').Document>
    ).updateMany({ abs_path: { $regex: `^${escapedRoot}/` } }, { $set: stageResetFields });

    log.info(
      { folderId: folderIdStr, path: scanRoot, modified: updateResult.modifiedCount },
      'rescan: stage versions zeroed',
    );

    return { ok: true, folderId: folderIdStr, path: scanRoot, reset: updateResult.modifiedCount };
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
      const allowed = RAW_EXTENSIONS.has(ext) || SHARP_EXTENSIONS.has(ext);
      if (!allowed) {
        set.status = 415;
        return { error: `Unsupported file extension: "${ext}"` };
      }

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
      type Trashed = { docId: ObjectId; newAbsPath: string; sha1_head?: string; size?: number };
      let trashed: Trashed | undefined;
      try {
        await stat(absPath);
        const existing = await assets.findOne({ abs_path: absPath, deleted_at: null });
        const moved = await moveToTrash(absPath, folder.path);
        if (moved.kind === 'ok') {
          if (existing) {
            const existingFields = existing as { sha1_head?: string; size?: number };
            await assets.updateOne(
              { _id: existing._id },
              {
                $set: {
                  abs_path: moved.newAbsPath,
                  deleted_at: new Date().toISOString(),
                  original_path: absPath,
                },
              },
            );
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
            { absPath, err: err instanceof Error ? err.message : String(err) },
            'duplicate-upload identical-content check failed — leaving trash entry in place',
          );
        }
      }

      const nowIso = new Date().toISOString();
      // fileinfo[0] mirrors the validated target path split into
      // (library-relative directory, filename, library_id). Computed
      // here so we can include it in `$setOnInsert` alongside the
      // legacy abs_path / filename / folder_id triple. POSIX-normalize
      // `path.sep` → `/` so the stored path obeys the FileInfo
      // docstring contract on every host.
      const relDirRaw = nodePath.dirname(target);
      const relDir =
        relDirRaw === '.' || relDirRaw === '' ? '' : relDirRaw.split(nodePath.sep).join('/');
      const fileinfoEntry = {
        path: relDir,
        filename,
        library_id: folderId,
      };
      // Upsert by `abs_path` to race-safely cooperate with the discover
      // watcher. If the watcher's chokidar tick observed the just-
      // written file first and already created an asset row, our
      // `$setOnInsert` is a no-op and we update size/mtime over the
      // top. If we win the race, we own the insert. Either way the
      // route returns the doc's real `_id` from the operation result;
      // the prior `insertOne` with a pre-generated `_id` would have
      // failed with a duplicate-key error in the loser case, leaving
      // an orphan file under the user's intended path even though the
      // upload had succeeded.
      let assetID: ObjectId;
      try {
        const updated = await assets.findOneAndUpdate(
          { abs_path: absPath },
          {
            $set: {
              size: st.size,
              mtime: st.mtimeMs,
              indexed_at: nowIso,
              deleted_at: null,
            },
            $setOnInsert: {
              folder_id: folderId,
              filename,
              abs_path: absPath,
              fileinfo: [fileinfoEntry],
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
    },
    {
      // Skip Elysia body parsing — the handler consumes `request.body`
      // as a ReadableStream directly so it can stream to disk without
      // buffering. With no `type:` / `parse:` set, Elysia leaves the
      // body untouched.
      parse: 'none',
    },
  )

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
      return { error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    set.status = 201;
    return { abs_path: absPath };
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
      return {
        items: pageDocs.map((d) => {
          const doc = d as unknown as {
            _id: ObjectId;
            filename: string;
            abs_path: string;
            size: number;
            mtime: number | string;
            deleted_at: string;
            original_path: string;
          };
          const orig = doc.original_path;
          const originalRel = orig.startsWith(rootPrefix) ? orig.slice(rootPrefix.length) : orig;
          const trashRel = doc.abs_path.startsWith(rootPrefix)
            ? doc.abs_path.slice(rootPrefix.length)
            : doc.abs_path;
          // `doc.mtime` is stored as `fs.stat().mtimeMs` (a number) by
          // the discover watcher, but may legacy-back as an ISO string
          // from earlier rows. Always emit ISO-8601 over the wire so the
          // Swift `Date` decoder works regardless.
          const mtimeIso =
            typeof doc.mtime === 'number' ? new Date(doc.mtime).toISOString() : doc.mtime;
          return {
            asset_id: doc._id.toHexString(),
            filename: doc.filename,
            original_relative_path: originalRel,
            trash_relative_path: trashRel,
            size: doc.size,
            mtime: mtimeIso,
            deleted_at: doc.deleted_at,
          };
        }),
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
    folder_id: folderId,
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
    folder_id: folderId,
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
          entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
        } catch {
          return; // permission denied or not a directory
        }
        for (const entry of entries) {
          const entryName = entry.name as unknown as string;
          if (entryName.startsWith('.')) continue;
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
