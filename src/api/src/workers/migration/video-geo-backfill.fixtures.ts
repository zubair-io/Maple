/**
 * Shared fixtures for the video-GPS-backfill migration tests
 * (`audit-video-geo-backfill` + `apply-video-geo-backfill`). Pure document
 * builders plus the two library ids both suites use — extracted from the test
 * file to keep each test under the file-size budget.
 */

import { ObjectId } from 'mongodb';

export const LIB_A = new ObjectId();
export const LIB_B = new ObjectId();

export function videoAsset(
  id: ObjectId,
  opts: {
    capturedAt?: string | null;
    gps?: { lat: number; lng: number } | null;
    libraryId?: ObjectId;
    filename?: string;
    backupLayoutVersion?: number;
    deleted_at?: string | null;
    missing_since?: string | null;
  } = {},
) {
  const {
    capturedAt = '2019-05-18T17:45:35.000Z',
    gps = null,
    libraryId = LIB_A,
    filename = `clip_${id.toHexString()}.mp4`,
    backupLayoutVersion,
    deleted_at = null,
    missing_since = null,
  } = opts;

  const doc: Record<string, unknown> = {
    _id: id,
    maple_id: id.toHexString(),
    size: 1000,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    fileinfo: [
      {
        path: 'videos',
        filename,
        library_id: libraryId,
        deleted_at,
        missing_since,
      },
    ],
    exif: {
      captured_at: capturedAt,
      captured_year: capturedAt ? new Date(capturedAt).getUTCFullYear() : null,
      captured_month: capturedAt ? new Date(capturedAt).getUTCMonth() + 1 : null,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps,
    },
    stages: {
      geocode: { version: 2, attempts: 0, last_error: null, dead: false, processed_at: null },
    },
  };

  if (backupLayoutVersion !== undefined) {
    doc.backup_layout_version = backupLayoutVersion;
  }

  return doc;
}

export function photoAsset(
  id: ObjectId,
  opts: {
    capturedAt?: string;
    gps?: { lat: number; lng: number };
    libraryId?: ObjectId;
    filename?: string;
    deleted_at?: string | null;
    missing_since?: string | null;
  } = {},
) {
  const {
    capturedAt = '2019-05-18T17:45:35.000Z',
    gps = { lat: 37.7749, lng: -122.4194 },
    libraryId = LIB_A,
    filename = `photo_${id.toHexString()}.jpg`,
    deleted_at = null,
    missing_since = null,
  } = opts;

  return {
    _id: id,
    maple_id: id.toHexString(),
    size: 5000,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    deleted_at: null,
    fileinfo: [
      {
        path: 'photos',
        filename,
        library_id: libraryId,
        deleted_at,
        missing_since,
      },
    ],
    exif: {
      captured_at: capturedAt,
      captured_year: new Date(capturedAt).getUTCFullYear(),
      captured_month: new Date(capturedAt).getUTCMonth() + 1,
      camera_make: 'Apple',
      camera_model: 'iPhone 15',
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps,
    },
    stages: {
      geocode: { version: 2, attempts: 0, last_error: null, dead: false, processed_at: null },
    },
  };
}
