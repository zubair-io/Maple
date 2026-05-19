/**
 * /api/assets metadata + binary reads.
 *
 *   GET /api/assets/:id          — single asset metadata
 *   GET /api/assets/:id/raw      — binary RAW bytes (streaming)
 *   GET /api/assets/:id/thumb    — thumbnail from .maple/ cache
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { stat } from "node:fs/promises";
import { assetsCollection } from "../../db/client.ts";
import { resolveThumbPath } from "../../fs/xmp.ts";
import { safeReadFile } from "../../fs/root.ts";
import { normaliseEnrichment } from "../../db/schema.ts";
import { ifNoneMatchEqual } from "../../runtime/http-etag.ts";

export const metadataRoutes = new Elysia()
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

    // `description_meta` and `ocr_meta` aren't typed in the canonical
    // `AssetDoc` (they were added by the describe / OCR workers after the
    // schema froze), so we cast through `Record<string, unknown>` for the
    // read-side projection. The shape is stable — see describe-worker.ts
    // (writes `description_meta`) and ocr-worker.ts (writes `ocr_meta`).
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
    async ({ params, headers, set }) => {
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
  );
