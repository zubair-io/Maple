/**
 * Synthetic library generator for the schema benchmark.
 *
 * Generates rows that look like a real Maple library rather than uniform
 * filler, because both things the benchmark measures depend on the shape of the
 * data: table sizes depend on payload sizes, and facet timings depend on
 * cardinality. The distributions below are modelled on the production numbers
 * quoted on the epic (335,377 assets, 8 KB average document, p90 28 KB) and on
 * the field shapes in `src/api/src/db/schema.ts`.
 *
 * Nothing here touches production. It is a seeded pseudo-random generator, so
 * a re-run reproduces the same library.
 */

import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../../src/db/sqlite/object-id.ts';
import {
  ACTIVITIES,
  CAMERAS,
  LENSES,
  PLACES,
  RARE_TOKENS,
  SCENES,
  skewedIndex,
  STAGE_NAMES,
  words,
} from './fixtures.ts';

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded so two runs of the benchmark
 * compare like for like.
 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenerateOptions {
  assetCount: number;
  seed?: number;
  /** Rows per transaction. Large enough to amortise fsync, small enough to
   * keep the rollback journal bounded. */
  batchSize?: number;
}

export interface GenerateResult {
  assetCount: number;
  rowCounts: Record<string, number>;
  elapsedMs: number;
}

/**
 * Fills a migrated database with `assetCount` assets and everything that hangs
 * off them.
 *
 * The location triggers are dropped for the load and the counts recomputed in
 * one statement afterwards, which is the path the importer (#3744) will take
 * for the same reason: a per-row `UPDATE assets` during a bulk load is the
 * single most expensive thing in the insert.
 */
export function generateLibrary(db: Database, options: GenerateOptions): GenerateResult {
  const { assetCount } = options;
  const random = makeRandom(options.seed ?? 0x5eed);
  const batchSize = options.batchSize ?? 20_000;
  const startedAt = performance.now();

  const libraryId = newObjectIdHex();
  db.run(
    `INSERT INTO folders (id, path, slug, label, file_count, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    libraryId,
    '/libraries/bench',
    'bench',
    'Benchmark library',
    new Date().toISOString(),
  );

  for (const name of [
    'asset_locations_count_ai',
    'asset_locations_count_ad',
    'asset_locations_count_au',
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }

  const insertAsset = db.prepare(
    `INSERT INTO assets (id, size, mtime, indexed_at, rating, flag, color_label, has_xmp,
                         media_kind, hidden, is_screenshot, deleted_at, maple_id, exif, place)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLocation = db.prepare(
    `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertStage = db.prepare(
    `INSERT INTO stage_state (asset_id, stage, version, attempts, processed_at, dead)
     VALUES (?, ?, ?, 0, ?, ?)`,
  );
  const insertDetail = db.prepare(
    `INSERT INTO asset_detail (asset_id, description, ocr_text, vision, vision_meta)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertSearch = db.prepare(`INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)`);
  const insertFace = db.prepare(
    `INSERT INTO faces (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h, embedding_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'arcface_r100_glint360k_v1')`,
  );
  const insertLink = db.prepare(
    `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, phasset_cloud_id, first_seen)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const personIds: string[] = [];
  const now = new Date().toISOString();
  for (let i = 0; i < 120; i += 1) {
    const id = newObjectIdHex();
    personIds.push(id);
    db.run(
      `INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      id,
      `Person ${i}`,
      now,
      now,
    );
  }

  const counts: Record<string, number> = {
    assets: 0,
    asset_locations: 0,
    stage_state: 0,
    asset_detail: 0,
    asset_search: 0,
    faces: 0,
    asset_phasset_links: 0,
  };

  const writeBatch = db.transaction((from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      const id = newObjectIdHex();
      const hasExif = random() > 0.08;
      const hasPlace = hasExif && random() > 0.34;
      const trashed = random() < 0.02;

      const [make, model] = CAMERAS[skewedIndex(random, CAMERAS.length)];
      const lens = LENSES[skewedIndex(random, LENSES.length)];
      const capturedMs = Date.UTC(2011, 0, 1) + Math.floor(random() * 15 * 365.25 * 86_400_000);
      const captured = new Date(capturedMs);
      const [countryCode, region, locality] = PLACES[skewedIndex(random, PLACES.length)];

      const exif = hasExif
        ? JSON.stringify({
            captured_at: captured.toISOString(),
            captured_year: captured.getUTCFullYear(),
            captured_month: captured.getUTCMonth() + 1,
            camera_make: make,
            camera_model: model,
            lens,
            iso: [64, 100, 200, 400, 800, 1600, 3200][Math.floor(random() * 7)],
            aperture: 1.4 + random() * 8,
            shutter: `1/${Math.floor(random() * 4000) + 30}`,
            focal_length: Math.floor(random() * 200) + 12,
            gps: hasPlace ? { lat: 24 + random() * 40, lng: -124 + random() * 130 } : null,
            camera_serial: random() > 0.5 ? `SN${Math.floor(random() * 1e9)}` : null,
          })
        : null;

      const place = hasPlace
        ? JSON.stringify({
            source: 'nominatim',
            geocoder_version: 3,
            geocoded_at: now,
            lat: 24 + random() * 40,
            lon: -124 + random() * 130,
            display_name: `${Math.floor(random() * 400)} Main Street, ${locality}, ${region}, ${countryCode.toUpperCase()}`,
            address: {
              house_number: String(Math.floor(random() * 400)),
              road: 'Main Street',
              neighbourhood: 'Downtown',
              city: locality,
              county: `${region} County`,
              state: region,
              state_code: region.slice(0, 2).toUpperCase(),
              postcode: String(10000 + Math.floor(random() * 80000)),
              country: region,
              country_code: countryCode,
            },
            pois: [
              { name: `${locality} Museum`, category: 'tourism', type: 'museum' },
              { name: `${locality} Park`, category: 'leisure', type: 'park' },
            ],
            rollups: { locality, region, country_code: countryCode },
            search_blob: `${locality} ${region} ${countryCode} Main Street Downtown ${locality} Museum ${locality} Park`,
          })
        : null;

      insertAsset.run(
        id,
        Math.floor(random() * 90_000_000) + 500_000,
        capturedMs,
        now,
        random() < 0.18 ? Math.ceil(random() * 5) : 0,
        random() < 0.05 ? 1 : 0,
        random() < 0.06 ? 'green' : '',
        random() < 0.22 ? 1 : 0,
        random() < 0.88 ? 'image' : random() < 0.83 ? 'video' : 'audio',
        random() < 0.012 ? 1 : 0,
        random() < 0.07 ? 1 : 0,
        trashed ? captured.toISOString() : null,
        `mid-${id}`,
        exif,
        place,
      );
      counts.assets += 1;

      // Locations: most assets have one, a few have a second copy, a small
      // slice have only non-live entries.
      const locationCount = random() < 0.03 ? 2 : 1;
      const allDead = random() < 0.01;
      for (let ordinal = 0; ordinal < locationCount; ordinal += 1) {
        insertLocation.run(
          id,
          ordinal,
          libraryId,
          `${captured.getUTCFullYear()}/${String(captured.getUTCMonth() + 1).padStart(2, '0')}`,
          `IMG_${i}_${ordinal}.dng`,
          allDead && ordinal === 0 ? captured.toISOString() : null,
          allDead && ordinal > 0 ? captured.toISOString() : null,
        );
        counts.asset_locations += 1;
      }

      for (const stage of STAGE_NAMES) {
        const ran = random() > 0.12;
        insertStage.run(
          id,
          stage,
          ran ? 1 + Math.floor(random() * 3) : 0,
          ran ? now : null,
          random() < 0.004 ? 1 : 0,
        );
        counts.stage_state += 1;
      }

      if (random() < 0.72) {
        insertDetail.run(
          id,
          `A ${words(random, 2)} scene with ${words(random, 3)} in the frame.`,
          random() < 0.3 ? words(random, 40) : '',
          JSON.stringify({
            caption: `A ${words(random, 2)} scene with ${words(random, 4)} in the frame, shot at ${words(random, 1)}.`,
            tags: Array.from({ length: 12 }, () => words(random, 1)),
            subjects: Array.from({ length: 4 }, () => words(random, 1)),
            scene_type: SCENES[Math.floor(random() * SCENES.length)],
            setting: words(random, 1),
            activity: ACTIVITIES[Math.floor(random() * ACTIVITIES.length)],
            time_of_day: 'golden hour',
            lighting: 'natural',
            weather: 'clear',
            mood: words(random, 2),
            colors: ['amber', 'slate', 'teal'],
            framing: 'medium',
            text_visible: null,
            notable_objects: Array.from({ length: 6 }, () => words(random, 1)),
            shot_type: 'candid',
            is_screenshot: false,
            people_count: Math.floor(random() * 5),
          }),
          JSON.stringify({ model: 'qwen2.5-vl', prompt_version: 7, generated_at: now }),
        );
        counts.asset_detail += 1;

        // One document in 400 carries a rare token, so the benchmark can time
        // a selective search as well as a term that matches almost everything.
        const rare =
          random() < 0.0025 ? ` ${RARE_TOKENS[Math.floor(random() * RARE_TOKENS.length)]}` : '';
        insertSearch.run(
          id,
          `${place ? `${locality} ${region} ${countryCode} ` : ''}${words(random, 30)}${rare}`,
        );
        counts.asset_search += 1;
      }

      if (random() < 0.4) {
        const faceCount = 1 + Math.floor(random() * 4);
        for (let f = 0; f < faceCount; f += 1) {
          insertFace.run(
            id,
            f,
            random() < 0.75 ? personIds[Math.floor(random() * personIds.length)] : null,
            0.6 + random() * 0.4,
            random() * 0.8,
            random() * 0.8,
            0.05 + random() * 0.1,
            0.05 + random() * 0.1,
          );
          counts.faces += 1;
        }
      }

      if (random() < 0.55) {
        insertLink.run(
          id,
          `device-${Math.floor(random() * 4)}`,
          `${newObjectIdHex()}/L0/001`,
          random() < 0.8 ? `cloud-${id}` : null,
          now,
        );
        counts.asset_phasset_links += 1;
      }
    }
  });

  for (let from = 0; from < assetCount; from += batchSize) {
    writeBatch(from, Math.min(from + batchSize, assetCount));
  }

  return { assetCount, rowCounts: counts, elapsedMs: Math.round(performance.now() - startedAt) };
}
