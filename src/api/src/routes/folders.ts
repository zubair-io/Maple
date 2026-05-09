/**
 * /api/folders routes.
 *
 * GET  /api/folders         — list all registered folders
 * POST /api/folders         — register a new folder (triggers scan)
 * GET  /api/folders/:id/assets — paged asset list for a folder
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { readdir, stat } from "node:fs/promises";
import * as nodePath from "node:path";
import { foldersCollection, assetsCollection } from "../db/client.ts";
import { validateRoot } from "../fs/root.ts";
import { child as childLogger } from "../log.ts";
import { handleEvent } from "../workers/discover/index.ts";

const log = childLogger("folders");

export const foldersRoutes = new Elysia({ prefix: "/api/folders" })
  // List all folders
  .get("/", async () => {
    const coll = await foldersCollection();
    const docs = await coll.find({}).sort({ created_at: 1 }).toArray();
    return docs.map((d) => ({
      id: d._id.toHexString(),
      path: d.path,
      label: d.label,
      last_scan: d.last_scan,
      file_count: d.file_count,
      created_at: d.created_at,
    }));
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
 * Recursively walk `dirPath` and call `handleEvent({ kind: "created" })` for
 * every supported image file found. Fire-and-forget per file — a single
 * failed upsert does not abort the rest of the walk. Silently skips
 * permission-denied subtrees.
 */
async function scanFolderAndDiscover(dirPath: string, folderId: ObjectId): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dirPath);
  } catch {
    return; // permission denied or not a directory
  }

  await Promise.all(
    names.map(async (name) => {
      const absPath = nodePath.join(dirPath, name);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(absPath);
      } catch {
        return;
      }

      if (st.isDirectory()) {
        await scanFolderAndDiscover(absPath, folderId);
      } else if (st.isFile()) {
        const ext = nodePath.extname(name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) return;
        handleEvent({ kind: "created", absPath }, folderId).catch((err) =>
          log.warn(
            { absPath, err: err instanceof Error ? err.message : err },
            "discover upsert failed during initial folder scan",
          ),
        );
      }
    }),
  );
}
