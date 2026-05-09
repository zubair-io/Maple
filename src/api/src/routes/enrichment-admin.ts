/**
 * /api/enrichment/dead-letter/* — slow-tier dead-letter triage.
 *
 *   GET  /api/enrichment/dead-letter?stage=geocode&limit=50    — list rows
 *   GET  /api/enrichment/dead-letter/groups?stage=geocode      — clustered
 *   POST /api/enrichment/dead-letter/reset                     — clear one or all
 *
 * The reset POST takes `{ stage, assetId? }`. Omitting `assetId` resets
 * every dead-lettered row for the stage (the "/reset-all" alternative
 * called out in `docs/indexer-enrichment.md` §7.2).
 *
 * All routes are mounted behind `requireAuth` — see `src/index.ts`. This
 * is operator surface, not a public read.
 */

import { Elysia, t } from "elysia";
import {
  groupEnrichmentDeadLetter,
  isEnrichmentStage,
  listEnrichmentDeadLetter,
  resetEnrichmentDeadLetter,
  type EnrichmentStage,
} from "../enrichment/dead-letter.repo.ts";

const STAGE_VALUES: ReadonlyArray<EnrichmentStage> = [
  "geocode",
  "face",
  "describe",
];

const ListQuery = t.Object({
  stage: t.String(),
  limit: t.Optional(t.String()),
});

const GroupQuery = t.Object({
  stage: t.String(),
});

const ResetBody = t.Object({
  stage: t.String(),
  assetId: t.Optional(t.String()),
});

function invalidStageMessage(s: string): string {
  return `Invalid stage: ${s}. Expected one of ${STAGE_VALUES.join(", ")}.`;
}

export const enrichmentAdminRoutes = new Elysia({
  prefix: "/api/enrichment/dead-letter",
})
  .get(
    "/",
    async ({ query, set }) => {
      if (!isEnrichmentStage(query.stage)) {
        set.status = 400;
        return { error: invalidStageMessage(query.stage) };
      }
      let limit: number | undefined;
      if (query.limit !== undefined && query.limit !== "") {
        const n = Number(query.limit);
        if (!Number.isFinite(n) || n < 1) {
          set.status = 400;
          return { error: `Invalid limit: ${query.limit}` };
        }
        limit = Math.floor(n);
      }
      const rows = await listEnrichmentDeadLetter({
        stage: query.stage,
        limit,
      });
      return { rows };
    },
    { query: ListQuery },
  )

  .get(
    "/groups",
    async ({ query, set }) => {
      if (!isEnrichmentStage(query.stage)) {
        set.status = 400;
        return { error: invalidStageMessage(query.stage) };
      }
      const groups = await groupEnrichmentDeadLetter({ stage: query.stage });
      return { groups };
    },
    { query: GroupQuery },
  )

  .post(
    "/reset",
    async ({ body, set }) => {
      if (!isEnrichmentStage(body.stage)) {
        set.status = 400;
        return { error: invalidStageMessage(body.stage) };
      }
      const result = await resetEnrichmentDeadLetter({
        stage: body.stage,
        assetId: body.assetId,
      });
      return result;
    },
    { body: ResetBody },
  );
