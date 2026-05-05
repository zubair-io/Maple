/**
 * /api/assets routes.
 *
 * GET /api/assets/:id         — single asset metadata
 * GET /api/assets/:id/raw     — binary RAW bytes (streaming)
 * GET /api/assets/:id/thumb   — thumbnail from .maple/ cache
 * GET /api/assets/:id/xmp     — read XMP sidecar
 * PUT /api/assets/:id/xmp     — write XMP sidecar (atomic)
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import { readXmp, writeXmpAtomic, resolveThumbPath } from "../fs/xmp.ts";
import { safeReadFile } from "../fs/root.ts";

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
      thumb_hash: doc.thumb_hash,
      indexed_at: doc.indexed_at,
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
    async ({ params, query, set }) => {
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
      const result = await safeReadFile(thumbPath);
      if (!result.ok) {
        set.status = 404;
        return { error: "Thumbnail not yet generated" };
      }

      set.headers["Content-Type"] = "image/jpeg";
      set.headers["Cache-Control"] = "public, max-age=604800, immutable";
      return result.data;
    },
    {
      query: t.Object({
        size: t.Optional(t.String()),
      }),
    }
  )

  // Read XMP sidecar
  .get("/:id/xmp", async ({ params, set }) => {
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

    const result = await readXmp(doc.abs_path);
    if (!result.ok) {
      // No sidecar yet — return empty XMP
      set.headers["Content-Type"] = "application/xml";
      return emptyXmp(doc.filename);
    }

    set.headers["Content-Type"] = "application/xml";
    return result.data;
  })

  // Write XMP sidecar (atomic)
  .put(
    "/:id/xmp",
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

      const xmlContent =
        typeof body === "string"
          ? body
          : (body as unknown) instanceof Uint8Array
            ? new TextDecoder().decode(body as unknown as Uint8Array)
            : String(body);

      const result = await writeXmpAtomic(doc.abs_path, xmlContent);
      if (!result.ok) {
        set.status = 500;
        return { error: result.error };
      }

      set.status = 204;
      return;
    },
    {
      type: "text",
      body: t.String(),
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
