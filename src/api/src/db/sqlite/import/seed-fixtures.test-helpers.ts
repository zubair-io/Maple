/**
 * Shared fixture values for the seeded test library.
 *
 * Split out so the three seeding modules can use them without importing each
 * other, and so the `ObjectId`s every collection cross-references are declared
 * in one place.
 */

import { ObjectId } from 'mongodb';

/** The throwaway instance the importer tests use. NEVER :27017. */
export const TEST_MONGO_URI = 'mongodb://localhost:27077';

/** The twelve canonical per-asset stage names, as of this schema. */
const STAGE_NAMES = [
  'exif',
  'thumb',
  'preview',
  'face-detect',
  'face-embed',
  'describe',
  'geocode',
  'meili',
  'sidecar-metadata-index',
  'cf-thumb-sync',
  'transcribe',
  'video-describe',
] as const;

/** Seeded ids the tests assert against. */
export interface SeedIds {
  libraryA: ObjectId;
  libraryB: ObjectId;
  /** Referenced by a location but never registered — the repair pass drops it. */
  unregisteredLibrary: ObjectId;
  owner: ObjectId;
  person: ObjectId;
  mergedPerson: ObjectId;
  assets: {
    rich: ObjectId;
    multiLocation: ObjectId;
    legacy: ObjectId;
    trashed: ObjectId;
    damaged: ObjectId;
    orphanLocation: ObjectId;
  };
  importJob: ObjectId;
  changeCursors: number[];
}

/** Fresh ids for one seeded library. */
export function newSeedIds(): SeedIds {
  return {
    libraryA: new ObjectId(),
    libraryB: new ObjectId(),
    unregisteredLibrary: new ObjectId(),
    owner: new ObjectId(),
    person: new ObjectId(),
    mergedPerson: new ObjectId(),
    assets: {
      rich: new ObjectId(),
      multiLocation: new ObjectId(),
      legacy: new ObjectId(),
      trashed: new ObjectId(),
      damaged: new ObjectId(),
      orphanLocation: new ObjectId(),
    },
    importJob: new ObjectId(),
    changeCursors: [],
  };
}

/** A deterministic ISO timestamp, `offsetDays` after 2026-01-01Z. */
export const iso = (offsetDays: number): string =>
  new Date(Date.UTC(2026, 0, 1) + offsetDays * 86_400_000).toISOString();

/** The blank `stages` skeleton discover writes on every new asset. */
export function stageSkeleton(): Record<string, unknown> {
  return Object.fromEntries(
    STAGE_NAMES.map((name) => [
      name,
      { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    ]),
  );
}

/** The blank `enrichment` subdocument the skeleton upsert seeds. */
export function pendingEnrichment(): Record<string, unknown> {
  const state = {
    done_at: null,
    locked_by: null,
    lease_expires_at: null,
    attempts: 0,
    last_error: null,
    version: null,
    dead_letter_at: null,
  };
  return { geocode: { ...state }, face: { ...state }, describe: { ...state } };
}

export const EXIF = {
  captured_at: '2026-01-04T10:11:12.000Z',
  captured_year: 2026,
  captured_month: 1,
  camera_make: 'Hasselblad',
  camera_model: 'L3D-100c',
  lens: 'Hasselblad 24mm f/1.5',
  iso: 200,
  aperture: 2.8,
  shutter: '1/250',
  focal_length: 24,
  gps: { lat: 42.6526, lng: -73.7562 },
  camera_serial: 'SN-0001',
};

export const PLACE = {
  source: 'nominatim',
  geocoder_version: 3,
  geocoded_at: iso(2),
  lat: 42.6526,
  lon: -73.7562,
  display_name: 'Albany, New York, United States',
  address: { city: 'Albany', state: 'New York', state_code: 'NY', country_code: 'us' },
  pois: [{ name: 'Empire State Plaza', category: 'tourism', type: 'attraction' }],
  rollups: { locality: 'Albany', region: 'New York', country_code: 'us' },
  search_blob: 'Albany New York United States',
};

/** A vision payload the size production carries, with awkward characters. */
export function visionDoc(): Record<string, unknown> {
  return {
    caption: 'A child in a red coat runs across a frozen field at "golden hour".',
    tags: Array.from({ length: 15 }, (_, index) => `tag-${index}`),
    subjects: ['child', 'landscape'],
    scene_type: 'outdoor',
    setting: 'field',
    activity: 'running',
    time_of_day: 'golden hour',
    lighting: 'natural',
    weather: 'clear',
    mood: 'joyful, cold',
    colors: ['red', 'white', 'grey'],
    framing: 'wide',
    text_visible: 'ÉLAN — 12 °C\nline two',
    notable_objects: ['coat', 'fence'],
    shot_type: 'action',
    is_screenshot: false,
    people_count: 1,
    nudity: 'none',
  };
}
