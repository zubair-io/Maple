import { Elysia, t } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import { acknowledgeHiddenAsset, findHiddenAssets } from '../db/repos/assets.hidden.ts';
import { loadLibraryIdToSlug } from '../indexer/libraries.cache.ts';
import { assetAddress } from '../indexer/images.repo.ts';

/** Response is capped, not paginated — this backs a Settings alert list,
 * not a browse view. A hard cap bounds worst-case memory/latency without
 * the added client-side complexity of a cursor; if the hidden-review
 * backlog ever regularly exceeds this, paginate then. */
const MAX_RESULTS = 200;

export const photosRoutes = new Elysia()
  .get(
    '/api/photos/hidden',
    async ({ query }) => {
      const idToSlug = await loadLibraryIdToSlug();

      // Newest-hidden-first so the cap surfaces the most recent alerts.
      const assets = await findHiddenAssets({
        onlyNew: query.onlyNew === 'true',
        limit: MAX_RESULTS,
      });

      return assets.map((asset) => {
        // slug:relPath address, used by the batch-metadata `/api/xmp/batch`
        // route — the DTO's `id` is a 24-character hex asset id and cannot
        // be resolved by `resolveAddressString`.
        return { ...asset, address: assetAddress({ fileinfo: asset.fileinfo }, idToSlug) };
      });
    },
    {
      query: t.Object({
        onlyNew: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/api/assets/:id/hidden-ack',
    async ({ params, set }) => {
      let objId: ObjectId;
      try {
        objId = new ObjectId(params.id);
      } catch {
        set.status = 400;
        return { error: 'invalid id format' };
      }

      // Scoped to AI-driven hides only — `hidden_ack` is documented as
      // meaningless for `hidden_reason: 'manual'`, so a manual hide's flag
      // is never touched here (it's already not `hidden_ack: false`, since
      // that path never sets it in the first place — see describe.ts and
      // sidecar-metadata-index.ts).
      const result = await acknowledgeHiddenAsset(objId);

      if (result.matchedCount === 0) {
        set.status = 404;
        return { error: 'asset not found or not an AI-driven hide' };
      }

      return { ok: true };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  );
