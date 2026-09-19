/**
 * POST /api/admin/faces/purge-subthreshold — audit or remove existing face
 * records whose bbox is below the configured `face_min_detection_size`.
 *
 * ## Motivation
 * #1595 / PR #1599 added a size gate to NEW detections, but faces that were
 * detected before that setting was applied remain in the DB. A
 * `FACE_DETECT_TARGET_VERSION` bump would purge them, but it also rewrites
 * every face record, nulls all `person_id` values, un-hides hidden faces, and
 * forces a full re-cluster — destroying manual curation. This route removes
 * only the sub-threshold faces while leaving every other face (and all
 * curated data) intact.
 *
 * ## Usage
 * - **Dry-run (default, writes nothing):** `POST .../purge-subthreshold`
 *   Returns a JSON audit report: per-category counts, per-person impact.
 * - **Apply (unassigned only):** `POST .../purge-subthreshold?apply=true`
 *   Removes sub-threshold faces whose `person_id` is null. Preserves manually
 *   assigned and hidden sub-threshold faces (they were a deliberate choice).
 * - **Apply (include assigned):** `POST .../purge-subthreshold?apply=true&includeAssigned=true`
 *   Also removes sub-threshold faces that have a `person_id`. Hidden faces are
 *   always preserved regardless of this flag.
 *
 * ## Concurrency
 * A face is a row, so the removal is one `DELETE` over the same predicate the
 * audit counted — see `db/sqlite/repos/faces.purge.ts`. That is a genuine
 * improvement on the `$pull` it replaces and not just a translation: `$pull`
 * compacted the `faces[]` array, shifting every later element's index, so an
 * in-flight `face-embed` write addressed by index could land on the wrong
 * face. `face_index` is a stored column now and a delete moves nothing, so a
 * concurrent embed still writes to the face it read. Pausing the face workers
 * first remains good practice and is no longer load-bearing.
 *
 * Idempotent — re-running removes nothing new once the population is clean.
 * Auth-gated (lives inside the authed API sub-app in `src/index.ts`).
 */

import { Elysia, t } from 'elysia';
import { auditSubthresholdFaces, purgeSubthresholdFaces } from '../db/sqlite/repos/faces.purge.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { recomputePersonFaceCount } from '../people/people-face-count.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('admin:purge-subthreshold-faces');

const QuerySchema = t.Object({
  apply: t.Optional(t.String()),
  includeAssigned: t.Optional(t.String()),
});

/**
 * Face counts for the people who lost assigned faces.
 *
 * Only these people need reporting: an unassigned face counts toward nobody,
 * so a default (unassigned-only) purge changes no person's count and this
 * loop does not run at all. The count is derived from the rows rather than
 * stored, so this reads rather than writes — the name survives from when
 * `people.face_count` was a denormalised column (see
 * `db/sqlite/repos/people.face-count.ts`).
 */
async function recountAffectedPeople(
  personIds: Iterable<string>,
): Promise<Array<{ personId: string; newCount: number }>> {
  const recomputes: Array<{ personId: string; newCount: number }> = [];
  for (const personId of personIds) {
    const newCount = await recomputePersonFaceCount(personId);
    recomputes.push({ personId, newCount });
    log.info({ personId, newCount }, 'recomputed face_count after purge');
  }
  return recomputes;
}

/** What the caller asked for: audit only, or delete, and how much. */
interface PurgeMode {
  apply: boolean;
  includeAssigned: boolean;
}

type Audit = Awaited<ReturnType<typeof auditSubthresholdFaces>>;
type Applied = Awaited<ReturnType<typeof purgeSubthresholdFaces>>;

/**
 * Removes what the mode asks for, or nothing at all in dry-run.
 *
 * The audit's counts decide whether there is anything to delete: unassigned
 * always, assigned only when the caller opted in. Hidden faces are never in
 * either number — preserving them is not a mode.
 */
async function applyPurge(minSize: number, audit: Audit, mode: PurgeMode): Promise<Applied | null> {
  if (!mode.apply) return null;
  const removable = audit.unassigned + (mode.includeAssigned ? audit.assigned : 0);
  if (removable === 0) return null;
  return purgeSubthresholdFaces(minSize, mode.includeAssigned);
}

/**
 * The report, which is the whole answer in dry-run and the receipt when the
 * delete ran.
 *
 * `affectedPeople` lists every person holding sub-threshold assigned faces
 * whether or not this run removed them, so a dry-run tells an operator who
 * would be affected before they opt in. The `applied` block appears only in
 * apply mode, and its numbers are what the delete actually removed rather than
 * what the audit predicted — the two differ if a detection landed in between.
 */
function purgeSummary(args: {
  minSize: number;
  mode: PurgeMode;
  audit: Audit;
  applied: Applied | null;
  personRecomputes: Array<{ personId: string; newCount: number }>;
}): Record<string, unknown> {
  const { minSize, mode, audit, applied, personRecomputes } = args;
  return {
    threshold: minSize,
    mode: describeMode(mode),
    assetsScanned: audit.assetsScanned,
    assetsAffected: audit.assetsAffected,
    subThresholdFaces: {
      unassigned: audit.unassigned,
      assigned: audit.assigned,
      hidden: audit.hidden,
      total: audit.unassigned + audit.assigned + audit.hidden,
    },
    policy: {
      removesUnassigned: mode.apply,
      removesAssigned: mode.apply && mode.includeAssigned,
      preservesHidden: true,
    },
    affectedPeople: [...audit.personLoss.entries()].map(([personId, lossCount]) => ({
      personId,
      subThresholdFaces: lossCount,
    })),
    ...(mode.apply
      ? {
          applied: {
            facesRemoved: applied?.facesRemoved ?? 0,
            assetsUpdated: applied?.assetsUpdated ?? 0,
            personCountsRecomputed: personRecomputes.length,
            personRecomputes,
          },
        }
      : {}),
  };
}

function describeMode(mode: PurgeMode): string {
  if (!mode.apply) return 'dry-run';
  return mode.includeAssigned ? 'apply:all' : 'apply:unassigned-only';
}

export const purgeSubthresholdFacesRoutes = new Elysia({
  prefix: '/api/admin/faces',
}).post(
  '/purge-subthreshold',
  async ({ query, set }) => {
    const dbConfig = await loadEnrichmentConfig();
    const { face_min_detection_size: minSize } = resolveEnrichmentConfig(dbConfig);

    if (minSize <= 0) {
      set.status = 400;
      return {
        error:
          'face_min_detection_size is 0 — no size gate is active. ' +
          'Set a non-zero value in /settings/workers before running this purge.',
      };
    }

    const mode = {
      apply: query.apply === 'true',
      includeAssigned: query.includeAssigned === 'true',
    };

    // The audit runs in both modes: it describes the same population the
    // delete acts on, and in dry-run mode it is the whole answer.
    const audit = await auditSubthresholdFaces(minSize);
    const applied = await applyPurge(minSize, audit, mode);

    // Recompute only for people who actually lost assigned faces — which is
    // nobody unless the caller opted in.
    const personRecomputes =
      applied !== null && mode.includeAssigned
        ? await recountAffectedPeople(audit.personLoss.keys())
        : [];

    if (applied !== null) {
      log.info(
        { ...applied, includeAssigned: mode.includeAssigned },
        'applied sub-threshold purge',
      );
    }

    const summary = purgeSummary({ minSize, mode, audit, applied, personRecomputes });
    log.info(summary, 'purge-subthreshold-faces complete');
    return summary;
  },
  { query: QuerySchema },
);
