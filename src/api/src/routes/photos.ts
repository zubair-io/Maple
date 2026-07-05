import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import type { Filter } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { toDetailDto } from '../db/assets.transform.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../indexer/libraries.cache.ts';
import { assetPrimaryFileInfo } from '../indexer/images.repo.ts';
import type { AssetDoc } from '../db/schema.ts';

/** Response is capped, not paginated — this backs a Settings alert list,
 * not a browse view. A hard cap bounds worst-case memory/latency without
 * the added client-side complexity of a cursor; if the hidden-review
 * backlog ever regularly exceeds this, paginate then. */
const MAX_RESULTS = 200;

export const photosRoutes = new Elysia()
  .get(
    '/api/photos/hidden',
    async ({ query }) => {
      const db = await assetsCollection();
      const libs = await loadLibraryRoots();
      const idToSlug = await loadLibraryIdToSlug();

      const filter: Filter<AssetDoc> = { hidden: true };
      if (query.onlyNew === 'true') {
        filter.hidden_ack = false;
        filter.hidden_reason = { $in: ['nudity', 'nudity-burst'] };
      }

      // Newest-hidden-first so the cap surfaces the most recent alerts.
      const docs = await db.find(filter).sort({ _id: -1 }).limit(MAX_RESULTS).toArray();

      return docs.map((doc) => {
        // slug:relPath address, used by the batch-metadata `/api/xmp/batch`
        // route — the DTO's `id` is a Mongo ObjectId hex string and cannot
        // be resolved by `resolveAddressString`.
        let address: string | null = null;
        const primary = assetPrimaryFileInfo(doc);
        if (primary) {
          const slug = idToSlug.get(primary.library_id.toHexString());
          if (slug) {
            const relPath = primary.path ? `${primary.path}/${primary.filename}` : primary.filename;
            address = `${slug}:${relPath}`;
          }
        }
        return { ...toDetailDto(doc, libs), address };
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

      const db = await assetsCollection();
      // Scoped to AI-driven hides only — `hidden_ack` is documented as
      // meaningless for `hidden_reason: 'manual'`, so a manual hide's flag
      // is never touched here (it's already not `hidden_ack: false`, since
      // that path never sets it in the first place — see describe.ts and
      // sidecar-metadata-index.ts).
      const result = await db.updateOne(
        { _id: objId, hidden_reason: { $in: ['nudity', 'nudity-burst'] } },
        { $set: { hidden_ack: true } },
      );

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
