/**
 * Field-level probes on sampled assets, read straight from the source document.
 *
 * The generic check in `verify.ts` confirms that what the mapper produced is
 * what the database holds. That is a real check — it catches a lost
 * transaction, a misaligned column list, a value SQLite coerced — but it cannot
 * catch a mapper that is confidently wrong, because it uses the mapper as its
 * own definition of the right answer.
 *
 * So these probes do not go through the mapper at all. They read the MongoDB
 * document, state independently what the row should hold, and ask SQLite. They
 * cover the three places the decomposition could plausibly go wrong and nothing
 * would notice until a client did:
 *
 *  - the **identifier**, which is client-visible and must survive byte for
 *    byte;
 *  - the **nested arrays** — locations, faces, Apple Photos links — where the
 *    array position is on the wire and an off-by-one would silently renumber
 *    every face a person is tagged in;
 *  - the **JSON payloads**, where the generated columns the whole facet path
 *    depends on read specific paths, so a payload that round-tripped through
 *    the wrong shape produces a database that looks full and facets empty.
 */

import type { Database } from 'bun:sqlite';
import type { Db } from 'mongodb';
import type { FieldCheck } from './types.ts';
import { asArray, asRecord, normaliseJson } from './values.ts';

/** Renders a value for the expected/actual strings of a {@link FieldCheck}. */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(normaliseJson(value));
}

function check(sourceId: string, field: string, expected: unknown, actual: unknown): FieldCheck {
  const left = show(expected);
  const right = show(actual);
  return { source: 'assets', sourceId, field, expected: left, actual: right, ok: left === right };
}

interface AssetRow {
  id: string;
  size: number;
  rating: number;
  media_kind: string;
  exif: string | null;
  place: string | null;
  captured_at: string | null;
  camera_make: string | null;
  gps_lat: number | null;
  place_locality: string | null;
}

/** Compares one source asset against every row it should have produced. */
function probeAsset(sqlite: Database, doc: Record<string, unknown>): FieldCheck[] {
  const id = String(doc._id);
  const out: FieldCheck[] = [];

  const row = sqlite
    .query(
      `SELECT id, size, rating, media_kind, exif, place,
              captured_at, camera_make, gps_lat, place_locality
         FROM assets WHERE id = ?`,
    )
    .get(id) as AssetRow | null;

  if (row === null) {
    out.push(check(id, 'assets.id', id, null));
    return out;
  }

  // The identifier, unchanged. This is the whole non-goal of the migration.
  out.push(check(id, 'assets.id', id, row.id));
  out.push(check(id, 'assets.size', doc.size ?? 0, row.size));
  // The destination CHECKs 0..5; a source rating outside that range is clamped
  // rather than losing the whole asset, so that is what the probe expects.
  const rating = Math.min(5, Math.max(0, Math.trunc(Number(doc.rating ?? 0)) || 0));
  out.push(check(id, 'assets.rating', rating, row.rating));
  out.push(check(id, 'assets.media_kind', doc.media_kind ?? 'image', row.media_kind));

  // JSON payloads, compared as normalised structures rather than as text, so a
  // key-order difference is not reported as a mismatch.
  const exif = doc.exif ?? null;
  out.push(check(id, 'assets.exif', exif, row.exif === null ? null : JSON.parse(row.exif)));
  const place = doc.place ?? null;
  out.push(check(id, 'assets.place', place, row.place === null ? null : JSON.parse(row.place)));

  // The generated columns the facet indexes are built over. If these disagree
  // the database looks full and every facet comes back empty.
  const exifRecord = asRecord(exif);
  const gps = asRecord(exifRecord.gps);
  out.push(check(id, 'assets.captured_at', exifRecord.captured_at ?? null, row.captured_at));
  out.push(check(id, 'assets.camera_make', exifRecord.camera_make ?? null, row.camera_make));
  out.push(check(id, 'assets.gps_lat', gps.lat ?? null, row.gps_lat));
  const rollups = asRecord(asRecord(place).rollups);
  out.push(check(id, 'assets.place_locality', rollups.locality ?? null, row.place_locality));

  out.push(...probeLocations(sqlite, doc, id));
  out.push(...probeFaces(sqlite, doc, id));
  out.push(...probeLinks(sqlite, doc, id));
  out.push(...probeDetail(sqlite, doc, id));
  out.push(...probeStages(sqlite, doc, id));
  return out;
}

/** True when this library root survived the import — see `repair.ts`. */
function libraryExists(sqlite: Database, libraryId: unknown): boolean {
  if (typeof libraryId !== 'object' && typeof libraryId !== 'string') return false;
  const row = sqlite
    .query(`SELECT 1 AS present FROM folders WHERE id = ? LIMIT 1`)
    .get(String(libraryId));
  return row !== null;
}

function probeLocations(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const rows = sqlite
    .query(
      `SELECT ordinal, library_id, path, filename, keep
         FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`,
    )
    .all(id) as Array<{
    ordinal: number;
    library_id: string;
    path: string;
    filename: string;
    keep: number;
  }>;
  // Rows are matched by ORDINAL, not by position in the result set: a location
  // under a library root that is no longer registered is dropped by the repair
  // pass — the same verdict every Mongo read path reaches by walking past it —
  // and the surviving entries keep their original array positions rather than
  // closing the gap.
  const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));

  const source = asArray(doc.fileinfo);
  const expectedCount = source.filter((raw) =>
    libraryExists(sqlite, asRecord(raw).library_id),
  ).length;
  const out = [check(id, 'fileinfo.length', expectedCount, rows.length)];

  for (const [ordinal, raw] of source.entries()) {
    const entry = asRecord(raw);
    if (!libraryExists(sqlite, entry.library_id)) continue;
    const row = byOrdinal.get(ordinal);
    // The array position IS the ordinal, and ordinal 0 is the canonical entry
    // every cache path is resolved from.
    out.push(check(id, `fileinfo[${ordinal}].ordinal`, ordinal, row?.ordinal ?? null));
    out.push(
      check(
        id,
        `fileinfo[${ordinal}].library_id`,
        String(entry.library_id ?? ''),
        row?.library_id ?? null,
      ),
    );
    out.push(check(id, `fileinfo[${ordinal}].path`, entry.path ?? '', row?.path ?? null));
    out.push(
      check(id, `fileinfo[${ordinal}].filename`, entry.filename ?? '', row?.filename ?? null),
    );
    out.push(
      check(id, `fileinfo[${ordinal}].keep`, entry.keep === true ? 1 : 0, row?.keep ?? null),
    );
  }
  return out;
}

function probeFaces(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const source = asArray(doc.faces);
  const rows = sqlite
    .query(
      `SELECT face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h, embedding
         FROM faces WHERE asset_id = ? ORDER BY face_index`,
    )
    .all(id) as Array<{
    face_index: number;
    person_id: string | null;
    confidence: number;
    bbox_x: number;
    bbox_y: number;
    bbox_w: number;
    bbox_h: number;
    embedding: string | null;
  }>;

  const out = [check(id, 'faces.length', source.length, rows.length)];
  for (const [index, raw] of source.entries()) {
    const face = asRecord(raw);
    const bbox = asRecord(face.bbox);
    const row = rows[index];
    // `face_index` is on the wire — the person detail page addresses a face by
    // it — so a renumbering here would break every existing deep link.
    out.push(check(id, `faces[${index}].face_index`, index, row?.face_index ?? null));
    out.push(
      check(id, `faces[${index}].person_id`, face.person_id ?? null, row?.person_id ?? null),
    );
    out.push(check(id, `faces[${index}].bbox.x`, bbox.x ?? 0, row?.bbox_x ?? null));
    out.push(check(id, `faces[${index}].bbox.h`, bbox.h ?? 0, row?.bbox_h ?? null));
    const embedding = face.embedding ?? null;
    out.push(
      check(
        id,
        `faces[${index}].embedding`,
        embedding,
        row?.embedding == null ? null : JSON.parse(row.embedding),
      ),
    );
  }
  return out;
}

function probeLinks(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  // The destination's UNIQUE (asset_id, device_id, phasset_local_id) is
  // stronger than the array was, and the first entry of a repeated pair wins.
  const seen = new Set<string>();
  const source = asArray(doc.phasset_links)
    .map(asRecord)
    .filter((link) => {
      const key = `${String(link.device_id)}/${String(link.phasset_local_id)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const rows = sqlite
    .query(
      `SELECT device_id, phasset_local_id, phasset_cloud_id, first_seen
         FROM asset_phasset_links WHERE asset_id = ? ORDER BY device_id, phasset_local_id`,
    )
    .all(id) as Array<{
    device_id: string;
    phasset_local_id: string;
    phasset_cloud_id: string | null;
    first_seen: string;
  }>;

  const out: FieldCheck[] = [];
  for (const link of source) {
    const row = rows.find(
      (candidate) =>
        candidate.device_id === link.device_id &&
        candidate.phasset_local_id === link.phasset_local_id,
    );
    const key = `${String(link.device_id)}/${String(link.phasset_local_id)}`;
    out.push(check(id, `phasset_links[${key}]`, key, row === undefined ? null : key));
    out.push(
      check(
        id,
        `phasset_links[${key}].cloud_id`,
        link.phasset_cloud_id ?? null,
        row?.phasset_cloud_id ?? null,
      ),
    );
  }
  return out;
}

function probeDetail(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const vision = doc.vision ?? null;
  const blob = typeof doc.search_blob === 'string' ? doc.search_blob : null;
  const row = sqlite
    .query(`SELECT vision, ocr_text, vision_scene_type FROM asset_detail WHERE asset_id = ?`)
    .get(id) as {
    vision: string | null;
    ocr_text: string | null;
    vision_scene_type: string | null;
  } | null;
  const searchRow = sqlite
    .query(`SELECT search_blob FROM asset_search WHERE asset_id = ?`)
    .get(id) as { search_blob: string } | null;

  return [
    check(id, 'asset_detail.vision', vision, row?.vision == null ? null : JSON.parse(row.vision)),
    check(id, 'asset_detail.ocr_text', doc.ocr_text ?? null, row?.ocr_text ?? null),
    check(
      id,
      'asset_detail.vision_scene_type',
      asRecord(vision).scene_type ?? null,
      row?.vision_scene_type ?? null,
    ),
    check(
      id,
      'asset_search.search_blob',
      blob === null || blob === '' ? null : blob,
      searchRow?.search_blob ?? null,
    ),
  ];
}

function probeStages(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const stages = asRecord(doc.stages);
  const rows = sqlite
    .query(`SELECT stage, version, attempts, dead FROM stage_state WHERE asset_id = ?`)
    .all(id) as Array<{ stage: string; version: number; attempts: number; dead: number }>;
  const byName = new Map(rows.map((row) => [row.stage, row]));

  const out: FieldCheck[] = [];
  for (const [name, raw] of Object.entries(stages)) {
    const state = asRecord(raw);
    const row = byName.get(name);
    out.push(check(id, `stages.${name}.version`, state.version ?? 0, row?.version ?? null));
    out.push(check(id, `stages.${name}.attempts`, state.attempts ?? 0, row?.attempts ?? null));
    out.push(check(id, `stages.${name}.dead`, state.dead === true ? 1 : 0, row?.dead ?? null));
  }
  return out;
}

/**
 * Probes up to `sample` assets, spread evenly across the collection in `_id`
 * order.
 *
 * Evenly rather than randomly, and streamed rather than materialised: the same
 * run twice gives the same sample, which is what makes a reported failure
 * reproducible, and a third of a million documents never has to fit in memory
 * to choose a hundred of them.
 */
export async function verifyAssetFields(
  mongo: Db,
  sqlite: Database,
  sample: number,
): Promise<FieldCheck[]> {
  if (sample <= 0) return [];
  const assets = mongo.collection('assets');
  const step = Math.max(1, Math.floor((await assets.countDocuments()) / sample));

  const out: FieldCheck[] = [];
  let index = 0;
  let taken = 0;
  const cursor = assets.find({}, { sort: { _id: 1 } });
  for await (const doc of cursor) {
    if (index % step === 0) {
      out.push(...probeAsset(sqlite, doc as unknown as Record<string, unknown>));
      taken += 1;
      if (taken >= sample) break;
    }
    index += 1;
  }
  await cursor.close();
  return out;
}
