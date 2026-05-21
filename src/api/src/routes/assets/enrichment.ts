/**
 * /api/assets per-stage enrichment requeue.
 *
 *   POST /api/assets/:id/enrichment/requeue   — clears `done_at` and
 *       bumps `version` so the worker claim filter picks the row up on
 *       its next tick. Also clears the dead-letter timestamp so a
 *       previously-exhausted row gets a fresh retry budget.
 *
 * Mounted into `assetsRoutes` (see ./index.ts) which provides the
 * `/api/assets` prefix.
 *
 * Mongo access lives in `src/db/assets.repo.ts`.
 */

import { Elysia, t } from "elysia";
import type { Enrichment } from "../../db/schema.ts";
import {
  parseAssetId,
  requeueEnrichmentStage,
} from "../../db/assets.repo.ts";

/** Whitelisted enrichment stage names for the requeue route. Anything else
 * is rejected with 400 so a client can't poke a Mongo path that doesn't
 * belong to the enrichment subdoc. */
const ENRICHMENT_STAGES = ["geocode", "face", "describe"] as const;
type EnrichmentStageName = (typeof ENRICHMENT_STAGES)[number];

function isEnrichmentStage(s: string): s is EnrichmentStageName {
  return (ENRICHMENT_STAGES as readonly string[]).includes(s);
}

export const enrichmentRoutes = new Elysia()
  .post(
    "/:id/enrichment/requeue",
    async ({ params, body, set }) => {
      const id = parseAssetId(params.id);
      if (!id) {
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

      const result = await requeueEnrichmentStage(id, stage as keyof Enrichment);
      if (!result) {
        set.status = 404;
        return { error: "Asset not found" };
      }

      return { stage, version: result.version };
    },
    {
      body: t.Object({
        stage: t.String(),
      }),
    }
  );
