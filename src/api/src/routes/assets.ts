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
 * PUT /api/assets/:id/ocr                   — manual override of OCR text
 * POST /api/assets/:id/enrichment/requeue   — bump per-stage version + clear done_at
 *
 * The three PUT-override routes write directly to the corresponding asset
 * field and recompute `asset.search_blob` atomically using the same
 * aggregation-pipeline `$set` form the workers use, so the unified text
 * index stays coherent without a read-modify-write race.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../db/client.ts";
import {
  readXmp,
  writeXmpAtomic,
  writeXmpWithPrecondition,
  deleteXmpSidecar,
  readConflictSidecar,
  writeConflictSidecarAtomic,
  deleteConflictSidecar,
  resolveThumbPath,
} from "../fs/xmp.ts";
import { safeReadFile } from "../fs/root.ts";
import { normaliseEnrichment, type Place } from "../db/schema.ts";
import { searchBlobUpdateExpression } from "../enrichment/search-blob.ts";
import { recordAndPublishAssetChange } from "../db/changes.repo.ts";

/** Whitelisted enrichment stage names for the requeue route. Anything else
 * is rejected with 400 so a client can't poke a Mongo path that doesn't
 * belong to the enrichment subdoc. */
const ENRICHMENT_STAGES = ["geocode", "face", "describe", "ocr"] as const;
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

  // Manual OCR override
  .put(
    "/:id/ocr",
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
            ocr_text: text,
            search_blob: searchBlobUpdateExpression({ ocrText: text }),
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
