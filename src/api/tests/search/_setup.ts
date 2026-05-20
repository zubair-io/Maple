/**
 * Shared scaffolding for the search-route test suites. Each test file in
 * `tests/search/` is self-contained — it sets its own `MAPLE_MONGO_DB`,
 * connects, seeds, and tears down — but they share the same shape of
 * fixture data so assertions can read clearly.
 *
 * Why a `_` prefix? Bun's test runner picks up every `*.test.ts` file
 * under `tests/`; the leading underscore is a hint that this file is
 * helpers, not a test module.
 */

import { MongoClient, ObjectId } from "mongodb";
import type { Db } from "mongodb";
import { signAccessToken } from "../../src/auth/tokens.ts";

// JWT bootstrap MUST run before any module that touches `requireAuth`.
// Each test file imports this module before any dynamic `searchRoutes`
// import, so a single env-write here covers them all.
process.env.MAPLE_JWT_SECRET = "x".repeat(32);

const SECRET = process.env.MAPLE_JWT_SECRET!;

export const BEARER =
  "Bearer " +
  signAccessToken(
    {
      sub: "00000000000000000000000a",
      email: "tester@maple.local",
      role: "owner",
    },
    SECRET,
  );

export function fmtAuth(): Record<string, string> {
  return { Authorization: BEARER };
}

export const MONGO_URI =
  process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";

export async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

export interface Seed {
  abs_path: string;
  filename: string;
  size: number;
  mtime: number;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  indexed_at: string;
  folder_id: ObjectId;
  exif?: {
    captured_at: string | null;
    camera_make: string | null;
    camera_model: string | null;
    lens: string | null;
    iso: number | null;
    aperture: number | null;
    shutter: string | null;
    focal_length: number | null;
    gps: { lat: number; lng: number } | null;
  } | null;
  deleted_at?: string | null;
}

/**
 * The 5-row base seed shared by the list, facets, and buckets suites.
 * Counts: 4 live + 1 soft-deleted; covers all three EXIF cameras + a
 * row with no EXIF + a row with a regex-friendly filename.
 */
export function baseSeeds(folderA: ObjectId, folderB: ObjectId): Seed[] {
  return [
    {
      folder_id: folderA,
      abs_path: "/lib-a/dji-mavic3pro-100mp.dng",
      filename: "dji-mavic3pro-100mp.dng",
      size: 1024,
      mtime: Date.now(),
      rating: 5,
      flag: 1,
      color_label: "red",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2024-06-01T12:00:00.000Z",
        camera_make: "Hasselblad",
        camera_model: "L3D-100c",
        lens: "Hasselblad 24mm f/1.5",
        iso: 100,
        aperture: 2.8,
        shutter: "1/250",
        focal_length: 24,
        gps: { lat: 52.5, lng: 13.4 },
      },
    },
    {
      folder_id: folderA,
      abs_path: "/lib-a/sunset.cr3",
      filename: "sunset.cr3",
      size: 2048,
      mtime: Date.now() - 1000,
      rating: 3,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2023-12-25T18:30:00.000Z",
        camera_make: "Canon",
        camera_model: "EOS R5",
        lens: "RF 24-70mm f/2.8L IS USM",
        iso: 800,
        aperture: 5.6,
        shutter: "1/60",
        focal_length: 50,
        gps: null,
      },
    },
    {
      folder_id: folderB,
      abs_path: "/lib-b/sony.arw",
      filename: "sony.arw",
      size: 4096,
      mtime: Date.now() - 2000,
      rating: 4,
      flag: 1,
      color_label: "green",
      indexed_at: new Date().toISOString(),
      exif: {
        captured_at: "2024-01-15T09:15:00.000Z",
        camera_make: "Sony",
        camera_model: "A7R V",
        lens: "FE 70-200mm f/2.8 GM",
        iso: 1600,
        aperture: 4.0,
        shutter: "1/1000",
        focal_length: 200,
        gps: null,
      },
    },
    {
      folder_id: folderB,
      abs_path: "/lib-b/no-exif.jpg",
      filename: "no-exif.jpg",
      size: 512,
      mtime: Date.now() - 3000,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
    },
    {
      // Soft-deleted row — must NOT appear in search results.
      folder_id: folderB,
      abs_path: "/lib-b/deleted.dng",
      filename: "deleted.dng",
      size: 256,
      mtime: Date.now() - 4000,
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      exif: null,
      deleted_at: new Date().toISOString(),
    },
  ];
}

/**
 * Backfill exif.captured_year/month so the /buckets index-only path has
 * data to find. Mirrors the migration in `ensureIndexes()`; run inline
 * here because the test bypasses the normal startup flow.
 */
export async function backfillCapturedYearMonth(db: Db): Promise<void> {
  await db.collection("assets").updateMany(
    {
      "exif.captured_at": { $ne: null, $exists: true },
      "exif.captured_year": { $exists: false },
    },
    [
      {
        $set: {
          "exif.captured_year": {
            $year: {
              $dateFromString: {
                dateString: "$exif.captured_at",
                onError: null,
                onNull: null,
              },
            },
          },
          "exif.captured_month": {
            $month: {
              $dateFromString: {
                dateString: "$exif.captured_at",
                onError: null,
                onNull: null,
              },
            },
          },
        },
      },
    ],
  );
}
