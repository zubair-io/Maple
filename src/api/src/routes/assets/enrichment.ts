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
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import { assetsCollection } from "../../db/client.ts";
import { normaliseEnrichment } from "../../db/schema.ts";

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
