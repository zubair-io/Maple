/**
 * /api/assets XMP sidecar I/O.
 *
 *   GET    /api/assets/:id/xmp   — read XMP sidecar (or empty stub)
 *   PUT    /api/assets/:id/xmp   — write XMP sidecar (atomic, optional
 *                                  X-If-Mtime-Matches precondition →
 *                                  409 + conflict-copy on mismatch)
 *   DELETE /api/assets/:id/xmp   — delete XMP sidecar (idempotent)
 *
 * `?conflict=<filename>` switches every verb to read/write/delete the
 * named conflict-copy sidecar instead of the canonical one.
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../../db/client.ts";
import {
  readXmp,
  writeXmpWithPrecondition,
  deleteXmpSidecar,
  readConflictSidecar,
  writeConflictSidecarAtomic,
  deleteConflictSidecar,
} from "../../fs/xmp.ts";
import { recordAndPublishAssetChange } from "../../db/changes.repo.ts";

export const xmpRoutes = new Elysia()
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
  });

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
