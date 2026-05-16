/**
 * /api/folders routes.
 *
 * GET  /api/folders         — list all registered folders
 * POST /api/folders         — register a new folder (triggers scan)
 * GET  /api/folders/:id/assets — paged asset list for a folder
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { readdir, open, rename, stat, unlink, mkdir, utimes } from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { foldersCollection, assetsCollection } from "../db/client.ts";
import { validateRoot } from "../fs/root.ts";
import { RAW_EXTENSIONS } from "../fs/browse.ts";
import { SHARP_EXTENSIONS } from "../thumbs/render.ts";
import { child as childLogger } from "../log.ts";
import { computeBodyETag, ifNoneMatchEqual } from "../runtime/http-etag.ts";
import { handleEvent } from "../workers/discover/index.ts";
import { stageManifest, blankStagesSkeleton } from "../workers/stages/manifest.ts";

const log = childLogger("folders");

export const foldersRoutes = new Elysia({ prefix: "/api/folders" })
  // List all folders. Body-hash ETag + If-None-Match short-circuit so the
  // File Provider extension can revalidate cheaply on cold Finder open.
  .get("/", async ({ headers }) => {
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
    const ifNoneMatch = headers["if-none-match"];
    if (
      ifNoneMatchEqual(
        typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
        etag,
      )
    ) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(body, {
      status: 200,
      headers: { ETag: etag, "Content-Type": "application/json" },
    });
  })

  // Register a new folder
  .post(
    "/",
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
        return { error: "Folder already registered", id: existing._id.toHexString() };
      }

      const now = new Date().toISOString();
      const doc = {
        path,
        label: label ?? path.split("/").filter(Boolean).pop() ?? path,
        last_scan: null as string | null,
        file_count: 0,
        created_at: now,
      };

      const result = await coll.insertOne(doc);
      const id = result.insertedId.toHexString();
      const folderId = result.insertedId;

      // Fire-and-forget: walk the new folder and push each supported image
      // file through the discover producer so the pipeline starts indexing
      // immediately without waiting for the next watcher tick.
      void scanFolderAndDiscover(path, folderId).catch((err) =>
        log.warn(
          { path, err: err instanceof Error ? err.message : err },
          "initial folder scan failed — files will be indexed on next watcher tick",
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
    }
  )

  // Paged asset list for a folder
  .get(
    "/:id/assets",
    async ({ params, query, set }) => {
      let folderId: ObjectId;
      try {
        folderId = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: "Invalid folder id" };
      }

      const page = Math.max(1, Number(query.page ?? 1));
      const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
      const skip = (page - 1) * limit;

      const coll = await assetsCollection();
      const [docs, total] = await Promise.all([
        coll
          .find({ folder_id: folderId })
          .sort({ filename: 1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
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
    }
  )

  // Rescan a folder — resets stages.*.version to 0 (and clears dead/attempts/
  // last_error) for every asset doc whose abs_path is under the folder's path
  // tree. The stage controllers pick them up on their next poll cycle.
  .post(
    "/:id/rescan",
    async ({ params, set }) => {
      const folderIdStr = params.id;
      if (!ObjectId.isValid(folderIdStr)) {
        set.status = 400;
        return { ok: false, error: "Invalid folderId" };
      }
      const id = new ObjectId(folderIdStr);
      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: id });
      if (!folder) {
        set.status = 404;
        return { ok: false, error: "Folder not found" };
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
      const escapedRoot = scanRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const assets = await assetsCollection();
      const updateResult = await (assets as import("mongodb").Collection<import("mongodb").Document>).updateMany(
        { abs_path: { $regex: `^${escapedRoot}/` } },
        { $set: stageResetFields },
      );

      log.info(
        { folderId: folderIdStr, path: scanRoot, modified: updateResult.modifiedCount },
        "rescan: stage versions zeroed",
      );

      return { ok: true, folderId: folderIdStr, path: scanRoot, reset: updateResult.modifiedCount };
    },
  )

  // Streaming upload: body is raw file bytes, target path in X-Maple-Target-Path.
  .post(
    "/:id/upload",
    async ({ params, body, headers, set }) => {
      let folderId: ObjectId;
      try { folderId = new ObjectId(params.id); }
      catch { set.status = 400; return { error: "Invalid folder id" }; }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: folderId });
      if (!folder) { set.status = 404; return { error: "Folder not found" }; }

      const targetHeader = headers["x-maple-target-path"];
      if (typeof targetHeader !== "string" || targetHeader.length === 0) {
        set.status = 400; return { error: "Missing X-Maple-Target-Path" };
      }
      const target = decodeURIComponent(targetHeader);
      // Path validation: no leading /, no .. component, no leading-dot component
      // (the latter would let a caller write into .maple/).
      if (target.startsWith("/")) { set.status = 400; return { error: "Path must be relative" }; }
      const parts = target.split("/").filter((p) => p.length > 0);
      if (parts.length === 0) { set.status = 400; return { error: "Empty target path" }; }
      for (const part of parts) {
        if (part === ".." || part === ".") { set.status = 400; return { error: "Path traversal not allowed" }; }
        if (part.startsWith(".")) { set.status = 400; return { error: "Hidden path components not allowed" }; }
      }
      const filename = parts[parts.length - 1]!;
      const dot = filename.lastIndexOf(".");
      const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
      const allowed = RAW_EXTENSIONS.has(ext) || SHARP_EXTENSIONS.has(ext);
      if (!allowed) {
        set.status = 415;
        return { error: `Unsupported file extension: "${ext}"` };
      }

      const absPath = nodePath.join(folder.path, target);
      // Refuse overwrite of an existing file.
      try {
        await stat(absPath);
        set.status = 409;
        return { error: "file exists", abs_path: absPath };
      } catch { /* free */ }

      // Body comes in as an ArrayBuffer when `type: "arrayBuffer"` is set.
      const bytes = body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : body instanceof Uint8Array
          ? body
          : typeof body === "string"
            ? new TextEncoder().encode(body)
            : new Uint8Array();

      const dir = nodePath.dirname(absPath);
      await mkdir(dir, { recursive: true });
      const tmp = nodePath.join(dir, `.upload-${randomUUID()}`);
      try {
        const fh = await open(tmp, "w");
        try {
          await fh.writeFile(bytes);
          await fh.datasync();
        } finally {
          await fh.close();
        }
        await rename(tmp, absPath);
      } catch (err) {
        try { await unlink(tmp); } catch {}
        set.status = 500;
        return { error: `Upload write failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const st = await stat(absPath);
      const mtimeHeader = headers["x-maple-file-mtime"];
      if (typeof mtimeHeader === "string" && /^\d+$/.test(mtimeHeader)) {
        const epoch = parseInt(mtimeHeader, 10);
        try { await utimes(absPath, epoch, epoch); } catch {}
      }

      const assets = await assetsCollection();
      const _id = new ObjectId();
      const nowIso = new Date().toISOString();
      await assets.insertOne({
        _id,
        folder_id: folderId,
        filename,
        abs_path: absPath,
        size: st.size,
        mtime: st.mtimeMs,
        rating: 0,
        flag: 0,
        color_label: "",
        exif: null,
        indexed_at: nowIso,
        deleted_at: null,
        stages: blankStagesSkeleton(),
      } as never);

      set.status = 201;
      return { asset_id: _id.toHexString(), abs_path: absPath, size: st.size, mtime: st.mtimeMs };
    },
    {
      type: "arrayBuffer",
    }
  )

  // Paged list of trashed assets for one library, newest-first.
  // Cursor format: "<deleted_at_iso>|<hex_id>" — page where
  // deleted_at < iso, OR (deleted_at == iso AND _id < hex_id).
  // Filters require both deleted_at and original_path so vanished
  // (watcher-removed) assets stay out of Trash.
  .get(
    "/:id/trash",
    async ({ params, query, set }) => {
      let folderId: ObjectId;
      try { folderId = new ObjectId(params.id); }
      catch { set.status = 400; return { error: "Invalid folder id" }; }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: folderId });
      if (!folder) { set.status = 404; return { error: "Folder not found" }; }

      const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
      const filter: Record<string, unknown> = {
        folder_id: folderId,
        deleted_at: { $ne: null },
        original_path: { $ne: null },
      };
      const cursor = typeof query.cursor === "string" && query.cursor.length > 0
        ? query.cursor
        : null;
      if (cursor) {
        const sepIdx = cursor.lastIndexOf("|");
        if (sepIdx > 0) {
          const iso = cursor.slice(0, sepIdx);
          const hex = cursor.slice(sepIdx + 1);
          try {
            // Override the simple { $ne: null } filter on deleted_at by
            // combining the cursor predicate with the non-null guard.
            filter.$and = [
              { deleted_at: { $ne: null }, original_path: { $ne: null } },
              { $or: [
                  { deleted_at: { $lt: iso } },
                  { deleted_at: iso, _id: { $lt: new ObjectId(hex) } },
                ] },
            ];
            delete filter.deleted_at;
            delete filter.original_path;
          } catch { /* malformed cursor → ignore */ }
        }
      }

      const assets = await assetsCollection();
      const docs = await assets
        .find(filter)
        .sort({ deleted_at: -1, _id: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = docs.length > limit;
      const pageDocs = hasMore ? docs.slice(0, limit) : docs;
      const last = pageDocs[pageDocs.length - 1];
      const nextCursor = hasMore && last
        ? `${(last as unknown as { deleted_at: string }).deleted_at}|${last._id.toHexString()}`
        : null;

      const rootPrefix = folder.path.endsWith("/") ? folder.path : folder.path + "/";
      return {
        items: pageDocs.map((d) => {
          const doc = d as unknown as { _id: ObjectId; filename: string; abs_path: string; size: number; mtime: number; deleted_at: string; original_path: string };
          const orig = doc.original_path;
          const originalRel = orig.startsWith(rootPrefix) ? orig.slice(rootPrefix.length) : orig;
          const trashRel = doc.abs_path.startsWith(rootPrefix) ? doc.abs_path.slice(rootPrefix.length) : doc.abs_path;
          return {
            asset_id: doc._id.toHexString(),
            filename: doc.filename,
            original_relative_path: originalRel,
            trash_relative_path: trashRel,
            size: doc.size,
            mtime: doc.mtime,
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
    }
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Supported image extensions (lowercase with leading dot). */
const SUPPORTED_EXTS = new Set([
  ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2",
  ".pef", ".srw", ".x3f", ".3fr", ".mef", ".erf", ".mrw",
  ".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif",
]);

/**
 * Bounded async dispatcher — runs at most `limit` concurrent invocations of
 * `run` across all `items`. Errors from individual items are swallowed (callers
 * log before throwing or after the pool drains).
 */
async function dispatchPool<T>(items: T[], limit: number, run: (i: T) => Promise<void>): Promise<void> {
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
async function scanFolderAndDiscover(rootPath: string, folderId: ObjectId): Promise<void> {
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
          if (entryName.startsWith(".")) continue;
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
      await handleEvent({ kind: "created", absPath }, folderId).catch((err) =>
        log.warn(
          { absPath, err: err instanceof Error ? err.message : err },
          "discover upsert failed during initial folder scan",
        ),
      );
    });
  }
}
