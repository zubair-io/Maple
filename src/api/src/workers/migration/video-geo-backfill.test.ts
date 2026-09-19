/**
 * The two video-GPS-backfill migrations.
 *
 * A video with no coordinates can borrow them from a photo taken within ±15
 * minutes in the same library. The audit pass records what it *would* do and
 * writes nothing to an asset; the apply pass does it, and an operator is meant
 * to read the first before enabling the second.
 *
 * Most of what follows is the donor rule and its exclusions, because that is
 * where a wrong answer puts a photo's location on someone else's video: the
 * closest donor in time wins, the window is inclusive at ±15 minutes, a donor
 * in another library does not count, another video does not count, and an asset
 * that itself borrowed its coordinates does not count — or inferred GPS would
 * daisy-chain.
 */

import { describe, it, expect } from 'bun:test';
import { applyVideoGeoBackfill } from './apply-video-geo-backfill.ts';
import { auditVideoGeoBackfill } from './audit-video-geo-backfill.ts';
import {
  auditCount,
  auditRow,
  createGeoFixture,
  geoInferredOf,
  gpsOf,
  photoAsset,
  videoAsset,
} from './video-geo-backfill.fixtures.ts';
import { stageRow, assetRow } from './migration.test-helpers.ts';

describe('audit-video-geo-backfill', () => {
  it('records a match for a candidate with a nearby donor, and writes nothing to the asset', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:35.000Z' });
    // Two minutes later — well within ±15 min.
    const photoId = photoAsset(fx, { capturedAt: '2019-05-18T17:47:35.000Z' });

    expect(await auditVideoGeoBackfill.countRemaining()).toBe(1);
    expect(await auditVideoGeoBackfill.runBatch(50)).toEqual({ processed: 1, errors: 0 });
    expect(await auditVideoGeoBackfill.countRemaining()).toBe(0);

    const verdict = auditRow(fx.db, videoId)!;
    expect(verdict.decision).toBe('match');
    expect(verdict.donor_id).toBe(photoId);
    expect({ lat: verdict.donor_lat, lng: verdict.donor_lng }).toEqual({
      lat: 37.7749,
      lng: -122.4194,
    });
    expect(verdict.delta_ms).toBe(2 * 60 * 1000);

    // The asset itself is untouched — that is what "report-only" means.
    expect(gpsOf(fx.db, videoId)).toBeNull();
    expect(geoInferredOf(fx.db, videoId)).toBeNull();
  });

  it('selects the closest donor when several photos are in the window', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    const nearId = photoAsset(fx, {
      capturedAt: '2019-05-18T17:46:00.000Z', // 1 min away
      gps: { lat: 10, lng: 20 },
    });
    photoAsset(fx, {
      capturedAt: '2019-05-18T17:55:00.000Z', // 10 min away
      gps: { lat: 50, lng: 60 },
    });

    await auditVideoGeoBackfill.runBatch(50);

    const verdict = auditRow(fx.db, videoId)!;
    expect(verdict.decision).toBe('match');
    expect(verdict.donor_id).toBe(nearId);
    expect({ lat: verdict.donor_lat, lng: verdict.donor_lng }).toEqual({ lat: 10, lng: 20 });
    expect(verdict.delta_ms).toBe(60_000);
  });

  it('rejects a donor just outside the ±15 min window', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    photoAsset(fx, { capturedAt: '2019-05-18T18:00:01.000Z' }); // 15 min + 1 s

    await auditVideoGeoBackfill.runBatch(50);

    expect(auditRow(fx.db, videoId)!.decision).toBe('no-donor');
  });

  it('accepts a donor at exactly the ±15 min boundary', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    photoAsset(fx, { capturedAt: '2019-05-18T18:00:00.000Z' }); // exactly 15 min

    await auditVideoGeoBackfill.runBatch(50);

    const verdict = auditRow(fx.db, videoId)!;
    expect(verdict.decision).toBe('match');
    expect(verdict.delta_ms).toBe(15 * 60 * 1000);
  });

  it('does NOT borrow from a GPS photo in a different library', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z', libraryId: fx.libA });
    photoAsset(fx, { capturedAt: '2019-05-18T17:46:00.000Z', libraryId: fx.libB });

    await auditVideoGeoBackfill.runBatch(50);

    expect(auditRow(fx.db, videoId)!.decision).toBe('no-donor');
  });

  it('does NOT borrow GPS from another video — donors must be photos', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    videoAsset(fx, {
      capturedAt: '2019-05-18T17:45:30.000Z',
      gps: { lat: 1, lng: 2 },
      filename: 'other.mov',
    });

    await auditVideoGeoBackfill.runBatch(50);

    expect(auditRow(fx.db, videoId)!.decision).toBe('no-donor');
  });

  it('does NOT borrow from an already-inferred asset, so GPS cannot daisy-chain', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    photoAsset(fx, {
      capturedAt: '2019-05-18T17:45:30.000Z',
      gps: { lat: 1, lng: 2 },
      geoInferred: {
        source: 'temporal-neighbor',
        donor_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        donor_delta_ms: 0,
        at: '2026-01-01T00:00:00.000Z',
      },
    });

    await auditVideoGeoBackfill.runBatch(50);

    expect(auditRow(fx.db, videoId)!.decision).toBe('no-donor');
  });

  it('is idempotent: a second pass records no new verdicts', async () => {
    using fx = await createGeoFixture();
    videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    photoAsset(fx, { capturedAt: '2019-05-18T17:46:00.000Z' });

    expect((await auditVideoGeoBackfill.runBatch(50)).processed).toBe(1);
    const afterFirst = auditCount(fx.db);

    expect((await auditVideoGeoBackfill.runBatch(50)).processed).toBe(0);
    expect(auditCount(fx.db)).toBe(afterFirst);
  });

  it('does not count a video with no capture time as a candidate', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: null });

    expect(await auditVideoGeoBackfill.countRemaining()).toBe(0);
    expect((await auditVideoGeoBackfill.runBatch(50)).processed).toBe(0);
    expect(auditRow(fx.db, videoId)).toBeNull();
  });

  it('skips a video whose only location is not live', async () => {
    using fx = await createGeoFixture();
    videoAsset(fx, { deletedAt: '2024-01-01T00:00:00.000Z' });

    expect(await auditVideoGeoBackfill.countRemaining()).toBe(0);
  });
});

describe('apply-video-geo-backfill', () => {
  it('sets GPS and provenance, re-arms geocode, and clears the refile marker', async () => {
    using fx = await createGeoFixture();
    const gps = { lat: 37.7749, lng: -122.4194 };
    const videoId = videoAsset(fx, {
      capturedAt: '2019-05-18T17:45:35.000Z',
      backupLayoutVersion: 4,
    });
    const photoId = photoAsset(fx, { capturedAt: '2019-05-18T17:47:00.000Z', gps }); // 1m25s away

    expect(await applyVideoGeoBackfill.countRemaining()).toBe(1);
    expect(await applyVideoGeoBackfill.runBatch(50)).toEqual({ processed: 1, errors: 0 });
    expect(await applyVideoGeoBackfill.countRemaining()).toBe(0);

    expect(gpsOf(fx.db, videoId)).toEqual(gps);

    const provenance = geoInferredOf(fx.db, videoId)!;
    expect(provenance.source).toBe('temporal-neighbor');
    expect(provenance.donor_id).toBe(photoId);
    expect(provenance.donor_delta_ms).toBe(85_000); // 1m25s

    // Geocode back to unprocessed, so a place resolves for the newly-tagged video.
    expect(stageRow(fx.db, videoId, 'geocode')).toEqual({
      version: 0,
      attempts: 0,
      last_error: null,
      dead: 0,
    });
    // And the refile marker cleared, so the backup is re-filed under that place.
    expect(assetRow(fx.db, videoId)!.backup_layout_version).toBeNull();
  });

  it('is idempotent: once GPS is set the video leaves the candidate set', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    photoAsset(fx, { capturedAt: '2019-05-18T17:46:00.000Z' });

    expect((await applyVideoGeoBackfill.runBatch(50)).processed).toBe(1);
    expect(await applyVideoGeoBackfill.countRemaining()).toBe(0);
    expect(await applyVideoGeoBackfill.runBatch(50)).toEqual({ processed: 0, errors: 0 });
    expect(geoInferredOf(fx.db, videoId)!.source).toBe('temporal-neighbor');
  });

  it('parks a video with no donor behind a sentinel so it cannot block the queue', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });

    expect(await applyVideoGeoBackfill.countRemaining()).toBe(1);
    expect(await applyVideoGeoBackfill.runBatch(50)).toEqual({ processed: 1, errors: 0 });

    expect(gpsOf(fx.db, videoId)).toBeNull();
    expect(assetRow(fx.db, videoId)!.geo_backfill_skipped).toBe('no-donor');
    expect(await applyVideoGeoBackfill.countRemaining()).toBe(0);
  });

  it('does NOT borrow GPS from a photo in a different library', async () => {
    using fx = await createGeoFixture();
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z', libraryId: fx.libA });
    photoAsset(fx, { capturedAt: '2019-05-18T17:46:00.000Z', libraryId: fx.libB });

    await applyVideoGeoBackfill.runBatch(50);

    expect(gpsOf(fx.db, videoId)).toBeNull();
    expect(assetRow(fx.db, videoId)!.geo_backfill_skipped).toBe('no-donor');
  });

  it('uses the closest donor, not just any donor', async () => {
    using fx = await createGeoFixture();
    const nearGps = { lat: 10, lng: 20 };
    const videoId = videoAsset(fx, { capturedAt: '2019-05-18T17:45:00.000Z' });
    const nearId = photoAsset(fx, { capturedAt: '2019-05-18T17:46:00.000Z', gps: nearGps });
    photoAsset(fx, { capturedAt: '2019-05-18T17:55:00.000Z', gps: { lat: 50, lng: 60 } });

    await applyVideoGeoBackfill.runBatch(50);

    expect(gpsOf(fx.db, videoId)).toEqual(nearGps);
    expect(geoInferredOf(fx.db, videoId)!.donor_id).toBe(nearId);
  });
});
