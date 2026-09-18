/**
 * The seeded asset documents.
 *
 * Six of them, and each one is a shape the importer has to handle rather than a
 * variation on the happy path:
 *
 *  - `rich` carries everything at once: a location, two faces (one assigned,
 *    one hidden and unassigned), three Apple Photos links of which two are the
 *    same pair, a full vision payload, a transcript, a metadata override, a
 *    derivative-audit mark and a `geo_inferred` block with an `ObjectId` nested
 *    inside a JSON payload;
 *  - `multiLocation` has two locations, the second tagged missing, so
 *    `live_location_count` has to come out as 1 rather than 2;
 *  - `legacy` predates `fileinfo`, `stages`, `indexed_at` and `media_kind`, all
 *    of which are NOT NULL or densely seeded on the destination;
 *  - `trashed` is soft-deleted by the reaper;
 *  - `damaged` carries the damaged tag plus two retired stage names;
 *  - `orphanLocation` has a location under a library root that was never
 *    registered, plus a rating outside the destination's CHECK range.
 */

import type { Db } from 'mongodb';
import {
  EXIF,
  PLACE,
  iso,
  pendingEnrichment,
  stageSkeleton,
  visionDoc,
  type SeedIds,
} from './seed-fixtures.test-helpers.ts';

function richAsset(ids: SeedIds): Record<string, unknown> {
  return {
    _id: ids.assets.rich,
    fileinfo: [
      { path: 'vacation/2026', filename: 'IMG_0001.dng', library_id: ids.libraryA, keep: true },
    ],
    size: 104_857_600,
    mtime: 1_767_225_600_000,
    rating: 4,
    flag: 1,
    color_label: 'green',
    exif: EXIF,
    place: PLACE,
    indexed_at: iso(1),
    enrichment: pendingEnrichment(),
    stages: {
      ...stageSkeleton(),
      exif: {
        version: 3,
        attempts: 0,
        last_error: null,
        processed_at: new Date(Date.UTC(2026, 0, 2)),
        dead: false,
      },
      describe: {
        version: 8,
        attempts: 2,
        last_error: 'timeout',
        processed_at: new Date(Date.UTC(2026, 0, 3)),
        dead: true,
        failed_at: new Date(Date.UTC(2026, 0, 3, 1)),
        next_attempt_at: new Date(Date.UTC(2026, 0, 3, 2)),
      },
    },
    faces: [
      {
        bbox: { x: 0.11, y: 0.22, w: 0.33, h: 0.44 },
        person_id: ids.person.toHexString(),
        confidence: 0.97,
        landmarks: [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.1 },
        ],
        embedding: [0.01, -0.02, 0.03],
        embedding_version: 'arcface_r100_glint360k_v1',
      },
      {
        bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
        person_id: null,
        confidence: 0.61,
        hidden: true,
      },
      // Assigned to a person who is no longer in the collection. The column's
      // own ON DELETE SET NULL says this becomes null, and the repair pass is
      // what makes that true.
      {
        bbox: { x: 0.7, y: 0.7, w: 0.05, h: 0.05 },
        person_id: '0'.repeat(24),
        confidence: 0.55,
      },
    ],
    phasset_links: [
      {
        device_id: 'device-a',
        phasset_local_id: 'LOCAL-1/L0/001',
        phasset_cloud_id: 'CLOUD-1',
        first_seen: new Date(Date.UTC(2026, 0, 2)),
      },
      {
        device_id: 'device-b',
        phasset_local_id: 'LOCAL-2/L0/001',
        first_seen: new Date(Date.UTC(2026, 0, 3)),
      },
      // Duplicate of the first pair: the destination's UNIQUE constraint is
      // stronger than the array was, so one row is the right answer.
      {
        device_id: 'device-a',
        phasset_local_id: 'LOCAL-1/L0/001',
        first_seen: new Date(Date.UTC(2026, 0, 4)),
      },
    ],
    description: 'A child in a red coat runs across a frozen field.',
    // Written by the describe stage but absent from the `AssetDoc` interface,
    // which is precisely why the importer dropped it until a review caught it.
    description_meta: {
      provider: 'ollama',
      model: 'qwen2.5-vl',
      prompt_version: 7,
      generated_at: iso(3),
      cost_usd: 0,
    },
    vision: visionDoc(),
    vision_meta: {
      provider: 'ollama',
      model: 'qwen2.5-vl',
      prompt_version: 7,
      generated_at: iso(3),
      raw_response_size: 2048,
    },
    ocr_text: 'ÉLAN — 12 °C\nline two',
    ocr_meta: {
      engine: 'qwen2.5-vl',
      engine_version: '1.0',
      generated_at: iso(3),
      mean_confidence: null,
    },
    transcript: {
      text: 'hello world',
      segments: [{ start: 0, end: 1.5, text: 'hello world' }],
      language: 'en',
      model: 'whisper',
      duration_sec: 1.5,
      generated_at: iso(3),
    },
    metadata_override: {
      edited_at: iso(4),
      touched_fields: ['title', 'keywords'],
      title: 'Frozen field',
      keywords: ['winter', 'child'],
    },
    derivative_audit: { thumb: { attempts: 1, last_reset_at: iso(4) } },
    // A nested ObjectId inside a JSON payload — it has to land as hex.
    geo_inferred: {
      source: 'temporal-neighbor',
      donor_id: ids.assets.multiLocation,
      donor_delta_ms: 42_000,
      at: iso(4),
    },
    search_blob: 'Albany New York child red coat frozen field',
    semantic_vector_fingerprint: 'embedder-v3',
    maple_id: 'maple-rich-0001',
    sha1_head: 'a'.repeat(40),
    media_kind: 'image',
    has_xmp: true,
    sidecar_ver: 3,
    is_screenshot: false,
    live_location_count: 1,
  };
}

/** Inserts every seeded asset. */
export async function seedAssets(db: Db, ids: SeedIds): Promise<void> {
  await db.collection('assets').insertMany([
    richAsset(ids),
    {
      _id: ids.assets.multiLocation,
      fileinfo: [
        { path: '', filename: 'IMG_0002.dng', library_id: ids.libraryA },
        {
          path: 'archive',
          filename: 'IMG_0002.dng',
          library_id: ids.libraryB,
          missing_since: iso(6),
          missing_reason: 'watch-removed',
        },
      ],
      size: 2048,
      mtime: 1_767_225_600_001,
      rating: 0,
      flag: 0,
      color_label: '',
      exif: { ...EXIF, gps: null, camera_serial: null },
      place: null,
      indexed_at: iso(1),
      stages: stageSkeleton(),
      enrichment: pendingEnrichment(),
      media_kind: 'video',
      video_description: {
        summary: 'A short clip of a field.',
        scenes: [{ timestamp_ms: 0, caption: 'field', text_visible: null }],
      },
      live_location_count: 1,
    },
    {
      // Legacy: no fileinfo, no stages, no indexed_at, no media_kind.
      _id: ids.assets.legacy,
      size: 512,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
    },
    {
      _id: ids.assets.trashed,
      fileinfo: [{ path: 'trash', filename: 'IMG_0004.dng', library_id: ids.libraryA }],
      size: 4096,
      mtime: 1_767_225_600_002,
      rating: 0,
      flag: -1,
      color_label: '',
      indexed_at: iso(1),
      deleted_at: iso(7),
      deleted_reason: 'reaped',
      stages: stageSkeleton(),
    },
    {
      _id: ids.assets.damaged,
      fileinfo: [{ path: '', filename: 'IMG_0005.cr3', library_id: ids.libraryA }],
      size: 8192,
      mtime: 1_767_225_600_003,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: iso(1),
      damaged: { since: iso(8), stage: 'exif', reason: 'truncated file' },
      hidden: true,
      hidden_reason: 'nudity',
      hidden_ack: false,
      // Retired stage names, from stages that were removed or split.
      stages: {
        ...stageSkeleton(),
        hash: { version: 1, attempts: 0, dead: false },
        face: { version: 2, attempts: 0, dead: false },
      },
    },
    {
      // A location under a library root that is no longer registered, and a
      // rating outside the destination's CHECK range.
      _id: ids.assets.orphanLocation,
      fileinfo: [
        { path: '', filename: 'IMG_0006.dng', library_id: ids.libraryA },
        { path: 'gone', filename: 'IMG_0006.dng', library_id: ids.unregisteredLibrary },
      ],
      size: 1024,
      mtime: 1_767_225_600_004,
      rating: 6,
      flag: 0,
      color_label: '',
      indexed_at: iso(1),
      stages: stageSkeleton(),
    },
  ] as never);
}
