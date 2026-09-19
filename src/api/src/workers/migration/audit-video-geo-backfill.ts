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

import type { ObjectId } from 'mongodb';
import { countCandidates, listCandidates } from '../../db/sqlite/repos/assets.migrations.ts';
import {
  findGeoDonors,
  GEO_AUDIT_SCOPE,
  GEO_NO_TIMESTAMP_SCOPE,
  type GeoDonor,
} from '../../db/sqlite/repos/assets.video-migrations.ts';
import { recordAuditDecision } from '../../db/sqlite/repos/video-geo-audit.repo.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:geo-backfill');

/** ±15 minutes in milliseconds. */
const WINDOW_MS = 15 * 60 * 1000;

/** Shape of one audit row written to `video_geo_backfill_audit`. */
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

/**
 * Find the closest-in-time donor: any live photo with GPS in the same library
 * within ±15 min of the video's capture time.
 *
 * The range is on the stored capture timestamp, which is a 24-character UTC ISO
 * string — so lexicographic comparison is chronological order, and the query is
 * a seek on the `assets_gps_captured` partial index rather than a scan.
 *
 * Guards against malformed / non-Z timestamps by wrapping Date parsing in a
 * try/catch and skipping any candidate whose date cannot be parsed. That is why
 * the winner is chosen here rather than by `ORDER BY` in SQL: a timestamp that
 * will not parse has to be skipped, not sorted.
 */
export async function findDonor(
  videoId: ObjectId,
  capturedAt: string,
  libraryId: ObjectId,
): Promise<{ donor: GeoDonor; deltaMs: number } | null> {
  let vt: Date;
  try {
    vt = new Date(capturedAt);
    if (isNaN(vt.getTime())) return null;
  } catch {
    return null;
  }

  const lo = new Date(vt.getTime() - WINDOW_MS).toISOString();
  const hi = new Date(vt.getTime() + WINDOW_MS).toISOString();
  const candidates = await findGeoDonors(videoId, libraryId, lo, hi);
  if (candidates.length === 0) return null;

  // Pick the candidate with the smallest |Δt|. For ties, any order is fine.
  let best: GeoDonor | null = null;
  let bestDelta = Infinity;

  for (const c of candidates) {
    const cat = c.captured_at;
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
  return { donor: best, deltaMs: bestDelta };
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

  countRemaining(): Promise<number> {
    // Candidates still waiting are the ones with no verdict row yet, which the
    // scope expresses as a `NOT EXISTS` join. The Mongo version could only
    // approximate it by counting all candidates and subtracting a second count
    // restricted to an `$in` of every audited id.
    return countCandidates(GEO_AUDIT_SCOPE);
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const docs = await listCandidates(GEO_AUDIT_SCOPE, batchSize);

    // Log no-timestamp skips once per batch for visibility (these are NOT candidates).
    try {
      const noTimestampCount = await countCandidates(GEO_NO_TIMESTAMP_SCOPE);
      if (noTimestampCount > 0) {
        const sample = await listCandidates(GEO_NO_TIMESTAMP_SCOPE, 5);
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
          await recordAuditDecision(doc.id, {
            maple_id: doc.maple_id,
            captured_at: capturedAt ?? '',
            decision: 'skip',
            at: now,
          });
          processed++;
          continue;
        }

        const libraryId = primary.library_id;
        const result = await findDonor(doc.id, capturedAt, libraryId);

        let decision: Omit<AuditDoc, '_id'>;

        if (result) {
          const { donor, deltaMs } = result;

          decision = {
            maple_id: doc.maple_id,
            captured_at: capturedAt,
            decision: 'match',
            donor_id: donor.id,
            donor_maple_id: donor.maple_id,
            donor_gps: donor.gps,
            delta_ms: deltaMs,
            at: now,
          };

          log.info(
            {
              video_id: String(doc.id),
              maple_id: doc.maple_id,
              donor_id: String(donor.id),
              delta_ms: deltaMs,
            },
            'audit: match',
          );

          if (deltaMs < 60_000) hist.lt60s++;
          else if (deltaMs < 5 * 60_000) hist.lt5m++;
          else hist.lt15m++;
        } else {
          decision = {
            maple_id: doc.maple_id,
            captured_at: capturedAt,
            decision: 'no-donor',
            at: now,
          };

          log.info(
            { video_id: String(doc.id), maple_id: doc.maple_id },
            'audit: no-donor within ±15 min in same library',
          );

          hist.noDonor++;
        }

        // Keyed by the video, so a re-run overwrites rather than appending.
        await recordAuditDecision(doc.id, decision);
        processed++;
      } catch (err) {
        errors++;
        log.error(
          {
            video_id: String(doc.id),
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
