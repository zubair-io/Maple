/**
 * /api/assets trash + restore (Phase 3).
 *
 *   DELETE /api/assets/:id           — dual-mode:
 *       • deleted_at == null → soft-delete (move RAW + sidecars to
 *         .maple/trash/<rel>, set deleted_at + original_path), 204.
 *       • deleted_at != null → permanent purge (unlink files, delete
 *         asset doc), 204. This is the "user emptied this single item
 *         from Trash" signal from the File Provider extension.
 *   POST   /api/assets/:id/restore   — move file out of trash and clear
 *                                      deleted_at; returns the restored
 *                                      filename / size / mtime so the
 *                                      File Provider client can rebuild
 *                                      its metadata without statting
 *                                      the server's abs_path.
 *
 * The Phase-2 DELETE /:id/xmp route handles sidecar-only deletes via
 * the xmpRoutes plugin; this one is asset-level.
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import * as path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { assetsCollection, foldersCollection } from "../../db/client.ts";
import { listPairedSidecars } from "../../fs/xmp.ts";
import { moveToTrash, moveOutOfTrash } from "../../fs/trash.ts";
import { type Place } from "../../db/schema.ts";
import { composeSearchBlob } from "../../enrichment/search-blob.ts";
import { recordAndPublishAssetChange } from "../../db/changes.repo.ts";
import { meilisearchClient } from "../../enrichment/meilisearch-client.ts";
import { assetsLog } from "./_shared.ts";

export const trashRoutes = new Elysia()
  .delete("/:id", async ({ params, set }) => {
    let id: ObjectId;
    try { id = new ObjectId(params.id); }
    catch { set.status = 400; return { error: "Invalid asset id" }; }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) { set.status = 404; return { error: "Asset not found" }; }

    // Already trashed → permanent purge.
    const docAny = doc as unknown as Record<string, unknown>;
    if (docAny.deleted_at) {
      const absPath = doc.abs_path;
      try { await unlink(absPath); } catch { /* file may already be gone */ }
      const sidecars = await listPairedSidecars(absPath);
      for (const sidecar of sidecars) {
        try { await unlink(sidecar); } catch {}
      }
      await coll.deleteOne({ _id: id });
      // The doc was already tombstoned in Meilisearch by the prior
      // soft-delete (`tombstone` sets `deletedAt`, which the search filter
      // excludes). Meilisearch has no per-asset delete-document path here
      // — the tombstone is sufficient and the row is GC'd by the
      // next bulk backfill / index rebuild.
      set.status = 204;
      // Emit a delete change so the File Provider extension drops this
      // item from its working set on the next pull.
      await recordAndPublishAssetChange({
        kind: "delete",
        asset_id: id,
        folder_id: doc.folder_id,
        abs_path: absPath,
      }).catch(() => {});
      return;
    }

    // Locate the owning folder root.
    const folders = await foldersCollection();
    const folder = await folders.findOne({ _id: doc.folder_id });
    if (!folder) {
      set.status = 500;
      return { error: "Asset's folder is missing — refusing to trash" };
    }

    const result = await moveToTrash(doc.abs_path, folder.path);
    if (result.kind !== "ok") {
      set.status = 500;
      return { error: result.error };
    }

    const originalAbsPath = doc.abs_path;
    await coll.updateOne(
      { _id: id },
      { $set: {
          abs_path: result.newAbsPath,
          deleted_at: new Date().toISOString(),
          original_path: originalAbsPath,
        } },
    );

    // Best-effort Meilisearch tombstone — mirrors the indexer's
    // `softDelete()` pattern (src/api/src/indexer/images.repo.ts). The
    // search route's `deletedAt IS NULL` filter excludes the row from
    // results. Mongo is canonical; a Meilisearch failure here must NOT
    // roll back the soft-delete or change the 204 response.
    const mapleIdForTombstone = (docAny as { maple_id?: unknown }).maple_id;
    if (typeof mapleIdForTombstone === "string" && mapleIdForTombstone.length > 0) {
      try {
        await meilisearchClient().tombstone(mapleIdForTombstone);
      } catch (err) {
        assetsLog.warn(
          { assetId: id.toHexString(), mapleId: mapleIdForTombstone, err: err instanceof Error ? err.message : String(err) },
          "meilisearch tombstone on trash failed — Mongo is canonical, search will exclude via deleted_at filter",
        );
      }
    }
    set.status = 204;
    // Emit a delete change keyed on the path the OS / File Provider knows
    // about (the pre-trash location). The asset row stays for restore.
    await recordAndPublishAssetChange({
      kind: "delete",
      asset_id: id,
      folder_id: doc.folder_id,
      abs_path: originalAbsPath,
    }).catch(() => {});
    return;
  })

  .post(
    "/:id/restore",
    async ({ params, body, set }) => {
      let id: ObjectId;
      try { id = new ObjectId(params.id); }
      catch { set.status = 400; return { error: "Invalid asset id" }; }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) { set.status = 404; return { error: "Asset not found" }; }
      const docAny = doc as unknown as Record<string, unknown>;
      if (!docAny.deleted_at) { set.status = 409; return { error: "Asset is not trashed" }; }

      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: doc.folder_id });
      if (!folder) { set.status = 500; return { error: "Asset's folder is missing" }; }

      // Cross-library restore guard. Phase 3 only restores into the
      // SAME library the asset belongs to; dragging from Library A's
      // Trash into Library B is out of scope and currently UNDEFINED
      // — the server moves the file using the ORIGINAL folder root, so
      // an unguarded request would silently restore into the wrong
      // place. The File Provider client sends the new parent's
      // folder_id; reject the request if it doesn't match.
      const targetFolderID = (body as { target_folder_id?: string } | null)?.target_folder_id;
      if (typeof targetFolderID === "string" && targetFolderID.length > 0) {
        if (targetFolderID !== doc.folder_id.toHexString()) {
          set.status = 400;
          return {
            error: "Cross-library restore is not supported",
            asset_folder_id: doc.folder_id.toHexString(),
            target_folder_id: targetFolderID,
          };
        }
      }

      const targetRel = (body as { target_relative_path?: string } | null)?.target_relative_path;
      let targetAbs: string;
      if (typeof targetRel === "string" && targetRel.length > 0) {
        if (targetRel.startsWith("/")) { set.status = 400; return { error: "Target must be relative" }; }
        const parts = targetRel.split("/").filter((p) => p.length > 0);
        for (const part of parts) {
          if (part === ".." || part === ".") { set.status = 400; return { error: "Path traversal not allowed" }; }
          if (part.startsWith(".")) { set.status = 400; return { error: "Hidden path components not allowed" }; }
        }
        targetAbs = path.join(folder.path, targetRel);
      } else {
        const orig = docAny.original_path;
        if (typeof orig !== "string" || orig.length === 0) {
          set.status = 500;
          return { error: "Asset has no original_path; supply target_relative_path" };
        }
        targetAbs = orig;
      }

      const result = await moveOutOfTrash(doc.abs_path, targetAbs);
      if (result.kind !== "ok") {
        set.status = 500;
        return { error: result.error };
      }
      // Re-stat the restored file: `moveOutOfTrash` may have appended a
      // `.restored[.N]` suffix on collision, so the doc's `filename`,
      // `size`, and `mtime` must be refreshed to match the new on-disk
      // state. Without this update the `{folder_id, filename}` unique
      // index would still reserve the OLD filename, blocking re-upload
      // with the same basename even though the file is at a new path.
      const restoredFilename = path.basename(result.newAbsPath);
      let restoredSize = doc.size;
      // `AssetDoc.mtime` is epoch-ms (number) per db/schema.ts. Persisting an
      // ISO string here breaks the assets-list serialiser which does
      // `Math.floor(r.mtime / 1000)` to hand seconds to the Swift client —
      // a string would yield NaN, and the Swift consumer would see `null`.
      let restoredMtime = Date.now();
      try {
        const st = await stat(result.newAbsPath);
        restoredSize = st.size;
        restoredMtime = st.mtimeMs;
      } catch (err) {
        assetsLog.warn(
          { absPath: result.newAbsPath, err: err instanceof Error ? err.message : String(err) },
          "restore: stat of new path failed — using prior doc values",
        );
      }
      // Watcher race: between `moveOutOfTrash` and our update, the
      // discover watcher may have observed the file at its new path
      // and upserted a *new* asset row keyed on `abs_path`. That row
      // reserves the `{folder_id, filename}` unique slot, so the
      // updateOne below would collide. Delete the watcher's transient
      // row (any doc at the new abs_path that isn't our `_id`) before
      // updating. The watcher's row carries no enrichment / no maple_id
      // — it's safe to drop in favour of the asset we're restoring.
      await coll.deleteOne({
        abs_path: result.newAbsPath,
        _id: { $ne: id },
      });
      await coll.updateOne(
        { _id: id },
        { $set: {
            abs_path: result.newAbsPath,
            filename: restoredFilename,
            size: restoredSize,
            mtime: restoredMtime,
            deleted_at: null,
            original_path: null,
          } },
      );

      // Best-effort Meilisearch re-index — symmetric with the tombstone
      // on DELETE. Resurrects the row by upserting with `deletedAt: null`
      // so the search filter `deletedAt IS NULL` picks it up again. The
      // text payload comes from whatever enrichment fields are present;
      // missing enrichment (rows that never finished the meili stage)
      // just upserts an empty `searchBlob` — the meili stage will
      // backfill content on its next pass.
      const mapleIdForRestore = (docAny as { maple_id?: unknown }).maple_id;
      if (typeof mapleIdForRestore === "string" && mapleIdForRestore.length > 0) {
        const placeForBlob = (docAny.place ?? null) as Place | null;
        const description = typeof docAny.description === "string" ? docAny.description : null;
        const ocrText = typeof docAny.ocr_text === "string" ? docAny.ocr_text : null;
        const exif = docAny.exif as { captured_at?: string | null } | null | undefined;
        try {
          await meilisearchClient().upsert({
            id: mapleIdForRestore,
            searchBlob: composeSearchBlob({ place: placeForBlob, description, ocrText }),
            description,
            ocrText,
            folderId: doc.folder_id.toHexString(),
            capturedAt: exif?.captured_at ?? null,
            deletedAt: null,
          });
        } catch (err) {
          assetsLog.warn(
            { assetId: id.toHexString(), mapleId: mapleIdForRestore, err: err instanceof Error ? err.message : String(err) },
            "meilisearch re-index on restore failed — Mongo restored OK, search will lag until next meili stage pass",
          );
        }
      }

      set.status = 200;
      // Emit a restore change so the File Provider extension reinstates
      // the item at its new location.
      await recordAndPublishAssetChange({
        kind: "restore",
        asset_id: id,
        folder_id: doc.folder_id,
        abs_path: result.newAbsPath,
      }).catch(() => {});
      // `size` and `mtime` are included so the File Provider extension
      // can synthesise the restored item's metadata directly from the
      // response rather than statting `abs_path` (which is the SERVER's
      // path, not the client's, and would fail/return zeros on the Mac).
      return {
        asset_id: id.toHexString(),
        abs_path: result.newAbsPath,
        filename: restoredFilename,
        size: restoredSize,
        mtime: restoredMtime,
      };
    },
    {
      body: t.Object({
        target_relative_path: t.Optional(t.String()),
        target_folder_id: t.Optional(t.String()),
      }),
    }
  );
