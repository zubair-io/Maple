/**
 * One small library the search tests share, with every filter's worth of
 * variation in it and every liveness edge case around it.
 *
 * A fixture per test file would be cheaper to read and would not have caught
 * the thing this one is for: a facet, a count and a page all have to agree
 * about which assets exist, and they only can if they are all looking at the
 * same library. So there is one, it is built the same way every time, and the
 * three excluded assets at the end are as much a part of it as the ten live
 * ones — an asset that is soft-deleted, one whose only file was replaced, and
 * one whose file has gone missing must appear in no count, no facet and no
 * page.
 */

import type { Database } from 'bun:sqlite';
import { newObjectIdHex } from '../object-id.ts';
import { insertFolder, run } from '../test-sqlite.test-helpers.ts';
import { insertDetail, insertFace, insertPerson } from './assets.test-helpers.ts';

/** Everything one fixture asset varies. */
export interface SeedAsset {
  id?: string;
  filename?: string;
  path?: string;
  capturedAt?: string | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  lens?: string | null;
  iso?: number | null;
  aperture?: number | null;
  focalLength?: number | null;
  gps?: { lat: number; lng: number } | null;
  locality?: string | null;
  region?: string | null;
  countryCode?: string | null;
  rating?: number;
  flag?: -1 | 0 | 1;
  colorLabel?: string;
  hasXmp?: boolean;
  hidden?: boolean;
  isScreenshot?: boolean;
  mediaKind?: 'image' | 'video' | 'audio';
  mapleId?: string | null;
  /** Soft-deleted at the asset level. */
  deletedAt?: string | null;
  /** The single location's non-live tags. */
  locationDeletedAt?: string | null;
  locationMissingSince?: string | null;
  sceneType?: string | null;
  activity?: string | null;
  subjects?: string[];
  description?: string | null;
  ocrText?: string | null;
  searchBlob?: string | null;
  people?: string[];
}

/** A seeded library: the ids it created, keyed by the names tests use. */
export interface SeededLibrary {
  libraryId: string;
  /** Asset filename (without extension) → asset id. */
  assets: Map<string, string>;
  /** Person name → person id. */
  people: Map<string, string>;
}

function isoOrNull(value: string | null | undefined): string | null {
  return value === undefined ? '2024-06-01T12:00:00.000Z' : value;
}

/** The `exif` JSON column for one fixture asset, or NULL when it has none. */
function exifJson(asset: SeedAsset): string | null {
  const capturedAt = isoOrNull(asset.capturedAt);
  const captured = capturedAt === null ? null : new Date(capturedAt);
  const exif = {
    captured_at: capturedAt,
    captured_year: captured?.getUTCFullYear() ?? null,
    captured_month: captured === null ? null : captured.getUTCMonth() + 1,
    camera_make: asset.cameraMake ?? null,
    camera_model: asset.cameraModel ?? null,
    lens: asset.lens ?? null,
    iso: asset.iso ?? null,
    aperture: asset.aperture ?? null,
    focal_length: asset.focalLength ?? null,
    gps: asset.gps ?? null,
  };
  return JSON.stringify(exif);
}

/** The `place` JSON column, or NULL when the asset was never geocoded. */
function placeJson(asset: SeedAsset): string | null {
  const locality = asset.locality ?? null;
  const region = asset.region ?? null;
  const countryCode = asset.countryCode ?? null;
  if (locality === null && region === null && countryCode === null) return null;
  return JSON.stringify({
    source: 'nominatim',
    geocoder_version: 3,
    rollups: { locality, region, country_code: countryCode },
    search_blob: [locality, region]
      .filter((part) => part !== null)
      .join(' ')
      .toLowerCase(),
  });
}

/** Inserts one asset, its single location, and whatever hangs off it. */
function seedAsset(db: Database, libraryId: string, asset: SeedAsset, people: Map<string, string>) {
  const id = asset.id ?? newObjectIdHex();
  run(
    db,
    `INSERT INTO assets
       (id, size, mtime, indexed_at, rating, flag, color_label, has_xmp, media_kind,
        hidden, is_screenshot, deleted_at, maple_id, exif, place)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    1024,
    1_700_000_000_000,
    '2024-01-01T00:00:00.000Z',
    asset.rating ?? 0,
    asset.flag ?? 0,
    asset.colorLabel ?? '',
    asset.hasXmp === true ? 1 : 0,
    asset.mediaKind ?? 'image',
    asset.hidden === true ? 1 : 0,
    asset.isScreenshot === true ? 1 : 0,
    asset.deletedAt ?? null,
    asset.mapleId ?? `maple-${id}`,
    exifJson(asset),
    placeJson(asset),
  );

  run(
    db,
    `INSERT INTO asset_locations
       (asset_id, ordinal, library_id, path, filename, deleted_at, missing_since)
     VALUES (?, 0, ?, ?, ?, ?, ?)`,
    id,
    libraryId,
    asset.path ?? 'trips/2024',
    asset.filename ?? `${id}.dng`,
    asset.locationDeletedAt ?? null,
    asset.locationMissingSince ?? null,
  );

  const hasDetail =
    asset.sceneType !== undefined ||
    asset.activity !== undefined ||
    asset.subjects !== undefined ||
    asset.description !== undefined ||
    asset.ocrText !== undefined;
  if (hasDetail) {
    insertDetail(db, id, {
      description: asset.description ?? null,
      ocrText: asset.ocrText ?? null,
      vision: JSON.stringify({
        scene_type: asset.sceneType ?? null,
        activity: asset.activity ?? null,
        subjects: asset.subjects ?? [],
      }),
    });
  }

  if (asset.searchBlob != null) {
    run(db, `INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)`, id, asset.searchBlob);
  }

  for (const [index, name] of (asset.people ?? []).entries()) {
    const personId = people.get(name) ?? insertPerson(db, name);
    people.set(name, personId);
    insertFace(db, { assetId: id, faceIndex: index, personId });
  }

  return id;
}

/**
 * The shared library.
 *
 * Ten live assets and three that must never surface. The values are chosen so
 * that most facets have at least two buckets of different sizes — a facet with
 * one bucket cannot tell a correct `GROUP BY` from a broken one — and so that
 * every text field a search touches has a distinctive, findable token in it.
 */
export function seedSearchLibrary(db: Database): SeededLibrary {
  const libraryId = insertFolder(db, { slug: 'trips' });
  const people = new Map<string, string>();
  const assets = new Map<string, string>();

  const rows: Array<[string, SeedAsset]> = [
    [
      'harbour',
      {
        filename: 'harbour.dng',
        capturedAt: '2024-06-01T12:00:00.000Z',
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15 Pro',
        lens: 'iPhone 15 Pro back camera',
        iso: 100,
        aperture: 1.8,
        focalLength: 24,
        gps: { lat: 42.65, lng: -73.75 },
        locality: 'Albany',
        region: 'New York',
        countryCode: 'us',
        rating: 5,
        hasXmp: true,
        sceneType: 'outdoor',
        activity: 'sailing',
        subjects: ['boat', 'water'],
        description: 'a quiet harbour at dawn',
        searchBlob: 'albany new york a quiet harbour at dawn zephyrhold',
        people: ['Ada'],
      },
    ],
    [
      'kitchen',
      {
        filename: 'kitchen.jpg',
        capturedAt: '2024-06-02T12:00:00.000Z',
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15 Pro',
        lens: 'iPhone 15 Pro back camera',
        iso: 800,
        aperture: 2.8,
        focalLength: 35,
        locality: 'Albany',
        region: 'New York',
        countryCode: 'us',
        rating: 3,
        sceneType: 'indoor',
        activity: 'cooking',
        subjects: ['bread'],
        description: 'bread cooling on a kitchen counter',
        searchBlob: 'albany new york bread cooling on a kitchen counter',
        people: ['Ada', 'Grace'],
      },
    ],
    [
      'skyline',
      {
        filename: 'skyline.dng',
        path: 'trips/2023',
        capturedAt: '2023-08-11T09:00:00.000Z',
        cameraMake: 'SONY',
        cameraModel: 'ILCE-7RM5',
        lens: 'FE 24-70mm F2.8 GM II',
        iso: 200,
        aperture: 8,
        focalLength: 70,
        gps: { lat: 40.71, lng: -74.0 },
        locality: 'New York City',
        region: 'New York',
        countryCode: 'us',
        rating: 4,
        colorLabel: 'blue',
        flag: 1,
        sceneType: 'aerial',
        subjects: ['bridge'],
        description: 'the skyline from the bridge',
        searchBlob: 'new york city the skyline from the bridge',
      },
    ],
    [
      'lantern',
      {
        filename: 'lantern.dng',
        path: 'trips/2023',
        capturedAt: '2023-08-12T21:00:00.000Z',
        cameraMake: 'SONY',
        cameraModel: 'ILCE-7M4',
        lens: 'FE 24-70mm F2.8 GM II',
        iso: 3200,
        locality: 'Kyoto',
        region: 'Kansai',
        countryCode: 'jp',
        rating: 2,
        sceneType: 'outdoor',
        description: 'paper lanterns over a narrow street',
        searchBlob: 'kyoto kansai paper lanterns over a narrow street',
      },
    ],
    [
      'macro',
      {
        filename: 'macro.tif',
        capturedAt: '2022-03-04T08:00:00.000Z',
        cameraMake: 'Canon',
        cameraModel: 'EOS R5',
        lens: 'RF100mm F2.8 L MACRO',
        iso: 400,
        sceneType: 'macro',
        subjects: ['flower'],
        searchBlob: 'a flower in close focus quillmarsh',
      },
    ],
    [
      'screenshot',
      {
        filename: 'Screenshot 2024.png',
        capturedAt: '2024-02-14T10:00:00.000Z',
        isScreenshot: true,
        searchBlob: 'a screenshot of a receipt',
        ocrText: 'total due 42.00',
      },
    ],
    [
      'hidden',
      {
        filename: 'private.dng',
        capturedAt: '2024-05-05T10:00:00.000Z',
        cameraMake: 'Canon',
        cameraModel: 'EOS R5',
        hidden: true,
        searchBlob: 'a private frame',
      },
    ],
    [
      'undated',
      {
        filename: 'undated.dng',
        capturedAt: null,
        cameraMake: 'FUJIFILM',
        cameraModel: 'X-T5',
        lens: null,
        searchBlob: 'no capture date on this one',
      },
    ],
    [
      'clip',
      {
        filename: 'clip.mp4',
        capturedAt: '2024-04-01T12:00:00.000Z',
        mediaKind: 'video',
        cameraMake: 'Apple',
        cameraModel: 'iPhone 13',
        searchBlob: 'a short clip of the harbour',
      },
    ],
    [
      'unplaced',
      {
        filename: 'unplaced.dng',
        capturedAt: '2021-12-25T12:00:00.000Z',
        cameraMake: 'FUJIFILM',
        cameraModel: 'X-T5',
        lens: 'XF16-55mmF2.8 R LM WR',
        iso: 1600,
        people: ['Grace'],
      },
    ],
    // The three that must never appear.
    ['trashed', { filename: 'trashed.dng', deletedAt: '2024-07-01T00:00:00.000Z' }],
    ['replaced', { filename: 'replaced.dng', locationDeletedAt: '2024-07-01T00:00:00.000Z' }],
    ['vanished', { filename: 'vanished.dng', locationMissingSince: '2024-07-01T00:00:00.000Z' }],
  ];

  for (const [name, asset] of rows) {
    assets.set(name, seedAsset(db, libraryId, asset, people));
  }
  return { libraryId, assets, people };
}

/** The ten assets of {@link seedSearchLibrary} that are live and visible. */
export const LIVE_ASSET_NAMES = [
  'harbour',
  'kitchen',
  'skyline',
  'lantern',
  'macro',
  'screenshot',
  'undated',
  'clip',
  'unplaced',
] as const;

/** Live but hidden, so absent from every default search. */
export const HIDDEN_ASSET_NAME = 'hidden';
