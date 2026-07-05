import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { toDetailDto } from '../db/assets.transform.ts';
import { loadLibraryRoots } from '../indexer/libraries.cache.ts';

export const photosRoutes = new Elysia()
  .get(
    '/api/photos/hidden',
    async ({ query }) => {
      const db = await assetsCollection();
      const libs = await loadLibraryRoots();

      const filter: any = { hidden: true };
      if (query.onlyNew === 'true') {
        filter.hidden_ack = false;
        filter.hidden_reason = { $in: ['nudity', 'nudity-burst'] };
      }

      const docs = await db.find(filter).toArray();
      return docs.map((doc) => toDetailDto(doc as any, libs));
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
      const result = await db.updateOne({ _id: objId }, { $set: { hidden_ack: true } });

      if (result.matchedCount === 0) {
        set.status = 404;
        return { error: 'asset not found' };
      }

      return { ok: true };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  );
