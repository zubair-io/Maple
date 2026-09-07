/**
 * /api/assets manual override routes.
 *
 *   PUT /api/assets/:id/place        — manual override of reverse-geocoded place
 *   PUT /api/assets/:id/description  — manual override of LLM caption
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
 *
 * Mongo access lives in `src/db/assets.repo.ts`.
 */

import { Elysia, t } from 'elysia';
import { type Place } from '../../db/schema.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import { setDescriptionOverride, setPlaceOverride } from '../../db/assets.repo.ts';
import { resolveAssetInfoOrRespond } from './_shared.ts';

export const overrideRoutes = new Elysia()
  // Manual place override
  .put(
    '/:id/place',
    async ({ params, body, set }) => {
      const resolved = await resolveAssetInfoOrRespond(params.id, set);
      if ('error' in resolved) return resolved;
      const { id, info } = resolved;

      const place = (body as { place: Place | null } | null)?.place ?? null;
      await setPlaceOverride(id, place);

      set.status = 204;
      await recordAndPublishAssetChange({
        kind: 'update',
        asset_id: id,
        folder_id: info.folder_id,
        abs_path: info.abs_path,
      }).catch(() => {});
      return;
    },
    {
      body: t.Object({
        place: t.Union([t.Null(), t.Object({}, { additionalProperties: true })]),
      }),
    },
  )

  // Manual description override
  .put(
    '/:id/description',
    async ({ params, body, set }) => {
      const resolved = await resolveAssetInfoOrRespond(params.id, set);
      if ('error' in resolved) return resolved;
      const { id, info } = resolved;

      const text = (body as { text: string | null } | null)?.text ?? null;
      await setDescriptionOverride(id, text);

      set.status = 204;
      await recordAndPublishAssetChange({
        kind: 'update',
        asset_id: id,
        folder_id: info.folder_id,
        abs_path: info.abs_path,
      }).catch(() => {});
      return;
    },
    {
      body: t.Object({
        text: t.Union([t.Null(), t.String()]),
      }),
    },
  );
