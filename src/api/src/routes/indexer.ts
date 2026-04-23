/**
 * /api/indexer routes.
 *
 *   GET  /api/indexer/status       — pipeline snapshot
 *   PUT  /api/indexer/config       — update worker pool sizes live
 *   GET  /api/indexer/dead-letter  — list dead-lettered jobs (paginated)
 */

import { Elysia, t } from "elysia";
import { getIndexerService } from "../indexer/service.ts";
import { listDeadLetter } from "../indexer/indexer.repo.ts";

const ConfigBody = t.Object({
  workers: t.Object({
    discover: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    hash: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    exif: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    thumb: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    ai: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
    mongo: t.Optional(t.Integer({ minimum: 1, maximum: 64 })),
  }),
});

export const indexerRoutes = new Elysia({ prefix: "/api/indexer" })
  .get("/status", () => {
    const svc = getIndexerService();
    return svc.status();
  })

  .put(
    "/config",
    ({ body }) => {
      const svc = getIndexerService();
      svc.setConfig(body.workers);
      return { ok: true, status: svc.status() };
    },
    { body: ConfigBody }
  )

  .get(
    "/dead-letter",
    async ({ query }) => {
      const limit = Math.min(1000, Math.max(1, Number(query.limit ?? 200)));
      try {
        const docs = await listDeadLetter(limit);
        return { items: docs, total: docs.length };
      } catch (e) {
        return {
          items: [],
          total: 0,
          warning: e instanceof Error ? e.message : String(e),
        };
      }
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
    }
  );
