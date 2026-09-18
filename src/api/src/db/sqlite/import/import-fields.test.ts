/**
 * Field-level comparison between the source documents and the imported rows
 * (#3744).
 *
 * The counts in `import.test.ts` prove nothing was lost in bulk. These prove
 * the values are right: the nested arrays keep their positions, the JSON
 * payloads survive with their nested identifiers converted, BSON dates become
 * ISO strings, a passkey's binary public key round-trips as bytes, and the two
 * fields whose names differ between the engines land in the right columns.
 *
 * Every expectation is written against the source document directly rather than
 * against the mapper's own output, so a mapper that is confidently wrong fails
 * here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';
import { closeImportSession, openImportSession, runImportOn, type ImportOptions } from './index.ts';
import {
  connectTestMongo,
  seedLibrary,
  TEST_MONGO_URI,
  type SeedIds,
} from './seed.test-helpers.ts';
import { EXIF, PLACE, iso, visionDoc } from './seed-fixtures.test-helpers.ts';

const DB_NAME = `maple_import_fields_${process.pid}`;

let client: MongoClient | null = null;
let ids: SeedIds | null = null;
let sqlitePath = '';
let workDir = '';

function open(): Database {
  return new Database(sqlitePath, { readonly: true });
}

function one<T>(sql: string, ...params: Array<string | number>): T {
  const db = open();
  const row = db.query(sql).get(...params) as T;
  db.close();
  return row;
}

function all<T>(sql: string, ...params: Array<string | number>): T[] {
  const db = open();
  const rows = db.query(sql).all(...params) as T[];
  db.close();
  return rows;
}

beforeAll(async () => {
  client = await connectTestMongo();
  if (client === null) return;
  await client.db(DB_NAME).dropDatabase();
  ids = await seedLibrary(client.db(DB_NAME));

  workDir = mkdtempSync(join(tmpdir(), 'maple-import-fields-'));
  sqlitePath = join(workDir, 'maple.db');
  const options: ImportOptions = {
    mongoUri: TEST_MONGO_URI,
    mongoDb: DB_NAME,
    sqlitePath,
    batchSize: 10,
    changesWindow: 'all',
    verifySample: 10,
    restart: true,
  };
  const session = await openImportSession(options);
  try {
    await runImportOn(session, options);
  } finally {
    await closeImportSession(session);
  }
}, 60_000);

afterAll(async () => {
  if (client !== null) {
    await client.db(DB_NAME).dropDatabase();
    await client.close();
  }
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

describe('asset scalars and JSON payloads', () => {
  it('stores exif verbatim and exposes it through the generated columns', () => {
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
    if (client === null || ids === null) return;
    const row = one<{ rating: number }>(
      `SELECT rating FROM assets WHERE id = ?`,
      ids.assets.orphanLocation.toHexString(),
    );
    expect(row.rating).toBe(5);
  });

  it('keeps the soft-delete marker and its reason', () => {
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

describe('the nested arrays', () => {
  it('keeps the fileinfo array position as the location ordinal', () => {
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
    if (client === null || ids === null) return;
    const rows = all<{
      face_index: number;
      person_id: string | null;
      confidence: number;
      bbox_x: number;
      bbox_h: number;
      hidden: number;
      landmarks: string | null;
      embedding: string | null;
      embedding_version: string | null;
    }>(
      `SELECT face_index, person_id, confidence, bbox_x, bbox_h, hidden,
              landmarks, embedding, embedding_version
         FROM faces WHERE asset_id = ? ORDER BY face_index`,
      ids.assets.rich.toHexString(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.face_index).toBe(0);
    expect(rows[0]?.person_id).toBe(ids.person.toHexString());
    expect(rows[0]?.confidence).toBeCloseTo(0.97, 6);
    expect(rows[0]?.bbox_x).toBeCloseTo(0.11, 6);
    expect(rows[0]?.bbox_h).toBeCloseTo(0.44, 6);
    expect(JSON.parse(rows[0]?.landmarks ?? 'null')).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.1 },
    ]);
    expect(JSON.parse(rows[0]?.embedding ?? 'null')).toEqual([0.01, -0.02, 0.03]);
    expect(rows[0]?.embedding_version).toBe('arcface_r100_glint360k_v1');
    expect(rows[1]?.face_index).toBe(1);
    expect(rows[1]?.person_id).toBeNull();
    expect(rows[1]?.hidden).toBe(1);
  });

  it('collapses a duplicated Apple Photos link the array allowed', () => {
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
    if (client === null || ids === null) return;
    const rows = all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ? AND version = 0`,
      ids.assets.legacy.toHexString(),
    );
    expect(rows[0]?.n).toBe(12);
  });

  it('splits the enrichment subdocument into its three rows', () => {
    if (client === null || ids === null) return;
    const rows = all<{ stage: string; done_at: string | null; attempts: number }>(
      `SELECT stage, done_at, attempts FROM enrichment_state WHERE asset_id = ? ORDER BY stage`,
      ids.assets.rich.toHexString(),
    );
    expect(rows.map((row) => row.stage)).toEqual(['describe', 'face', 'geocode']);
    expect(rows.every((row) => row.done_at === null && row.attempts === 0)).toBe(true);
  });
});

describe('the detail payloads', () => {
  it('stores vision whole and exposes the two facet paths', () => {
    if (client === null || ids === null) return;
    const row = one<{
      vision: string;
      vision_scene_type: string;
      vision_activity: string;
      ocr_text: string;
      description: string;
      transcript: string;
      metadata_override: string;
      derivative_audit: string;
      geo_inferred: string;
    }>(
      `SELECT vision, vision_scene_type, vision_activity, ocr_text, description, transcript,
              metadata_override, derivative_audit, geo_inferred
         FROM asset_detail WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.vision)).toEqual(visionDoc());
    expect(row.vision_scene_type).toBe('outdoor');
    expect(row.vision_activity).toBe('running');
    expect(row.ocr_text).toBe('ÉLAN — 12 °C\nline two');
    expect(row.description).toBe('A child in a red coat runs across a frozen field.');
    expect(JSON.parse(row.transcript)).toEqual({
      text: 'hello world',
      segments: [{ start: 0, end: 1.5, text: 'hello world' }],
      language: 'en',
      model: 'whisper',
      duration_sec: 1.5,
      generated_at: iso(3),
    });
    expect(JSON.parse(row.metadata_override)).toEqual({
      edited_at: iso(4),
      touched_fields: ['title', 'keywords'],
      title: 'Frozen field',
      keywords: ['winter', 'child'],
    });
    expect(JSON.parse(row.derivative_audit)).toEqual({
      thumb: { attempts: 1, last_reset_at: iso(4) },
    });
  });

  it('converts an ObjectId nested inside a JSON payload to its hex', () => {
    if (client === null || ids === null) return;
    const row = one<{ geo_inferred: string }>(
      `SELECT geo_inferred FROM asset_detail WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.geo_inferred)).toEqual({
      source: 'temporal-neighbor',
      donor_id: ids.assets.multiLocation.toHexString(),
      donor_delta_ms: 42_000,
      at: iso(4),
    });
  });

  it('moves the search blob to its own table', () => {
    if (client === null || ids === null) return;
    const row = one<{ search_blob: string }>(
      `SELECT search_blob FROM asset_search WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(row.search_blob).toBe('Albany New York child red coat frozen field');
  });
});

describe('the rest of the library', () => {
  it('flattens the person cover bbox and converts the merge references', () => {
    if (client === null || ids === null) return;
    const row = one<{
      name: string;
      cover_asset_id: string;
      cover_bbox_x: number;
      cover_bbox_h: number;
      centroid: string;
      suggested_merge_person_id: string;
      suggested_merges: string;
      face_count: number;
    }>(
      `SELECT name, cover_asset_id, cover_bbox_x, cover_bbox_h, centroid,
              suggested_merge_person_id, suggested_merges, face_count
         FROM people WHERE id = ?`,
      ids.person.toHexString(),
    );
    expect(row.name).toBe('Alice Example');
    expect(row.cover_asset_id).toBe(ids.assets.rich.toHexString());
    expect(row.cover_bbox_x).toBeCloseTo(0.1, 6);
    expect(row.cover_bbox_h).toBeCloseTo(0.4, 6);
    expect(JSON.parse(row.centroid)).toEqual([0.1, 0.2, 0.3]);
    expect(row.suggested_merge_person_id).toBe(ids.mergedPerson.toHexString());
    expect(JSON.parse(row.suggested_merges)).toEqual([
      { person_id: ids.mergedPerson.toHexString(), score: 0.91 },
    ]);
    expect(row.face_count).toBe(2);
  });

  it('keeps a folder mirror list as JSON', () => {
    if (client === null || ids === null) return;
    const row = one<{ mirrors: string; slug: string; file_count: number }>(
      `SELECT mirrors, slug, file_count FROM folders WHERE id = ?`,
      ids.libraryA.toHexString(),
    );
    expect(JSON.parse(row.mirrors)).toEqual([{ path: '/mirrors/a', enabled: true }]);
    expect(row.slug).toBe('library-a');
    expect(row.file_count).toBe(5);
  });

  it('renames worker_config.maxAttempts to max_attempts', () => {
    if (client === null) return;
    const row = one<{
      concurrency: number;
      max_attempts: number;
      paused: number;
      pause_reason: string;
      last_seen_target_version: number;
    }>(
      `SELECT concurrency, max_attempts, paused, pause_reason, last_seen_target_version
         FROM worker_config WHERE name = 'describe'`,
    );
    expect(row.concurrency).toBe(2);
    expect(row.max_attempts).toBe(1);
    expect(row.paused).toBe(1);
    expect(row.pause_reason).toBe('no model');
    expect(row.last_seen_target_version).toBe(8);
  });

  it('flattens the job and import progress subdocuments into columns', () => {
    if (client === null || ids === null) return;
    const job = one<{ progress_current: number; progress_total: number; params: string }>(
      `SELECT progress_current, progress_total, params FROM jobs LIMIT 1`,
    );
    expect(job.progress_current).toBe(1);
    expect(job.progress_total).toBe(1);
    expect(JSON.parse(job.params)).toEqual({ asset_ids: [ids.assets.rich.toHexString()] });

    const imported = one<{ count_copied: number; count_skipped: number; count_failed: number }>(
      `SELECT count_copied, count_skipped, count_failed FROM imports WHERE id = ?`,
      ids.importJob.toHexString(),
    );
    expect(imported).toEqual({ count_copied: 2, count_skipped: 0, count_failed: 0 });
  });

  it('round-trips a passkey public key as bytes, not as text', () => {
    if (client === null) return;
    const row = one<{ public_key: Uint8Array; transports: string; counter: number }>(
      `SELECT public_key, transports, counter FROM credentials LIMIT 1`,
    );
    expect(Array.from(row.public_key)).toEqual([1, 2, 3, 4, 250]);
    expect(JSON.parse(row.transports)).toEqual(['internal', 'hybrid']);
    expect(row.counter).toBe(7);
  });

  it('turns the TTL dates into the ISO strings the expiry sweep reads', () => {
    if (client === null) return;
    const invite = one<{ expires_at: string; code: string }>(
      `SELECT expires_at, code FROM invites LIMIT 1`,
    );
    expect(invite.expires_at).toBe('2026-02-01T00:00:00.000Z');
    expect(invite.code).toBe('ABCD2345');

    const refresh = one<{ expires_at: string; platform: string; secure: number }>(
      `SELECT expires_at, platform, secure FROM refresh_tokens LIMIT 1`,
    );
    expect(refresh.expires_at).toBe('2026-03-01T00:00:00.000Z');
    expect(refresh.platform).toBe('tvos');
    expect(refresh.secure).toBe(0);
  });

  it('derives an expiry for an upload session that relied on the TTL monitor', () => {
    if (client === null) return;
    const row = one<{ created_at: string; expires_at: string; state: string }>(
      `SELECT created_at, expires_at, state FROM upload_sessions LIMIT 1`,
    );
    expect(row.created_at).toBe('2026-01-05T00:00:00.000Z');
    expect(row.expires_at).toBe('2026-01-12T00:00:00.000Z');
    expect(row.state).toBe('open');
  });

  it('keeps the geocode cache under its quantised string key', () => {
    if (client === null) return;
    const row = one<{ id: string; place: string; fetched_at: string }>(
      `SELECT id, place, fetched_at FROM geocode_cache LIMIT 1`,
    );
    expect(row.id).toBe('lat:42.6526,lon:-73.7562');
    expect(JSON.parse(row.place)).toEqual(PLACE);
    expect(row.fetched_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps a preset extra bag for keys this version does not understand', () => {
    if (client === null) return;
    const row = one<{ fields: string; extra: string }>(`SELECT fields, extra FROM presets LIMIT 1`);
    expect(JSON.parse(row.fields)).toEqual({ exposure: 0.25, contrast: 12 });
    expect(JSON.parse(row.extra)).toEqual({ unknown_future_key: true });
  });
});
