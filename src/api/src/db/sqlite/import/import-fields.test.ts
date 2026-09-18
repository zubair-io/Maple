/**
 * Field-level comparison between the source asset documents and the rows they
 * became (#3744).
 *
 * The counts in `import.test.ts` prove nothing was lost in bulk. These prove
 * the values are right: the JSON payloads survive with their nested
 * identifiers converted, the generated columns the facets depend on read what
 * they should, and the nested arrays keep the positions that are on the wire.
 * The detail payloads and the rest of the library are in
 * `import-collections.test.ts`.
 *
 * Every expectation is written against the source document directly rather
 * than against the mapper's own output, so a mapper that is confidently wrong
 * fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { importedFixture, type ImportedFixture } from './fixture.test-helpers.ts';
import { EXIF, PLACE, iso } from './seed-fixtures.test-helpers.ts';

const fixture: ImportedFixture = importedFixture(`maple_import_fields_${process.pid}`);
const { one, all } = fixture;

beforeAll(fixture.setUp, 60_000);
afterAll(fixture.tearDown);

describe('asset scalars and JSON payloads', () => {
  it('stores exif verbatim and exposes it through the generated columns', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{
      exif: string;
      captured_at: string;
      captured_year: number;
      camera_make: string;
      camera_serial: string;
      lens: string;
      iso: number;
      gps_lat: number;
      gps_lng: number;
    }>(
      `SELECT exif, captured_at, captured_year, camera_make, camera_serial, lens, iso,
              gps_lat, gps_lng
         FROM assets WHERE id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.exif)).toEqual(EXIF);
    expect(row.captured_at).toBe(EXIF.captured_at);
    expect(row.captured_year).toBe(2026);
    expect(row.camera_make).toBe('Hasselblad');
    expect(row.camera_serial).toBe('SN-0001');
    expect(row.lens).toBe(EXIF.lens);
    expect(row.iso).toBe(200);
    expect(row.gps_lat).toBeCloseTo(42.6526, 6);
    expect(row.gps_lng).toBeCloseTo(-73.7562, 6);
  });

  it('stores place verbatim, including the rollups the facets group on', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{
      place: string;
      place_country_code: string;
      place_region: string;
      place_locality: string;
      geocoder_version: number;
    }>(
      `SELECT place, place_country_code, place_region, place_locality, geocoder_version
         FROM assets WHERE id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.place)).toEqual(PLACE);
    expect(row.place_country_code).toBe('us');
    expect(row.place_region).toBe('New York');
    expect(row.place_locality).toBe('Albany');
    expect(row.geocoder_version).toBe(3);
  });

  it('flattens the damaged subdocument into its three columns', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{
      damaged_since: string;
      damaged_stage: string;
      damaged_reason: string;
      hidden: number;
      hidden_reason: string;
      hidden_ack: number;
    }>(
      `SELECT damaged_since, damaged_stage, damaged_reason, hidden, hidden_reason, hidden_ack
         FROM assets WHERE id = ?`,
      ids.assets.damaged.toHexString(),
    );
    expect(row.damaged_since).toBe(iso(8));
    expect(row.damaged_stage).toBe('exif');
    expect(row.damaged_reason).toBe('truncated file');
    expect(row.hidden).toBe(1);
    expect(row.hidden_reason).toBe('nudity');
    expect(row.hidden_ack).toBe(0);
  });

  it('substitutes for a legacy row with no indexed_at and no media_kind', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const id = ids.assets.legacy.toHexString();
    const row = one<{ indexed_at: string; media_kind: string; color_label: string }>(
      `SELECT indexed_at, media_kind, color_label FROM assets WHERE id = ?`,
      id,
    );
    // The ObjectId's own timestamp — the closest true answer available.
    const fromId = new Date(Number.parseInt(id.slice(0, 8), 16) * 1000).toISOString();
    expect(row.indexed_at).toBe(fromId);
    expect(row.media_kind).toBe('image');
    expect(row.color_label).toBe('');
  });

  it('clamps a rating outside the destination CHECK range', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{ rating: number }>(
      `SELECT rating FROM assets WHERE id = ?`,
      ids.assets.orphanLocation.toHexString(),
    );
    expect(row.rating).toBe(5);
  });

  it('keeps the soft-delete marker and its reason', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{ deleted_at: string; deleted_reason: string; flag: number }>(
      `SELECT deleted_at, deleted_reason, flag FROM assets WHERE id = ?`,
      ids.assets.trashed.toHexString(),
    );
    expect(row.deleted_at).toBe(iso(7));
    expect(row.deleted_reason).toBe('reaped');
    expect(row.flag).toBe(-1);
  });
});

interface FaceRow {
  face_index: number;
  person_id: string | null;
  confidence: number;
  bbox_x: number;
  bbox_h: number;
  hidden: number;
  landmarks: string | null;
  embedding: string | null;
  embedding_version: string | null;
}

describe('the nested arrays', () => {
  it('keeps the fileinfo array position as the location ordinal', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = all<{
      ordinal: number;
      library_id: string;
      path: string;
      filename: string;
      missing_since: string | null;
      missing_reason: string | null;
    }>(
      `SELECT ordinal, library_id, path, filename, missing_since, missing_reason
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
      ids.assets.multiLocation.toHexString(),
    );
    expect(rows).toEqual([
      {
        ordinal: 0,
        library_id: ids.libraryA.toHexString(),
        path: '',
        filename: 'IMG_0002.dng',
        missing_since: null,
        missing_reason: null,
      },
      {
        ordinal: 1,
        library_id: ids.libraryB.toHexString(),
        path: 'archive',
        filename: 'IMG_0002.dng',
        missing_since: iso(6),
        missing_reason: 'watch-removed',
      },
    ]);
  });

  it('keeps the faces array position, which is on the wire', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = all<FaceRow>(
      `SELECT face_index, person_id, confidence, bbox_x, bbox_h, hidden,
              landmarks, embedding, embedding_version
         FROM faces WHERE asset_id = ? ORDER BY face_index`,
      ids.assets.rich.toHexString(),
    );
    expect(rows).toHaveLength(2);

    // Compared as one object so a shifted `face_index` — which would renumber
    // every face a person is tagged in — shows up as a whole-row diff rather
    // than as one assertion among a dozen.
    expect({ ...rows[0], landmarks: null, embedding: null }).toEqual({
      face_index: 0,
      person_id: ids.person.toHexString(),
      confidence: 0.97,
      bbox_x: 0.11,
      bbox_h: 0.44,
      hidden: 0,
      landmarks: null,
      embedding: null,
      embedding_version: 'arcface_r100_glint360k_v1',
    });
    expect(JSON.parse(String(rows[0]?.landmarks))).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.1 },
    ]);
    expect(JSON.parse(String(rows[0]?.embedding))).toEqual([0.01, -0.02, 0.03]);

    expect({ ...rows[1], bbox_x: 0.5, bbox_h: 0.1 }).toEqual({
      face_index: 1,
      person_id: null,
      confidence: 0.61,
      bbox_x: 0.5,
      bbox_h: 0.1,
      hidden: 1,
      landmarks: null,
      embedding: null,
      embedding_version: null,
    });
  });

  it('collapses a duplicated Apple Photos link the array allowed', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = all<{
      device_id: string;
      phasset_local_id: string;
      phasset_cloud_id: string | null;
      first_seen: string;
    }>(
      `SELECT device_id, phasset_local_id, phasset_cloud_id, first_seen
         FROM asset_phasset_links WHERE asset_id = ? ORDER BY device_id`,
      ids.assets.rich.toHexString(),
    );
    expect(rows).toEqual([
      {
        device_id: 'device-a',
        phasset_local_id: 'LOCAL-1/L0/001',
        phasset_cloud_id: 'CLOUD-1',
        first_seen: '2026-01-02T00:00:00.000Z',
      },
      {
        device_id: 'device-b',
        phasset_local_id: 'LOCAL-2/L0/001',
        phasset_cloud_id: null,
        first_seen: '2026-01-03T00:00:00.000Z',
      },
    ]);
  });

  it('moves the stage subdocuments into rows, converting their dates', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = all<{
      stage: string;
      version: number;
      attempts: number;
      last_error: string | null;
      processed_at: string | null;
      dead: number;
      failed_at: string | null;
      next_attempt_at: string | null;
    }>(
      `SELECT stage, version, attempts, last_error, processed_at, dead, failed_at,
              next_attempt_at
         FROM stage_state WHERE asset_id = ? AND stage IN ('exif', 'describe', 'thumb')
         ORDER BY stage`,
      ids.assets.rich.toHexString(),
    );
    expect(rows).toEqual([
      {
        stage: 'describe',
        version: 8,
        attempts: 2,
        last_error: 'timeout',
        processed_at: '2026-01-03T00:00:00.000Z',
        dead: 1,
        failed_at: '2026-01-03T01:00:00.000Z',
        next_attempt_at: '2026-01-03T02:00:00.000Z',
      },
      {
        stage: 'exif',
        version: 3,
        attempts: 0,
        last_error: null,
        processed_at: '2026-01-02T00:00:00.000Z',
        dead: 0,
        failed_at: null,
        next_attempt_at: null,
      },
      {
        stage: 'thumb',
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: 0,
        failed_at: null,
        next_attempt_at: null,
      },
    ]);
  });

  it('seeds a stage row even for an asset that never carried the subdocument', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ? AND version = 0`,
      ids.assets.legacy.toHexString(),
    );
    expect(rows[0]?.n).toBe(12);
  });

  it('splits the enrichment subdocument into its three rows', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = all<{ stage: string; done_at: string | null; attempts: number }>(
      `SELECT stage, done_at, attempts FROM enrichment_state WHERE asset_id = ? ORDER BY stage`,
      ids.assets.rich.toHexString(),
    );
    expect(rows.map((row) => row.stage)).toEqual(['describe', 'face', 'geocode']);
    expect(rows.every((row) => row.done_at === null && row.attempts === 0)).toBe(true);
  });
});
