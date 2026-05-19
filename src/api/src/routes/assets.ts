/**
 * /api/assets routes.
 *
 * GET /api/assets/:id                       — single asset metadata
 * GET /api/assets/:id/raw                   — binary RAW bytes (streaming)
 * GET /api/assets/:id/thumb                 — thumbnail from .maple/ cache
 * GET /api/assets/:id/xmp                   — read XMP sidecar
 * PUT /api/assets/:id/xmp                   — write XMP sidecar (atomic)
 * PUT /api/assets/:id/place                 — manual override of reverse-geocoded place
 * PUT /api/assets/:id/description           — manual override of LLM caption
 * POST /api/assets/:id/enrichment/requeue   — bump per-stage version + clear done_at
 *
 * The three PUT-override routes write directly to the corresponding asset
 * field and recompute `asset.search_blob` atomically using the same
 * aggregation-pipeline `$set` form the workers use, so the unified text
 * index stays coherent without a read-modify-write race.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import * as path from "node:path";
import { stat, unlink } from "node:fs/promises";
import { assetsCollection, foldersCollection } from "../db/client.ts";
import {
  readXmp,
  writeXmpAtomic,
  writeXmpWithPrecondition,
  deleteXmpSidecar,
  readConflictSidecar,
  writeConflictSidecarAtomic,
  deleteConflictSidecar,
  resolveThumbPath,
  listPairedSidecars,
} from "../fs/xmp.ts";
import { moveToTrash, moveOutOfTrash } from "../fs/trash.ts";
import { safeReadFile } from "../fs/root.ts";
import { normaliseEnrichment, type Place } from "../db/schema.ts";
import { searchBlobUpdateExpression, composeSearchBlob } from "../enrichment/search-blob.ts";
import { recordAndPublishAssetChange } from "../db/changes.repo.ts";
import { ifNoneMatchEqual } from "../runtime/http-etag.ts";
import { meilisearchClient } from "../enrichment/meilisearch-client.ts";
import { child as childLogger } from "../log.ts";

const assetsLog = childLogger("routes:assets");

/** Whitelisted enrichment stage names for the requeue route. Anything else
 * is rejected with 400 so a client can't poke a Mongo path that doesn't
 * belong to the enrichment subdoc. */
const ENRICHMENT_STAGES = ["geocode", "face", "describe"] as const;
type EnrichmentStageName = (typeof ENRICHMENT_STAGES)[number];

function isEnrichmentStage(s: string): s is EnrichmentStageName {
  return (ENRICHMENT_STAGES as readonly string[]).includes(s);
}

export const assetsRoutes = new Elysia({ prefix: "/api/assets" })
  // Single asset metadata
  .get("/:id", async ({ params, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }

    // `description_meta` isn't typed in the canonical `AssetDoc` (it was
    // added by the describe stage after the schema froze), so we cast
    // through `Record<string, unknown>` for the read-side projection. The
    // shape is stable — see workers/stages/describe.ts, which writes both
    // `description_meta` and `ocr_meta` from the same VLM pass.
    const rawDoc = doc as unknown as Record<string, unknown>;
    return {
      id: doc._id.toHexString(),
      folder_id: doc.folder_id.toHexString(),
      filename: doc.filename,
      abs_path: doc.abs_path,
      size: doc.size,
      mtime: doc.mtime,
      rating: doc.rating,
      flag: doc.flag,
      color_label: doc.color_label,
      indexed_at: doc.indexed_at,
      // Phase 1 enrichment outputs — null/empty for rows that pre-date the
      // skeleton schema or whose workers have not yet run.
      place: doc.place ?? null,
      faces: doc.faces ?? [],
      description: doc.description ?? null,
      description_meta: rawDoc.description_meta ?? null,
      ocr_text: doc.ocr_text ?? null,
      ocr_meta: doc.ocr_meta ?? null,
      // Structured vision metadata from the qwen2.5-vl describe stage.
      // Both are null until the stage runs on the asset.
      vision: doc.vision ?? null,
      vision_meta: doc.vision_meta ?? null,
      // Top-level mirror of vision.is_screenshot — seeded by the exif
      // stage heuristic, overwritten by the describe stage's VLM verdict.
      is_screenshot: doc.is_screenshot ?? null,
      enrichment: normaliseEnrichment(doc.enrichment),
    };
  })

  // Stream raw bytes
  .get("/:id/raw", async ({ params, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }

    const result = await safeReadFile(doc.abs_path);
    if (!result.ok) {
      set.status = 403;
      return { error: result.error };
    }

    set.headers["Content-Type"] = "application/octet-stream";
    set.headers["Content-Disposition"] = `attachment; filename="${doc.filename}"`;
    set.headers["Content-Length"] = String(result.data!.byteLength);
    return result.data;
  })

  // Serve thumbnail from .maple/ cache
  .get(
    "/:id/thumb",
    async ({ params, query, headers, set }) => {
      let id: ObjectId;
      try {
        id = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: "Invalid asset id" };
      }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      // Single per-file thumb (size param is render-target advisory only;
      // the cache key no longer includes size — see fs/xmp.ts).
      const thumbPath = resolveThumbPath(doc.abs_path);

      // Stat the thumb FIRST so a 304-bound request never pays the
      // body-read cost. The previous shape (read then stat) defeated
      // the short-circuit — the disk read happened on every request
      // regardless of If-None-Match. With this order, the only cost on
      // a cache-hit revalidation is one stat() call.
      let etag: string;
      try {
        const st = await stat(thumbPath);
        etag = `"${Math.floor(st.mtimeMs)}-${st.size}"`;
      } catch {
        set.status = 404;
        return { error: "Thumbnail not yet generated" };
      }

      // RFC 9110 §15.4.5: 304 must carry the same Cache-Control as the
      // 200 path so URLSession's HTTP cache doesn't downgrade freshness
      // on revalidation. Pin the value here and reuse it on both paths.
      const cacheControl = "public, max-age=604800, immutable";
      const ifNoneMatch = headers["if-none-match"];
      if (
        ifNoneMatchEqual(
          typeof ifNoneMatch === "string" ? ifNoneMatch : undefined,
          etag,
        )
      ) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": cacheControl },
        });
      }

      // Cache miss — now do the body read.
      const result = await safeReadFile(thumbPath);
      if (!result.ok) {
        // Race: stat succeeded but read failed (file removed between
        // calls, or jail-rejected). Treat as 404 either way.
        set.status = 404;
        return { error: "Thumbnail not yet generated" };
      }
      set.headers["ETag"] = etag;
      set.headers["Content-Type"] = "image/jpeg";
      set.headers["Cache-Control"] = cacheControl;
      return result.data;
    },
    {
      query: t.Object({
        size: t.Optional(t.String()),
      }),
    }
  )

  // Read XMP sidecar
  .get("/:id/xmp", async ({ params, query, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }

    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }

    const conflict = typeof query.conflict === "string" ? query.conflict : null;
    if (conflict !== null) {
      const result = await readConflictSidecar(doc.abs_path, conflict);
      if (!result.ok) {
        set.status = 404;
        return { error: result.error };
      }
      set.headers["Content-Type"] = "application/xml";
      return result.data;
    }

    const result = await readXmp(doc.abs_path);
    if (!result.ok) {
      // No sidecar yet — return empty XMP
      set.headers["Content-Type"] = "application/xml";
      return emptyXmp(doc.filename);
    }

    set.headers["Content-Type"] = "application/xml";
    return result.data;
  })

  // Write XMP sidecar.
  //
  // Optional headers:
  //   X-If-Mtime-Matches: <epoch-seconds>  Precondition for conflict-copy
  //                                        mode. Omit to write
  //                                        unconditionally.
  //   X-Maple-Device-Name: <string>        Used in the conflict-copy
  //                                        filename. Defaults to
  //                                        "Unknown device".
  //
  // Responses:
  //   204 No Content + Last-Modified header — normal write
  //   409 Conflict   + JSON body { conflict_path, conflict_mtime } —
  //                    precondition mismatch; bytes written to conflict copy
  .put(
    "/:id/xmp",
    async ({ params, body, headers, query, set }) => {
      let id: ObjectId;
      try {
        id = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: "Invalid asset id" };
      }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      const xmlContent =
        typeof body === "string"
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);

      const conflict = typeof query.conflict === "string" ? query.conflict : null;
      if (conflict !== null) {
        const outcome = await writeConflictSidecarAtomic(doc.abs_path, conflict, xmlContent);
        if (!outcome.ok) {
          set.status = 400;
          return { error: outcome.error };
        }
        set.headers["Last-Modified"] = outcome.mtime.toUTCString();
        set.status = 204;
        // Conflict-sidecar writes still represent a change to the asset's
        // sidecar state — emit so devices subscribing to the change feed
        // pick the new sidecar up.
        await recordAndPublishAssetChange({
          kind: "update",
          asset_id: id,
          folder_id: doc.folder_id,
          abs_path: doc.abs_path,
        }).catch(() => {});
        return;
      }

      const ifMtimeHeader = headers["x-if-mtime-matches"];
      const ifMtimeMatchesEpoch =
        typeof ifMtimeHeader === "string" && /^\d+$/.test(ifMtimeHeader)
          ? parseInt(ifMtimeHeader, 10)
          : null;
      const deviceHeader = headers["x-maple-device-name"];
      const deviceName = typeof deviceHeader === "string" ? deviceHeader : "";

      const outcome = await writeXmpWithPrecondition(
        doc.abs_path,
        xmlContent,
        ifMtimeMatchesEpoch,
        deviceName,
      );

      if (outcome.kind === "error") {
        set.status = 500;
        return { error: outcome.error };
      }
      if (outcome.kind === "conflict") {
        set.status = 409;
        return {
          conflict_path: outcome.conflictPath,
          conflict_mtime: outcome.conflictMtime.toISOString(),
        };
      }
      set.headers["Last-Modified"] = outcome.mtime.toUTCString();
      set.status = 204;
      // Mark the asset as carrying an XMP sidecar so the working-set
      // `has_xmp` filter can find it cheaply (Task B1).
      await coll
        .updateOne({ _id: id }, { $set: { has_xmp: true } })
        .catch(() => {});
      // Best-effort change-feed emit so the File Provider extension can
      // signal the OS to re-fetch this asset's sidecar.
      await recordAndPublishAssetChange({
        kind: "update",
        asset_id: id,
        folder_id: doc.folder_id,
        abs_path: doc.abs_path,
      }).catch(() => {});
      return;
    },
    {
      type: "text",
      body: t.String(),
    }
  )

  // Delete XMP sidecar (idempotent).
  .delete("/:id/xmp", async ({ params, query, set }) => {
    let id: ObjectId;
    try {
      id = new ObjectId(params.id);
    } catch {
      set.status = 400;
      return { error: "Invalid asset id" };
    }
    const coll = await assetsCollection();
    const doc = await coll.findOne({ _id: id });
    if (!doc) {
      set.status = 404;
      return { error: "Asset not found" };
    }
    const conflict = typeof query.conflict === "string" ? query.conflict : null;
    const result = conflict !== null
      ? await deleteConflictSidecar(doc.abs_path, conflict)
      : await deleteXmpSidecar(doc.abs_path);
    if (!result.ok) {
      set.status = 400;
      return { error: result.error };
    }
    set.status = 204;
    // For canonical-sidecar deletes the asset no longer has an XMP;
    // for conflict-sidecar deletes the canonical may still be there,
    // so leave has_xmp alone in that branch.
    if (conflict === null) {
      await coll
        .updateOne({ _id: id }, { $set: { has_xmp: false } })
        .catch(() => {});
    }
    // The sidecar state changed — emit a feed event either way.
    await recordAndPublishAssetChange({
      kind: "update",
      asset_id: id,
      folder_id: doc.folder_id,
      abs_path: doc.abs_path,
    }).catch(() => {});
    return;
  })

  // ── Trash + restore (Phase 3) ─────────────────────────────────────────
  //
  // DELETE /api/assets/:id is dual-mode:
  //   * deleted_at == null → soft-delete (move RAW + sidecars to
  //     .maple/trash/<rel>, set deleted_at + original_path), returns 204.
  //   * deleted_at != null → permanent purge (unlink files, delete asset
  //     doc), returns 204. This is the "user emptied this single item
  //     from Trash" signal from the File Provider extension.
  //
  // The Phase-2 DELETE /:id/xmp route handles sidecar-only deletes via
  // a different path; this one is asset-level.
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
      let restoredMtimeIso = new Date().toISOString();
      try {
        const st = await stat(result.newAbsPath);
        restoredSize = st.size;
        restoredMtimeIso = new Date(st.mtimeMs).toISOString();
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
            mtime: restoredMtimeIso,
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
        mtime: restoredMtimeIso,
      };
    },
    {
      body: t.Object({
        target_relative_path: t.Optional(t.String()),
        target_folder_id: t.Optional(t.String()),
      }),
    }
  )

  // ── Manual override routes ───────────────────────────────────────────
  // The three PUT routes below let the user correct an enrichment output
  // without re-running the worker. They write the field directly and
  // recompute `search_blob` atomically using the same aggregation
  // expression each worker's `complete()` uses, so the unified text
  // index stays in sync without a read-modify-write race.
  //
  // Sending `null` clears the override (the next worker run would then
  // repopulate from its source). Sending a value pins it in place; the
  // operator must POST `/enrichment/requeue` to re-run the worker.

  // Manual place override
  .put(
    "/:id/place",
    async ({ params, body, set }) => {
      let id: ObjectId;
      try {
        id = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: "Invalid asset id" };
      }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      const place = (body as { place: Place | null } | null)?.place ?? null;
      const placeBlob = place?.search_blob ?? null;

      await coll.updateOne({ _id: id }, [
        {
          $set: {
            place,
            search_blob: searchBlobUpdateExpression({
              placeSearchBlob: placeBlob,
            }),
          },
        },
      ]);

      set.status = 204;
      await recordAndPublishAssetChange({
        kind: "update",
        asset_id: id,
        folder_id: doc.folder_id,
        abs_path: doc.abs_path,
      }).catch(() => {});
      return;
    },
    {
      body: t.Object({
        place: t.Union([
          t.Null(),
          t.Object({}, { additionalProperties: true }),
        ]),
      }),
    }
  )

  // Manual description override
  .put(
    "/:id/description",
    async ({ params, body, set }) => {
      let id: ObjectId;
      try {
        id = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: "Invalid asset id" };
      }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      const text = (body as { text: string | null } | null)?.text ?? null;

      await coll.updateOne({ _id: id }, [
        {
          $set: {
            description: text,
            search_blob: searchBlobUpdateExpression({ description: text }),
          },
        },
      ]);

      set.status = 204;
      await recordAndPublishAssetChange({
        kind: "update",
        asset_id: id,
        folder_id: doc.folder_id,
        abs_path: doc.abs_path,
      }).catch(() => {});
      return;
    },
    {
      body: t.Object({
        text: t.Union([t.Null(), t.String()]),
      }),
    }
  )

  // Per-stage requeue — clears `done_at` and bumps `version` so the worker
  // claim filter picks the row up on its next tick. Also clears the
  // dead-letter timestamp so a previously-exhausted row gets a fresh
  // retry budget.
  .post(
    "/:id/enrichment/requeue",
    async ({ params, body, set }) => {
      let id: ObjectId;
      try {
        id = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: "Invalid asset id" };
      }

      const stage = (body as { stage: string } | null)?.stage ?? "";
      if (!isEnrichmentStage(stage)) {
        set.status = 400;
        return {
          error: `Invalid stage. Expected one of: ${ENRICHMENT_STAGES.join(", ")}`,
        };
      }

      const coll = await assetsCollection();
      const doc = await coll.findOne({ _id: id });
      if (!doc) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      const currentVersion =
        normaliseEnrichment(doc.enrichment)[stage].version ?? 0;
      const nextVersion = currentVersion + 1;

      const result = await coll.updateOne(
        { _id: id },
        {
          $set: {
            [`enrichment.${stage}.done_at`]: null,
            [`enrichment.${stage}.version`]: nextVersion,
            [`enrichment.${stage}.attempts`]: 0,
            [`enrichment.${stage}.last_error`]: null,
            [`enrichment.${stage}.dead_letter_at`]: null,
            [`enrichment.${stage}.locked_by`]: null,
            [`enrichment.${stage}.lease_expires_at`]: null,
          },
        }
      );

      if (result.matchedCount === 0) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      return { stage, version: nextVersion };
    },
    {
      body: t.Object({
        stage: t.String(),
      }),
    }
  );

/** Minimal empty XMP document for an asset that has no sidecar yet. */
function emptyXmp(filename: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="${filename}"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"
      xmlns:maple="https://maple.app/xmp/1.0/"
      xmp:Rating="0"
      maple:Flag="0"
      maple:ColorLabel=""
    />
  </rdf:RDF>
</x:xmpmeta>`;
}
