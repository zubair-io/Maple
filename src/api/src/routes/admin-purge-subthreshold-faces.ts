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
 * ## Concurrency
 * Apply removes faces with an atomic server-side `$pull` (one `updateMany`
 * over the matched element predicate), NOT a read-modify-write of the whole
 * `faces[]`. A whole-array write would clobber concurrent per-index worker
 * writes (e.g. `face-embed` doing `$set faces.<i>.embedding`) and the index
 * shift from element removal could corrupt an in-flight embed. `$pull` matches
 * elements by value, never depends on a stale array snapshot, and only touches
 * the faces it removes. As defense in depth the operator should still pause the
 * face-detect / face-embed workers (on /settings/workers) before applying.
 *
 * Idempotent — re-running removes nothing new once the population is clean.
 * Auth-gated (lives inside the authed API sub-app in `src/index.ts`).
 */

import { Elysia, t } from 'elysia';
import type { Filter } from 'mongodb';
import { assetsCollection } from '../db/client.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { recomputePersonFaceCount } from '../people/people-face-count.repo.ts';
import type { AssetDoc, AssetFaceDoc } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('admin:purge-subthreshold-faces');

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Shared predicate — ONE definition of "this face is sub-threshold and
// removable", used both for the in-memory audit tally and the Mongo `$pull`
// element match, so the reported counts always equal what apply removes.
// ---------------------------------------------------------------------------

/** `min(bbox.w, bbox.h) < t` ⇔ `bbox.w < t OR bbox.h < t`. The OR form is
 * what the Mongo `$pull` element predicate uses (Mongo can't compute a min
 * across two fields in a query). */
function isBelowThreshold(face: AssetFaceDoc, minSize: number): boolean {
  return face.bbox.w < minSize || face.bbox.h < minSize;
}

/** JS mirror of the `$pull` element predicate: a face is removed iff it is
 * below threshold, NOT hidden, and (unless `includeAssigned`) unassigned. */
function isRemovable(face: AssetFaceDoc, minSize: number, includeAssigned: boolean): boolean {
  if (!isBelowThreshold(face, minSize)) return false;
  if (face.hidden === true) return false;
  const assigned = face.person_id !== null && face.person_id !== undefined;
  if (assigned && !includeAssigned) return false;
  return true;
}

/** Mongo element predicate for `$pull: { faces: <here> }`. Matches the same
 * faces `isRemovable` does. `hidden: { $ne: true }` preserves hidden faces;
 * `person_id: null` (default) restricts to unassigned. */
function pullElementPredicate(minSize: number, includeAssigned: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    $or: [{ 'bbox.w': { $lt: minSize } }, { 'bbox.h': { $lt: minSize } }],
    hidden: { $ne: true },
  };
  if (!includeAssigned) base['person_id'] = null;
  return base;
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

    // Audit counters (always computed, both modes — they describe the same
    // population the `$pull` will act on).
    let unassignedSubCount = 0;
    let assignedSubCount = 0;
    let hiddenSubCount = 0;
    let assetsScanned = 0;
    let assetsAffected = 0;

    // Person ids that would lose ASSIGNED faces. Only these need a
    // `face_count` recompute — unassigned faces count toward nobody, so a
    // default (unassigned-only) purge changes no person's count.
    const affectedAssignedPersonIds = new Set<string>();

    // Per-person sub-threshold loss map (for the audit's affectedPeople list).
    const personLoss = new Map<string, number>();

    const coll = await assetsCollection();

    // ── Audit pass — read-only scan, tally by category. ──────────────────
    const cursor = coll
      .find({ faces: { $exists: true, $ne: [] } } as Filter<AssetDoc>, {
        projection: { _id: 1, faces: 1 },
      })
      .batchSize(BATCH_SIZE);

    for await (const doc of cursor) {
      const faces = doc.faces;
      if (!Array.isArray(faces) || faces.length === 0) continue;

      assetsScanned += 1;

      const subFaces = faces.filter((f) => isBelowThreshold(f, minSize));
      if (subFaces.length === 0) continue;

      assetsAffected += 1;

      for (const f of subFaces) {
        if (f.hidden === true) {
          hiddenSubCount += 1;
        } else if (f.person_id !== null && f.person_id !== undefined) {
          assignedSubCount += 1;
          personLoss.set(f.person_id, (personLoss.get(f.person_id) ?? 0) + 1);
          // Would a purge actually remove this assigned face? Only when opted in.
          if (includeAssigned) affectedAssignedPersonIds.add(f.person_id);
        } else {
          unassignedSubCount += 1;
        }
      }
    }

    // facesRemoved is exactly what the removable predicate matched in the scan:
    // unassigned always, assigned only when opted in.
    const facesRemoved = applyMode
      ? unassignedSubCount + (includeAssigned ? assignedSubCount : 0)
      : 0;

    // ── Apply — atomic `$pull`, no whole-array write. ────────────────────
    let assetsUpdated = 0;
    const personRecomputes: Array<{ personId: string; newCount: number }> = [];

    if (applyMode && facesRemoved > 0) {
      const element = pullElementPredicate(minSize, includeAssigned);
      const res = await coll.updateMany(
        { faces: { $exists: true, $ne: [] } } as Filter<AssetDoc>,
        {
          $pull: { faces: element },
        } as never,
      );
      assetsUpdated = res.modifiedCount;

      // Recompute face_count ONLY for people who lost assigned faces (the
      // default unassigned-only purge changes no person's count).
      for (const personId of affectedAssignedPersonIds) {
        const newCount = await recomputePersonFaceCount(personId);
        personRecomputes.push({ personId, newCount });
        log.info({ personId, newCount }, 'recomputed face_count after purge');
      }

      log.info({ facesRemoved, assetsUpdated, includeAssigned }, 'applied sub-threshold purge');
    }

    // Build the audit's affectedPeople list (all people with sub-threshold
    // assigned faces, regardless of whether this run removes them).
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

// Exported for tests: lets the spec assert the JS predicate and the Mongo
// predicate stay in lockstep.
export { isRemovable, pullElementPredicate };
