/**
 * Migration: "audit-video-geo-backfill" — report-only pass that computes the
 * closest-in-time GPS donor for every live mp4/mov with no GPS coordinates and a
 * usable `exif.captured_at` timestamp. Writes NOTHING to the asset documents.
 *
 * Each candidate produces one audit document in the `video_geo_backfill_audit`
 * collection recording the decision (match or no-donor), the donor's _id and
 * GPS, and the time delta. The operator reviews this collection before enabling
 * the companion `apply-video-geo-backfill` migration.
 *
 * `countRemaining` converges to 0 as audit documents are written — candidates
 * without an audit doc yet are the remaining work.
 *
 * 287 videos with `exif.captured_at: null` are out of scope for v1. They are
 * logged once per batch for visibility but are NOT part of the candidate set.
 *
 * Spec: GitHub issue #1529.
 */

import type { Collection, Filter, ObjectId, WithId } from 'mongodb';
import { getDb, assetsCollection } from '../../db/client.ts';
import type { AssetDoc } from '../../db/schema.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:geo-backfill');

/** ±15 minutes in milliseconds. */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Candidate filter: live mp4/mov, no GPS, has a captured_at timestamp.
 *
 * The $elemMatch combines `filename` and liveness (`deleted_at`/`missing_since`)
 * on the SAME fileinfo entry so the video-file requirement and the live-entry
 * requirement can never match different entries in the array.
 */
function candidateFilter(): Filter<AssetDoc> {
  return {
    'exif.gps': null,
    // `$type: 'string'` is stricter than `$ne: null`: it excludes null, missing,
    // and any non-string value, so only a real ISO timestamp string can enter the
    // candidate set (the donor range query relies on string comparison).
    'exif.captured_at': { $type: 'string' },
    fileinfo: {
      $elemMatch: {
        filename: { $regex: /\.(mp4|mov)$/i },
        deleted_at: { $in: [null] },
        missing_since: { $in: [null] },
      },
    },
  } as Filter<AssetDoc>;
}

/** Shape of one audit document written to `video_geo_backfill_audit`. */
export interface AuditDoc {
  /** Same _id as the video asset — acts as the natural key for idempotency. */
  _id: ObjectId;
  maple_id: string | undefined;
  captured_at: string;
  decision: 'match' | 'no-donor' | 'skip';
  donor_id?: ObjectId;
  donor_maple_id?: string;
  donor_gps?: { lat: number; lng: number };
  delta_ms?: number;
  at: string;
}

export async function auditCollection(): Promise<Collection<AuditDoc>> {
  const db = await getDb();
  return db.collection<AuditDoc>('video_geo_backfill_audit');
}

/**
 * Find the closest-in-time donor: any live asset with GPS in the same library
 * within ±15 min of the video's `exif.captured_at`.
 *
 * The range query on `exif.captured_at` is index-friendly because the field is
 * stored as a 24-char UTC ISO string, making lexicographic string comparison
 * equivalent to chronological order.
 *
 * Guards against malformed / non-Z timestamps by wrapping Date parsing in a
 * try/catch and skipping any candidate whose date cannot be parsed.
 */
export async function findDonor(
  assets: Collection<AssetDoc>,
  videoId: ObjectId,
  capturedAt: string,
  libraryId: ObjectId,
): Promise<{ donor: WithId<AssetDoc>; deltaMs: number } | null> {
  let vt: Date;
  try {
    vt = new Date(capturedAt);
    if (isNaN(vt.getTime())) return null;
  } catch {
    return null;
  }

  const lo = new Date(vt.getTime() - WINDOW_MS).toISOString();
  const hi = new Date(vt.getTime() + WINDOW_MS).toISOString();

  const candidates = await assets
    .find(
      {
        // GPS must be present. Predicate on `exif.gps.lat` (not the whole `exif.gps`
        // object) so the partial index `exif_captured_at_gps_lat` is eligible and odd
        // shapes are avoided; numeric validity is re-checked by the apply caller.
        'exif.gps.lat': { $exists: true },
        'exif.gps.lng': { $exists: true },
        'exif.captured_at': { $gte: lo, $lte: hi },
        // Only borrow from a ground-truth photo: exclude any already-inferred asset
        // so inferred GPS can never daisy-chain (video → video), and exclude videos
        // (a donor video's GPS is rare and not what the operator intends to borrow).
        geo_inferred: { $exists: false },
        _id: { $ne: videoId },
        fileinfo: {
          $elemMatch: {
            library_id: libraryId,
            deleted_at: { $in: [null] },
            missing_since: { $in: [null] },
            filename: { $not: /\.(mp4|mov)$/i },
          },
        },
      },
      {
        projection: {
          _id: 1,
          maple_id: 1,
          'exif.gps': 1,
          'exif.captured_at': 1,
        },
      },
    )
    .toArray();

  if (candidates.length === 0) return null;

  // Pick the candidate with the smallest |Δt|. For ties, any order is fine.
  let best: (typeof candidates)[number] | null = null;
  let bestDelta = Infinity;

  for (const c of candidates) {
    const cat = c.exif?.captured_at;
    if (!cat) continue;
    let ct: Date;
    try {
      ct = new Date(cat);
      if (isNaN(ct.getTime())) continue;
    } catch {
      continue;
    }
    const delta = Math.abs(ct.getTime() - vt.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }

  if (!best) return null;
  return { donor: best as WithId<AssetDoc>, deltaMs: bestDelta };
}

export const auditVideoGeoBackfill: Migration = {
  id: 'audit-video-geo-backfill',
  title: 'Audit: video GPS backfill from temporal neighbours',
  description:
    'Report-only pass: for every live mp4/mov with no GPS and a captured_at timestamp, ' +
    'find the closest-in-time photo with GPS in the same library (within ±15 min) and ' +
    'record the decision (match / no-donor) in the `video_geo_backfill_audit` collection. ' +
    'Writes NOTHING to asset documents. Review the audit collection before enabling ' +
    '`apply-video-geo-backfill`. Operator runbook: enable apply only AFTER the geocode ' +
    'worker has resolved `place` for the newly GPS-tagged videos; otherwise refile-backups ' +
    'will stamp them with the placeless fallback path before geocode can run.',

  async countRemaining(): Promise<number> {
    const assets = await assetsCollection();
    const audit = await auditCollection();

    // Candidates still waiting = total candidates minus those already audited.
    const auditedIds = await audit.distinct('_id', {});
    const totalCandidates = await assets.countDocuments(candidateFilter());
    const auditedCandidates =
      auditedIds.length > 0
        ? await assets.countDocuments({
            ...candidateFilter(),
            _id: { $in: auditedIds },
          })
        : 0;

    return totalCandidates - auditedCandidates;
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const assets = await assetsCollection();
    const audit = await auditCollection();

    // Fetch ids already audited so we can exclude them.
    const auditedIds = await audit.distinct('_id', {});

    const docs = await assets
      .find(
        {
          ...candidateFilter(),
          ...(auditedIds.length > 0 ? { _id: { $nin: auditedIds } } : {}),
        },
        {
          projection: {
            _id: 1,
            maple_id: 1,
            fileinfo: 1,
            'exif.captured_at': 1,
          },
        },
      )
      .limit(batchSize)
      .toArray();

    // Log no-timestamp skips once per batch for visibility (these are NOT candidates).
    try {
      const noTimestampFilter: Filter<AssetDoc> = {
        'exif.gps': null,
        'exif.captured_at': null,
        fileinfo: {
          $elemMatch: {
            filename: { $regex: /\.(mp4|mov)$/i },
            deleted_at: { $in: [null] },
            missing_since: { $in: [null] },
          },
        },
      } as Filter<AssetDoc>;
      const noTimestampCount = await assets.countDocuments(noTimestampFilter);
      if (noTimestampCount > 0) {
        const sample = await assets
          .find(noTimestampFilter, { projection: { maple_id: 1 } })
          .limit(5)
          .toArray();
        log.info(
          { count: noTimestampCount, sample: sample.map((d) => d.maple_id) },
          'skip: no-timestamp (no captured_at anchor)',
        );
      }
    } catch {
      // best-effort — don't fail the batch over the diagnostic query
    }

    let processed = 0;
    let errors = 0;

    // Δt histogram buckets: <60 s, <5 min, <15 min, no-donor.
    const hist = { lt60s: 0, lt5m: 0, lt15m: 0, noDonor: 0 };

    for (const doc of docs) {
      try {
        const capturedAt = doc.exif?.captured_at;
        const primary = assetPrimaryFileInfo(doc);
        const now = new Date().toISOString();

        // The candidate filter should guarantee both, but if either is missing
        // (e.g. an empty-string timestamp, or no live fileinfo entry) record a
        // `skip` decision so the doc converges instead of head-of-line-blocking
        // the unsorted batch forever (the #1519 lesson).
        if (!capturedAt || !primary) {
          await audit.replaceOne(
            { _id: doc._id },
            {
              _id: doc._id,
              maple_id: doc.maple_id,
              captured_at: capturedAt ?? '',
              decision: 'skip',
              at: now,
            },
            { upsert: true },
          );
          processed++;
          continue;
        }

        const libraryId = primary.library_id;
        const result = await findDonor(assets, doc._id, capturedAt, libraryId);

        let auditDoc: AuditDoc;

        if (result) {
          const { donor, deltaMs } = result;
          const donorGps = donor.exif?.gps ?? undefined;

          auditDoc = {
            _id: doc._id,
            maple_id: doc.maple_id,
            captured_at: capturedAt,
            decision: 'match',
            donor_id: donor._id,
            donor_maple_id: donor.maple_id,
            donor_gps: donorGps,
            delta_ms: deltaMs,
            at: now,
          };

          log.info(
            {
              video_id: String(doc._id),
              maple_id: doc.maple_id,
              donor_id: String(donor._id),
              delta_ms: deltaMs,
            },
            'audit: match',
          );

          if (deltaMs < 60_000) hist.lt60s++;
          else if (deltaMs < 5 * 60_000) hist.lt5m++;
          else hist.lt15m++;
        } else {
          auditDoc = {
            _id: doc._id,
            maple_id: doc.maple_id,
            captured_at: capturedAt,
            decision: 'no-donor',
            at: now,
          };

          log.info(
            { video_id: String(doc._id), maple_id: doc.maple_id },
            'audit: no-donor within ±15 min in same library',
          );

          hist.noDonor++;
        }

        // Upsert — idempotent if the migration is re-run.
        await audit.replaceOne({ _id: doc._id }, auditDoc, { upsert: true });
        processed++;
      } catch (err) {
        errors++;
        log.error(
          {
            video_id: String(doc._id),
            err: err instanceof Error ? err.message : err,
          },
          'audit: error processing candidate',
        );
      }
    }

    // Log per-batch Δt histogram so an operator can see the quality distribution.
    if (docs.length > 0) {
      log.info(
        {
          batch: docs.length,
          hist_lt60s: hist.lt60s,
          hist_lt5m: hist.lt5m,
          hist_lt15m: hist.lt15m,
          hist_no_donor: hist.noDonor,
        },
        'audit: batch Δt histogram',
      );
    }

    return { processed, errors };
  },
};
