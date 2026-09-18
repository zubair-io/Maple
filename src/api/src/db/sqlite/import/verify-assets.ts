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
 *
 * Each probe is a table of `field → [what the source says, what the row holds]`
 * rather than a run of conditionals, so adding a field is one line in an object
 * literal and the null handling lives in one place instead of at every site.
 */

import type { Database } from 'bun:sqlite';
import type { Db } from 'mongodb';
import type { FieldCheck } from './types.ts';
import { asArray, asRecord, normaliseJson } from './values.ts';

/** One field: what the source says it should be, and what the row holds. */
type Cell = [expected: unknown, actual: unknown];

/** A row read back from SQLite, or nothing when there was none. */
type Row = Record<string, unknown> | undefined | null;

/** Renders a value for the expected/actual strings of a {@link FieldCheck}. */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return typeof value === 'string' ? value : JSON.stringify(normaliseJson(value));
}

/** Turns a table of cells into checks, comparing rendered forms. */
function checks(sourceId: string, cells: Record<string, Cell>): FieldCheck[] {
  return Object.entries(cells).map(([field, [expected, actual]]) => {
    const left = show(expected);
    const right = show(actual);
    return { source: 'assets', sourceId, field, expected: left, actual: right, ok: left === right };
  });
}

/** One column of a row that may not exist, as null rather than undefined. */
function at(row: Row, column: string): unknown {
  return row?.[column] ?? null;
}

/** A JSON column parsed back, or null. */
function json(row: Row, column: string): unknown {
  const raw = at(row, column);
  return typeof raw === 'string' ? JSON.parse(raw) : null;
}

/** A source field, as null rather than undefined. */
function from(doc: Record<string, unknown>, field: string): unknown {
  return doc[field] ?? null;
}

/** A source field with a default, for a column the destination cannot leave null. */
function or(doc: Record<string, unknown>, field: string, fallback: unknown): unknown {
  return doc[field] ?? fallback;
}

const ASSET_SQL = `
SELECT id, size, rating, media_kind, exif, place,
       captured_at, camera_make, gps_lat, place_locality
  FROM assets WHERE id = ?`;

/** Compares one source asset against every row it should have produced. */
function probeAsset(sqlite: Database, doc: Record<string, unknown>): FieldCheck[] {
  const id = String(doc._id);
  const row = sqlite.query(ASSET_SQL).get(id) as Row;
  if (row === null || row === undefined) return checks(id, { 'assets.id': [id, null] });

  const exif = from(doc, 'exif');
  const place = from(doc, 'place');
  const exifFields = asRecord(exif);
  const gps = asRecord(exifFields.gps);
  const rollups = asRecord(asRecord(place).rollups);
  const rating = clampedRating(doc);

  return [
    ...checks(id, {
      // The identifier, unchanged. This is the migration's stated non-goal.
      'assets.id': [id, at(row, 'id')],
      'assets.size': [or(doc, 'size', 0), at(row, 'size')],
      'assets.rating': [rating, at(row, 'rating')],
      'assets.media_kind': [or(doc, 'media_kind', 'image'), at(row, 'media_kind')],
      // JSON payloads, compared as normalised structures rather than as text,
      // so a key-order difference is not reported as a mismatch.
      'assets.exif': [exif, json(row, 'exif')],
      'assets.place': [place, json(row, 'place')],
      // The generated columns the facet indexes are built over. If these
      // disagree the database looks full and every facet comes back empty.
      'assets.captured_at': [from(exifFields, 'captured_at'), at(row, 'captured_at')],
      'assets.camera_make': [from(exifFields, 'camera_make'), at(row, 'camera_make')],
      'assets.gps_lat': [from(gps, 'lat'), at(row, 'gps_lat')],
      'assets.place_locality': [from(rollups, 'locality'), at(row, 'place_locality')],
    }),
    ...probeLocations(sqlite, doc, id),
    ...probeFaces(sqlite, doc, id),
    ...probeLinks(sqlite, doc, id),
    ...probeDetail(sqlite, doc, id),
    ...probeStages(sqlite, doc, id),
  ];
}

/**
 * The destination CHECKs `rating` between 0 and 5. A source rating outside that
 * range is clamped rather than losing the whole asset, so that is what the
 * probe expects to find.
 */
function clampedRating(doc: Record<string, unknown>): number {
  const raw = Math.trunc(Number(doc.rating ?? 0));
  return Number.isFinite(raw) ? Math.min(5, Math.max(0, raw)) : 0;
}

/** True when this library root survived the import — see `repair.ts`. */
function libraryExists(sqlite: Database, libraryId: unknown): boolean {
  const row = sqlite
    .query(`SELECT 1 AS present FROM folders WHERE id = ? LIMIT 1`)
    .get(String(libraryId ?? ''));
  return row !== null;
}

const LOCATION_SQL = `
SELECT ordinal, library_id, path, filename, keep
  FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`;

function probeLocations(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const rows = sqlite.query(LOCATION_SQL).all(id) as Array<Record<string, unknown>>;
  // Rows are matched by ORDINAL, not by position in the result set: a location
  // under a library root that is no longer registered is dropped by the repair
  // pass — the same verdict every Mongo read path reaches by walking past it —
  // and the surviving entries keep their original array positions rather than
  // closing the gap.
  const byOrdinal = new Map(rows.map((row) => [row.ordinal as number, row]));
  const source = asArray(doc.fileinfo).map(asRecord);
  const live = new Set(source.filter((entry) => libraryExists(sqlite, entry.library_id)));

  const out = checks(id, { 'fileinfo.length': [live.size, rows.length] });
  for (const [ordinal, entry] of source.entries()) {
    if (!live.has(entry)) continue;
    const row = byOrdinal.get(ordinal);
    out.push(
      ...checks(id, {
        // The array position IS the ordinal, and ordinal 0 is the canonical
        // entry every cache path is resolved from.
        [`fileinfo[${ordinal}].ordinal`]: [ordinal, at(row, 'ordinal')],
        [`fileinfo[${ordinal}].library_id`]: [
          String(entry.library_id ?? ''),
          at(row, 'library_id'),
        ],
        [`fileinfo[${ordinal}].path`]: [entry.path ?? '', at(row, 'path')],
        [`fileinfo[${ordinal}].filename`]: [entry.filename ?? '', at(row, 'filename')],
        [`fileinfo[${ordinal}].keep`]: [entry.keep === true ? 1 : 0, at(row, 'keep')],
      }),
    );
  }
  return out;
}

const FACE_SQL = `
SELECT face_index, person_id, confidence, bbox_x, bbox_y, bbox_w, bbox_h, embedding
  FROM faces WHERE asset_id = ? ORDER BY face_index`;

function probeFaces(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const rows = sqlite.query(FACE_SQL).all(id) as Array<Record<string, unknown>>;
  const source = asArray(doc.faces).map(asRecord);

  const perFace = source.flatMap((face, index) => {
    const bbox = asRecord(face.bbox);
    const row = rows[index];
    return checks(id, {
      // `face_index` is on the wire — the person detail page addresses a face
      // by it — so a renumbering here breaks every existing deep link.
      [`faces[${index}].face_index`]: [index, at(row, 'face_index')],
      [`faces[${index}].person_id`]: [face.person_id ?? null, at(row, 'person_id')],
      [`faces[${index}].bbox.x`]: [bbox.x ?? 0, at(row, 'bbox_x')],
      [`faces[${index}].bbox.h`]: [bbox.h ?? 0, at(row, 'bbox_h')],
      [`faces[${index}].embedding`]: [face.embedding ?? null, json(row, 'embedding')],
    });
  });
  return [...checks(id, { 'faces.length': [source.length, rows.length] }), ...perFace];
}

const LINK_SQL = `
SELECT device_id, phasset_local_id, phasset_cloud_id, first_seen
  FROM asset_phasset_links WHERE asset_id = ? ORDER BY device_id, phasset_local_id`;

/** The link key the destination's UNIQUE constraint is expressed over. */
function linkKey(link: Record<string, unknown>): string {
  return `${String(link.device_id)}/${String(link.phasset_local_id)}`;
}

function probeLinks(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const rows = sqlite.query(LINK_SQL).all(id) as Array<Record<string, unknown>>;
  const byKey = new Map(rows.map((row) => [linkKey(row), row]));
  // The destination's UNIQUE (asset_id, device_id, phasset_local_id) is
  // stronger than the array was, and the first entry of a repeated pair wins.
  const seen = new Set<string>();
  const source = asArray(doc.phasset_links)
    .map(asRecord)
    .filter((link) => {
      const key = linkKey(link);
      const fresh = !seen.has(key);
      seen.add(key);
      return fresh;
    });

  return source.flatMap((link) => {
    const key = linkKey(link);
    const row = byKey.get(key);
    return checks(id, {
      [`phasset_links[${key}]`]: [key, row === undefined ? null : key],
      [`phasset_links[${key}].cloud_id`]: [
        link.phasset_cloud_id ?? null,
        at(row, 'phasset_cloud_id'),
      ],
    });
  });
}

function probeDetail(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const detail = sqlite
    .query(
      `SELECT vision, ocr_text, description, description_meta, vision_scene_type
         FROM asset_detail WHERE asset_id = ?`,
    )
    .get(id) as Row;
  const search = sqlite
    .query(`SELECT search_blob FROM asset_search WHERE asset_id = ?`)
    .get(id) as Row;

  const vision = from(doc, 'vision');
  const rawBlob = from(doc, 'search_blob');
  const blob = typeof rawBlob === 'string' && rawBlob.length > 0 ? rawBlob : null;

  return checks(id, {
    'asset_detail.vision': [vision, json(detail, 'vision')],
    'asset_detail.description': [from(doc, 'description'), at(detail, 'description')],
    // Not on `AssetDoc` — see the note in `plan/assets.ts`. Probed here because
    // a field the types do not mention is exactly the one a mapper drops.
    'asset_detail.description_meta': [
      from(doc, 'description_meta'),
      json(detail, 'description_meta'),
    ],
    'asset_detail.ocr_text': [from(doc, 'ocr_text'), at(detail, 'ocr_text')],
    'asset_detail.vision_scene_type': [
      asRecord(vision).scene_type ?? null,
      at(detail, 'vision_scene_type'),
    ],
    'asset_search.search_blob': [blob, at(search, 'search_blob')],
  });
}

function probeStages(sqlite: Database, doc: Record<string, unknown>, id: string): FieldCheck[] {
  const rows = sqlite
    .query(`SELECT stage, version, attempts, dead FROM stage_state WHERE asset_id = ?`)
    .all(id) as Array<Record<string, unknown>>;
  const byName = new Map(rows.map((row) => [row.stage as string, row]));

  return Object.entries(asRecord(doc.stages)).flatMap(([name, raw]) => {
    const state = asRecord(raw);
    const row = byName.get(name);
    return checks(id, {
      [`stages.${name}.version`]: [state.version ?? 0, at(row, 'version')],
      [`stages.${name}.attempts`]: [state.attempts ?? 0, at(row, 'attempts')],
      [`stages.${name}.dead`]: [state.dead === true ? 1 : 0, at(row, 'dead')],
    });
  });
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
