/**
 * POST /api/admin/faces/purge-subthreshold — audit or remove existing face
 * records whose bbox is below the configured `face_min_detection_size`.
 *
 * ## Motivation
 * #1595 / PR #1599 added a size gate to NEW detections, but faces that were
 * detected before that setting was applied remain in the DB. A
 * `FACE_DETECT_TARGET_VERSION` bump would purge them, but it also rewrites
 * every faces array, nulls all `person_id` values, un-hides hidden faces, and
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
 * Idempotent — re-running removes nothing new once the population is clean.
 * Auth-gated (lives inside the authed API sub-app in `src/index.ts`).
 */

import { Elysia, t } from 'elysia';
import type { ObjectId } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import { recomputePersonFaceCount } from '../people/people-face-count.repo.ts';
import type { AssetFaceDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('admin:purge-subthreshold-faces');

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBelowThreshold(face: AssetFaceDoc, minSize: number): boolean {
  return Math.min(face.bbox.w, face.bbox.h) < minSize;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const QuerySchema = t.Object({
  apply: t.Optional(t.String()),
  includeAssigned: t.Optional(t.String()),
});

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

    const applyMode = query.apply === 'true';
    const includeAssigned = query.includeAssigned === 'true';

    // Audit counters (always computed regardless of apply mode)
    let unassignedSubCount = 0;
    let assignedSubCount = 0;
    let hiddenSubCount = 0;
    let assetsScanned = 0;
    let assetsAffected = 0;

    // Collect affected person ids for face_count recompute
    const affectedPersonIds = new Set<string>();

    // Per-person sub-threshold loss map (for audit output)
    const personLoss = new Map<string, number>();

    // Apply tracking
    let facesRemoved = 0;
    let assetsUpdated = 0;

    const coll = await assetsCollection();
    const cursor = coll
      .find({ faces: { $exists: true, $not: { $size: 0 } } } as Parameters<typeof coll.find>[0], {
        projection: { _id: 1, faces: 1 },
      })
      .batchSize(BATCH_SIZE);

    for await (const rawDoc of cursor) {
      const doc = rawDoc as unknown as { _id: ObjectId; faces?: AssetFaceDoc[] };
      if (!Array.isArray(doc.faces) || doc.faces.length === 0) continue;

      assetsScanned += 1;

      const subFaces = doc.faces.filter((f) => isBelowThreshold(f, minSize));
      if (subFaces.length === 0) continue;

      assetsAffected += 1;

      // Tally by category
      for (const f of subFaces) {
        if (f.hidden === true) {
          hiddenSubCount += 1;
        } else if (f.person_id !== null && f.person_id !== undefined) {
          assignedSubCount += 1;
          const loss = personLoss.get(f.person_id) ?? 0;
          personLoss.set(f.person_id, loss + 1);
        } else {
          unassignedSubCount += 1;
        }
      }

      if (!applyMode) continue;

      // Determine which sub-threshold faces to remove.
      // Hidden faces are ALWAYS preserved — the operator explicitly hid them.
      // Assigned faces are only removed when the opt-in flag is set.
      const toRemovePredicate = (f: AssetFaceDoc): boolean => {
        if (!isBelowThreshold(f, minSize)) return false;
        if (f.hidden === true) return false;
        if (f.person_id !== null && f.person_id !== undefined && !includeAssigned) return false;
        return true;
      };

      const surviving = doc.faces.filter((f) => !toRemovePredicate(f));
      const removedCount = doc.faces.length - surviving.length;

      if (removedCount === 0) continue;

      // Collect person ids from the removed faces so we can recompute counts.
      for (const f of doc.faces) {
        if (toRemovePredicate(f) && typeof f.person_id === 'string' && f.person_id.length > 0) {
          affectedPersonIds.add(f.person_id);
        }
      }

      await coll.updateOne({ _id: doc._id } as Parameters<(typeof coll)['updateOne']>[0], {
        $set: { faces: surviving },
      });

      facesRemoved += removedCount;
      assetsUpdated += 1;

      log.info(
        { assetId: doc._id.toHexString(), removedCount, remainingCount: surviving.length },
        'purged sub-threshold faces',
      );
    }

    // Recompute face_count for every affected person.
    const personRecomputes: Array<{ personId: string; newCount: number }> = [];
    if (applyMode && affectedPersonIds.size > 0) {
      for (const personId of affectedPersonIds) {
        const newCount = await recomputePersonFaceCount(personId);
        personRecomputes.push({ personId, newCount });
        log.info({ personId, newCount }, 'recomputed face_count after purge');
      }
    }

    // Build audit summary for the persons affected section.
    const affectedPeople = Array.from(personLoss.entries()).map(([personId, lossCount]) => ({
      personId,
      subThresholdFaces: lossCount,
    }));

    const summary = {
      threshold: minSize,
      mode: applyMode ? (includeAssigned ? 'apply:all' : 'apply:unassigned-only') : 'dry-run',
      assetsScanned,
      assetsAffected,
      subThresholdFaces: {
        unassigned: unassignedSubCount,
        assigned: assignedSubCount,
        hidden: hiddenSubCount,
        total: unassignedSubCount + assignedSubCount + hiddenSubCount,
      },
      policy: {
        removesUnassigned: applyMode,
        removesAssigned: applyMode && includeAssigned,
        preservesHidden: true,
      },
      affectedPeople,
      ...(applyMode
        ? {
            applied: {
              facesRemoved,
              assetsUpdated,
              personCountsRecomputed: personRecomputes.length,
              personRecomputes,
            },
          }
        : {}),
    };

    log.info(summary, 'purge-subthreshold-faces complete');
    return summary;
  },
  { query: QuerySchema },
);
