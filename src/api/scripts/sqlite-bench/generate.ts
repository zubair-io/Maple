/**
 * Synthetic library generator for the schema benchmark.
 *
 * Generates rows that look like a real Maple library rather than uniform
 * filler, because both things the benchmark measures depend on the shape of the
 * data: table sizes depend on payload sizes, and facet timings depend on
 * cardinality. The distributions are modelled on the production numbers quoted
 * on the epic (335,377 assets, 8 KB average document, p90 28 KB) and on the
 * field shapes in `src/api/src/db/schema.ts`.
 *
 * Nothing here touches production. It is a seeded pseudo-random generator, so
 * a re-run reproduces the same library.
 */

import type { Database, Statement } from 'bun:sqlite';
import {
  ASSET_LOCATIONS_TRIGGER_DDL,
  ASSET_LOCATIONS_TRIGGER_NAMES,
} from '../../src/db/sqlite/ddl/asset-locations.ts';
import {
  ASSET_SEARCH_TRIGGER_DDL,
  ASSET_SEARCH_TRIGGER_NAMES,
} from '../../src/db/sqlite/ddl/search.ts';
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
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Picks between two values with the given probability.
 *
 * Both are evaluated, which keeps the number of PRNG draws per asset fixed and
 * therefore the generated library reproducible. It also keeps the per-row
 * writers free of branches, which is the difference between them reading as a
 * list of columns and reading as a decision tree.
 */
function either<T>(random: () => number, probability: number, whenTrue: T, whenFalse: T): T {
  return random() < probability ? whenTrue : whenFalse;
}

/** {@link either} for the 0/1 integers SQLite stores booleans as. */
function flag(random: () => number, probability: number): number {
  return either(random, probability, 1, 0);
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

type Prepared = Statement<unknown, never[]>;

interface Statements {
  asset: Prepared;
  location: Prepared;
  stage: Prepared;
  detail: Prepared;
  search: Prepared;
  face: Prepared;
  link: Prepared;
}

/** Everything the per-asset writers need, threaded through as one value. */
interface Context {
  st: Statements;
  random: () => number;
  now: string;
  libraryId: string;
  personIds: string[];
  counts: Record<string, number>;
}

/** One asset's identity and the few values several writers share. */
interface AssetShape {
  id: string;
  captured: Date;
  /** Index into PLACES, so exif GPS and the place rollups agree. */
  placeIndex: number;
  hasExif: boolean;
  /** Implies hasExif — a geocode needs GPS, which needs EXIF. */
  hasPlace: boolean;
}

function prepare(db: Database): Statements {
  const p = (sql: string): Prepared => db.prepare(sql) as unknown as Prepared;
  return {
    asset: p(
      `INSERT INTO assets (id, size, mtime, indexed_at, rating, flag, color_label, has_xmp,
                           media_kind, hidden, is_screenshot, deleted_at, maple_id, exif, place)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    location: p(
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    stage: p(
      `INSERT INTO stage_state (asset_id, stage, version, attempts, processed_at, dead)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ),
    detail: p(
      `INSERT INTO asset_detail (asset_id, description, ocr_text, vision, vision_meta)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    search: p(`INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)`),
    face: p(
      `INSERT INTO faces (asset_id, face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h, embedding_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'arcface_r100_glint360k_v1')`,
    ),
    link: p(
      `INSERT INTO asset_phasset_links (asset_id, device_id, phasset_local_id, phasset_cloud_id, first_seen)
       VALUES (?, ?, ?, ?, ?)`,
    ),
  };
}

function makeExif(random: () => number, shape: AssetShape): string | null {
  if (!shape.hasExif) return null;
  const [make, model] = CAMERAS[skewedIndex(random, CAMERAS.length)];
  return JSON.stringify({
    captured_at: shape.captured.toISOString(),
    captured_year: shape.captured.getUTCFullYear(),
    captured_month: shape.captured.getUTCMonth() + 1,
    camera_make: make,
    camera_model: model,
    lens: LENSES[skewedIndex(random, LENSES.length)],
    iso: [64, 100, 200, 400, 800, 1600, 3200][Math.floor(random() * 7)],
    aperture: 1.4 + random() * 8,
    shutter: `1/${Math.floor(random() * 4000) + 30}`,
    focal_length: Math.floor(random() * 200) + 12,
    gps: shape.hasPlace ? { lat: 24 + random() * 40, lng: -124 + random() * 130 } : null,
    camera_serial: either(random, 0.5, `SN${Math.floor(random() * 1e9)}`, null),
  });
}

function makePlace(random: () => number, now: string, shape: AssetShape): string | null {
  if (!shape.hasPlace) return null;
  const [countryCode, region, locality] = PLACES[shape.placeIndex];
  return JSON.stringify({
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
    search_blob: `${locality} ${region} ${countryCode} Main Street Downtown ${locality} Museum`,
  });
}

/** 88% image, 10% video, 2% audio. */
function pickMediaKind(random: () => number): string {
  return either(random, 0.88, 'image', either(random, 0.83, 'video', 'audio'));
}

function writeAssetRow(ctx: Context, shape: AssetShape): void {
  const { random } = ctx;
  const exif = makeExif(random, shape);
  const place = makePlace(random, ctx.now, shape);
  ctx.st.asset.run(
    shape.id,
    Math.floor(random() * 90_000_000) + 500_000,
    shape.captured.getTime(),
    ctx.now,
    either(random, 0.18, Math.ceil(random() * 5), 0),
    flag(random, 0.05),
    either(random, 0.06, 'green', ''),
    flag(random, 0.22),
    pickMediaKind(random),
    flag(random, 0.012),
    flag(random, 0.07),
    either(random, 0.02, shape.captured.toISOString(), null),
    `mid-${shape.id}`,
    exif,
    place,
  );
  ctx.counts.assets += 1;
}

/** Most assets have one live location; a few have a second copy, and a small
 * slice have only non-live entries. */
function writeLocations(ctx: Context, shape: AssetShape, index: number): void {
  const { random } = ctx;
  const count = either(random, 0.03, 2, 1);
  // When every entry is non-live, entry 0 is content-replaced and the rest are
  // missing from disk — the two tags an asset can carry, on different entries.
  const tombstone = either(random, 0.01, shape.captured.toISOString(), null);
  const dir = `${shape.captured.getUTCFullYear()}/${String(shape.captured.getUTCMonth() + 1).padStart(2, '0')}`;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    ctx.st.location.run(
      shape.id,
      ordinal,
      ctx.libraryId,
      dir,
      `IMG_${index}_${ordinal}.dng`,
      ordinal === 0 ? tombstone : null,
      ordinal === 0 ? null : tombstone,
    );
    ctx.counts.asset_locations += 1;
  }
}

/** One row per registered stage, seeded at version 0 when it has not run —
 * the same density the skeleton insert will write in production. */
function writeStages(ctx: Context, shape: AssetShape): void {
  const { random } = ctx;
  for (const stage of STAGE_NAMES) {
    const version = either(random, 0.88, 1 + Math.floor(random() * 3), 0);
    ctx.st.stage.run(shape.id, stage, version, version === 0 ? null : ctx.now, flag(random, 0.004));
    ctx.counts.stage_state += 1;
  }
}

function makeVision(random: () => number): string {
  return JSON.stringify({
    caption: `A ${words(random, 2)} scene with ${words(random, 4)} in the frame.`,
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
  });
}

/** The describe stage's output, on the 72% of assets it has reached. */
function writeDescribeOutput(ctx: Context, shape: AssetShape): void {
  const { random } = ctx;
  if (random() >= 0.72) return;
  ctx.st.detail.run(
    shape.id,
    `A ${words(random, 2)} scene with ${words(random, 3)} in the frame.`,
    either(random, 0.3, words(random, 40), ''),
    makeVision(random),
    JSON.stringify({ model: 'qwen2.5-vl', prompt_version: 7, generated_at: ctx.now }),
  );
  ctx.counts.asset_detail += 1;

  // One document in 400 carries a rare token, so the benchmark can time a
  // selective search as well as a term that matches almost everything.
  const rare = either(
    random,
    0.0025,
    ` ${RARE_TOKENS[Math.floor(random() * RARE_TOKENS.length)]}`,
    '',
  );
  const geo = shape.hasPlace ? `${PLACES[shape.placeIndex].join(' ')} ` : '';
  ctx.st.search.run(shape.id, `${geo}${words(random, 30)}${rare}`);
  ctx.counts.asset_search += 1;
}

function writeFaces(ctx: Context, shape: AssetShape): void {
  const { random } = ctx;
  if (random() >= 0.4) return;
  const count = 1 + Math.floor(random() * 4);
  for (let face = 0; face < count; face += 1) {
    ctx.st.face.run(
      shape.id,
      face,
      either(random, 0.75, ctx.personIds[Math.floor(random() * ctx.personIds.length)], null),
      0.6 + random() * 0.4,
      random() * 0.8,
      random() * 0.8,
      0.05 + random() * 0.1,
      0.05 + random() * 0.1,
    );
    ctx.counts.faces += 1;
  }
}

function writePhassetLink(ctx: Context, shape: AssetShape): void {
  const { random } = ctx;
  if (random() >= 0.55) return;
  ctx.st.link.run(
    shape.id,
    `device-${Math.floor(random() * 4)}`,
    `${newObjectIdHex()}/L0/001`,
    either(random, 0.8, `cloud-${shape.id}`, null),
    ctx.now,
  );
  ctx.counts.asset_phasset_links += 1;
}

function writeAsset(ctx: Context, index: number): void {
  const { random } = ctx;
  const capturedMs = Date.UTC(2011, 0, 1) + Math.floor(random() * 15 * 365.25 * 86_400_000);
  const hasExif = random() > 0.08;
  const shape: AssetShape = {
    id: newObjectIdHex(),
    captured: new Date(capturedMs),
    placeIndex: skewedIndex(random, PLACES.length),
    hasExif,
    hasPlace: hasExif && random() > 0.34,
  };
  writeAssetRow(ctx, shape);
  writeLocations(ctx, shape, index);
  writeStages(ctx, shape);
  writeDescribeOutput(ctx, shape);
  writeFaces(ctx, shape);
  writePhassetLink(ctx, shape);
}

/**
 * Drops the triggers that derive `live_location_count` and the FTS5 postings.
 * Restored by {@link restoreDerivedTriggers} once the rows are in.
 */
function dropDerivedTriggers(db: Database): void {
  for (const name of [...ASSET_LOCATIONS_TRIGGER_NAMES, ...ASSET_SEARCH_TRIGGER_NAMES]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

function restoreDerivedTriggers(db: Database): void {
  db.exec(ASSET_LOCATIONS_TRIGGER_DDL);
  db.exec(ASSET_SEARCH_TRIGGER_DDL);
}

function seedPeople(db: Database, now: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < 120; i += 1) {
    const id = newObjectIdHex();
    ids.push(id);
    db.run(`INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, [
      id,
      `Person ${i}`,
      now,
      now,
    ]);
  }
  return ids;
}

/**
 * Fills a migrated database with `assetCount` assets and everything that hangs
 * off them.
 *
 * Both trigger sets are dropped for the load and restored afterwards, which is
 * the path the importer (#3744) will take for the same reason: a per-row
 * `UPDATE assets` and a per-row FTS5 posting update are the two most expensive
 * things in a bulk insert, and both can be replaced by a single statement once
 * the rows are in. The caller runs those two statements — see
 * `LIVE_LOCATION_COUNT_RECOMPUTE_SQL` and `ASSETS_FTS_REBUILD_SQL`.
 */
export function generateLibrary(db: Database, options: GenerateOptions): GenerateResult {
  const { assetCount, seed = 0x5eed, batchSize = 20_000 } = options;
  const startedAt = performance.now();
  const now = new Date().toISOString();
  const libraryId = newObjectIdHex();

  db.run(
    `INSERT INTO folders (id, path, slug, label, file_count, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
    [libraryId, '/libraries/bench', 'bench', 'Benchmark library', now],
  );
  dropDerivedTriggers(db);

  const ctx: Context = {
    st: prepare(db),
    random: makeRandom(seed),
    now,
    libraryId,
    personIds: seedPeople(db, now),
    counts: {
      assets: 0,
      asset_locations: 0,
      stage_state: 0,
      asset_detail: 0,
      asset_search: 0,
      faces: 0,
      asset_phasset_links: 0,
    },
  };

  const writeBatch = db.transaction((from: number, to: number) => {
    for (let i = from; i < to; i += 1) writeAsset(ctx, i);
  });
  for (let from = 0; from < assetCount; from += batchSize) {
    writeBatch(from, Math.min(from + batchSize, assetCount));
  }

  restoreDerivedTriggers(db);

  return {
    assetCount,
    rowCounts: ctx.counts,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}
