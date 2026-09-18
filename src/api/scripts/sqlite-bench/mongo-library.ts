/**
 * The MongoDB half of the `findListItems` comparison: the same synthetic
 * library the SQLite generator builds, written as documents.
 *
 * Document *size* is the whole point of this file. Production asset documents
 * average 8 KB, p90 28 KB, because of the vision payload, the transcript and
 * the 512-float face embeddings — and those are precisely the fields the
 * unprojected list query fetches and then throws away. A generator that
 * produced tidy 400-byte fixtures would measure nothing.
 *
 * The distributions are the ones `./generate.ts` uses, drawn from the same
 * `./fixtures.ts` vocabularies and the same seeded PRNG, so the two libraries
 * are comparable rather than merely similar.
 */

import { ObjectId, type Db } from 'mongodb';
import { CAMERAS, LENSES, PLACES, SCENES, skewedIndex, words } from './fixtures.ts';
import { makeRandom } from './generate.ts';

type Random = () => number;

const BATCH = 5000;
const EMBEDDING_LENGTH = 512;
const STAGES = ['exif', 'thumb', 'preview', 'describe', 'geocode', 'meili'];

function exifFor(index: number, captured: Date, random: Random): object {
  const [make, model] = CAMERAS[skewedIndex(random, CAMERAS.length)]!;
  return {
    captured_at: captured.toISOString(),
    captured_year: captured.getUTCFullYear(),
    captured_month: captured.getUTCMonth() + 1,
    camera_make: make,
    camera_model: model,
    lens: LENSES[skewedIndex(random, LENSES.length)],
    iso: [100, 200, 400, 800, 1600][index % 5],
    gps: { lat: 40 + random(), lng: -74 + random() },
  };
}

function placeFor(random: Random): object {
  const [countryCode, region, locality] = PLACES[skewedIndex(random, PLACES.length)]!;
  return {
    source: 'nominatim',
    geocoder_version: 3,
    rollups: { locality, region, country_code: countryCode },
    search_blob: `${locality} ${region}`.toLowerCase(),
  };
}

/** The describe stage's output — the largest thing an asset carries. */
function visionFor(random: Random): object | null {
  if (random() >= 0.8) return null;
  return {
    caption: words(random, 40),
    tags: Array.from({ length: 12 }, () => words(random, 1)),
    subjects: Array.from({ length: 6 }, () => words(random, 1)),
    setting: words(random, 2),
    scene_type: SCENES[skewedIndex(random, SCENES.length)],
    notable_objects: Array.from({ length: 8 }, () => words(random, 2)),
    text_visible: words(random, 30),
  };
}

/** The caption and OCR text that ride alongside a vision payload. */
function textFor(
  vision: object | null,
  random: Random,
): { description: string | null; ocr: string | null } {
  if (vision === null) return { description: null, ocr: null };
  return { description: words(random, 40), ocr: words(random, 30) };
}

/** A speech transcript, on the one clip in ten that has audio worth indexing. */
function transcriptFor(random: Random): object | null {
  if (random() >= 0.1) return null;
  return { text: words(random, 400), language: 'en' };
}

/** Two detections with real-length ArcFace vectors, or none. */
function facesFor(random: Random): object[] {
  const count = random() < 0.4 ? 2 : 0;
  return Array.from({ length: count }, () => ({
    bbox: { x: random(), y: random(), w: 0.2, h: 0.2 },
    person_id: null,
    confidence: 0.9,
    embedding: Array.from({ length: EMBEDDING_LENGTH }, () => Math.round(random() * 1e6) / 1e6),
    embedding_version: 'arcface_r100_glint360k_v1',
  }));
}

function stagesFor(captured: Date): object {
  return Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      { version: 1, attempts: 0, dead: false, processed_at: captured.toISOString() },
    ]),
  );
}

function phassetLinksFor(index: number, captured: Date, random: Random): object[] {
  if (random() >= 0.5) return [];
  return [
    {
      device_id: `device-${index % 4}`,
      phasset_local_id: `${new ObjectId().toHexString()}/L0/001`,
      first_seen: captured.toISOString(),
    },
  ];
}

/** One asset document, shaped like production rather than like a fixture. */
function assetDocument(index: number, libraryId: ObjectId, random: Random): object {
  const captured = new Date(Date.UTC(2019 + (index % 7), index % 12, (index % 27) + 1));
  const vision = visionFor(random);
  const text = textFor(vision, random);
  return {
    _id: new ObjectId(),
    fileinfo: [
      {
        path: `${2019 + (index % 7)}/${String((index % 12) + 1).padStart(2, '0')}`,
        filename: `IMG_${String(index).padStart(7, '0')}.dng`,
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    size: 40_000_000 + index,
    mtime: captured.getTime(),
    rating: index % 6,
    flag: 0,
    color_label: '',
    has_xmp: random() < 0.35,
    sidecar_ver: 0,
    hidden: false,
    hidden_ack: false,
    is_screenshot: random() < 0.08,
    indexed_at: captured.toISOString(),
    live_location_count: 1,
    deleted_at: null,
    exif: exifFor(index, captured, random),
    place: placeFor(random),
    vision,
    description: text.description,
    ocr_text: text.ocr,
    transcript: transcriptFor(random),
    faces: facesFor(random),
    search_blob: words(random, 60),
    stages: stagesFor(captured),
    phasset_links: phassetLinksFor(index, captured, random),
  };
}

/**
 * Fills a database with `assetCount` documents and the two indexes production
 * carries for these query shapes — the live-asset partial index and the browse
 * sort key. Deliberately *not* an index on the phasset fields: there is none
 * in production, which is the defect being measured.
 */
export async function buildMongoLibrary(db: Db, assetCount: number): Promise<ObjectId> {
  const libraryId = new ObjectId();
  await db.collection('folders').insertOne({ _id: libraryId, path: '/libraries/bench' } as never);
  const assets = db.collection('assets');
  const random = makeRandom(0x5eed);

  const batch: object[] = [];
  for (let i = 0; i < assetCount; i += 1) {
    batch.push(assetDocument(i, libraryId, random));
    if (batch.length === BATCH) {
      await assets.insertMany(batch as never[]);
      batch.length = 0;
    }
  }
  if (batch.length > 0) await assets.insertMany(batch as never[]);

  await assets.createIndex({ deleted_at: 1 }, { partialFilterExpression: { deleted_at: null } });
  await assets.createIndex({ 'fileinfo.library_id': 1, 'exif.captured_at': -1, _id: 1 });
  return libraryId;
}
