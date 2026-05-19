/**
 * /api/assets manual override routes.
 *
 *   PUT /api/assets/:id/place        — manual override of reverse-geocoded place
 *   PUT /api/assets/:id/description  — manual override of LLM caption
 *   PUT /api/assets/:id/ocr          — manual override of OCR text
 *
 * Each route writes the field directly and recomputes `search_blob`
 * atomically using the same aggregation expression each worker's
 * `complete()` uses, so the unified text index stays in sync without a
 * read-modify-write race.
 *
 * Sending `null` clears the override (the next worker run would then
 * repopulate from its source). Sending a value pins it in place; the
 * operator must POST `/enrichment/requeue` to re-run the worker.
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../../db/client.ts";
import { type Place } from "../../db/schema.ts";
import { searchBlobUpdateExpression } from "../../enrichment/search-blob.ts";
import { recordAndPublishAssetChange } from "../../db/changes.repo.ts";

export const overrideRoutes = new Elysia()
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
  );
