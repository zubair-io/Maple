/**
 * Fixtures for the auth and backup route suites, against SQLite (#3787).
 *
 * These suites used to seed MongoDB collections by hand: an `insertMany` of
 * whole documents, then a `deleteMany` in `afterAll` to keep the next file from
 * inheriting them. With `createLiveTestDatabase()` there is nothing to clean up
 * — each suite gets a private database that goes away with the block — so what
 * is left is the seeding, which is what lives here.
 *
 * `db/sqlite/test-sqlite.test-helpers.ts` already has `insertFolder`,
 * `insertAsset` and `insertLocation`. These are the shapes those do not cover:
 * an account with a passkey, and an asset as the *backup* routes see it — a
 * content id, a location in a library, and one or more PHAsset links.
 */

import type { Database } from 'bun:sqlite';
import { ObjectId } from 'mongodb';
import { newObjectIdHex } from '../../src/db/sqlite/object-id.ts';
import { run } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import type { UserRole } from '../../src/db/schema.ts';

/** A library root. The `path` is what the backup routes join relative paths
 * against, so a suite passes its own tmp directory. */
export function seedLibrary(
  db: Database,
  opts: { path: string; label?: string; slug?: string } = { path: '/libraries/test' },
): ObjectId {
  const id = newObjectIdHex();
  run(
    db,
    `INSERT INTO folders (id, path, slug, label, file_count, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    id,
    opts.path,
    opts.slug ?? `lib-${id.slice(-8)}`,
    opts.label ?? 'test',
    new Date().toISOString(),
  );
  return new ObjectId(id);
}

/** One account. `fileAccess` left undefined stores NULL, which reads as true —
 * the state every account created before the permission existed is in. */
export function seedUser(
  db: Database,
  opts: {
    email: string;
    role?: UserRole;
    fileAccess?: boolean;
    createdAt?: string;
    lastSeenAt?: string | null;
  },
): ObjectId {
  const id = newObjectIdHex();
  run(
    db,
    `INSERT INTO users (id, email, role, file_access, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    opts.email,
    opts.role ?? 'owner',
    opts.fileAccess === undefined ? null : opts.fileAccess ? 1 : 0,
    opts.createdAt ?? new Date().toISOString(),
    opts.lastSeenAt === undefined ? null : opts.lastSeenAt,
  );
  return new ObjectId(id);
}

/** One passkey. The key bytes are only ever read back by an assertion
 * verification, so a suite that is not running a ceremony can leave them. */
export function seedCredential(
  db: Database,
  opts: {
    userId: ObjectId;
    credentialId: string;
    publicKey?: Uint8Array;
    counter?: number;
    transports?: string[];
    deviceLabel?: string;
    createdAt?: string;
    lastUsedAt?: string | null;
  },
): ObjectId {
  const id = newObjectIdHex();
  run(
    db,
    `INSERT INTO credentials
       (id, user_id, credential_id, public_key, counter, transports, device_label,
        created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    opts.userId.toHexString(),
    opts.credentialId,
    opts.publicKey ?? new Uint8Array([1, 2, 3]),
    opts.counter ?? 0,
    JSON.stringify(opts.transports ?? []),
    opts.deviceLabel ?? 'Test device',
    opts.createdAt ?? new Date().toISOString(),
    opts.lastUsedAt === undefined ? null : opts.lastUsedAt,
  );
  return new ObjectId(id);
}

/** One invite code. */
export function seedInvite(
  db: Database,
  opts: {
    code: string;
    email: string;
    invitedBy: ObjectId;
    expiresAt?: Date;
    consumedAt?: string | null;
  },
): void {
  run(
    db,
    `INSERT INTO invites (id, code, email, invited_by, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newObjectIdHex(),
    opts.code,
    opts.email,
    opts.invitedBy.toHexString(),
    (opts.expiresAt ?? new Date(Date.now() + 15 * 60_000)).toISOString(),
    opts.consumedAt ?? null,
  );
}

/** One PHAsset link on an existing asset. */
export function seedPhassetLink(
  db: Database,
  opts: {
    assetId: ObjectId;
    deviceId: string;
    phassetLocalId: string;
    phassetCloudId?: string | null;
    firstSeen?: Date;
  },
): void {
  run(
    db,
    `INSERT INTO asset_phasset_links
       (asset_id, device_id, phasset_local_id, phasset_cloud_id, first_seen)
     VALUES (?, ?, ?, ?, ?)`,
    opts.assetId.toHexString(),
    opts.deviceId,
    opts.phassetLocalId,
    opts.phassetCloudId ?? null,
    (opts.firstSeen ?? new Date()).toISOString(),
  );
}

export interface BackupAssetLocation {
  libraryId: ObjectId;
  /** Library-relative path, e.g. `2024/Tokyo/IMG.HEIC` or just `a.heic`. */
  relPath: string;
  deletedAt?: string | null;
}

/**
 * An asset as the backup routes see it: a content id, one or more locations,
 * and the device links that say which iCloud photos it came from.
 *
 * `live_location_count` is not written — the `asset_locations` triggers keep it
 * in step, exactly as they do in production.
 */
export function seedBackupAsset(
  db: Database,
  opts: {
    mapleId?: string | null;
    locations: BackupAssetLocation[];
    links?: { deviceId: string; phassetLocalId: string; firstSeen?: Date; cloudId?: string }[];
    size?: number;
    deletedFromPhotos?: boolean;
    appleRenderedPath?: string | null;
    isScreenshot?: boolean | null;
  },
): ObjectId {
  const id = newObjectIdHex();
  run(
    db,
    `INSERT INTO assets
       (id, size, mtime, indexed_at, maple_id, deleted_from_photos, apple_rendered_path,
        is_screenshot)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
    id,
    opts.size ?? 1,
    new Date().toISOString(),
    opts.mapleId ?? null,
    opts.deletedFromPhotos ? 1 : 0,
    opts.appleRenderedPath ?? null,
    opts.isScreenshot === undefined || opts.isScreenshot === null
      ? null
      : opts.isScreenshot
        ? 1
        : 0,
  );
  const assetId = new ObjectId(id);
  opts.locations.forEach((location, ordinal) => {
    const slash = location.relPath.lastIndexOf('/');
    run(
      db,
      `INSERT INTO asset_locations (asset_id, ordinal, library_id, path, filename, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      ordinal,
      location.libraryId.toHexString(),
      slash === -1 ? '' : location.relPath.slice(0, slash),
      slash === -1 ? location.relPath : location.relPath.slice(slash + 1),
      location.deletedAt ?? null,
    );
  });
  for (const link of opts.links ?? []) {
    seedPhassetLink(db, {
      assetId,
      deviceId: link.deviceId,
      phassetLocalId: link.phassetLocalId,
      phassetCloudId: link.cloudId ?? null,
      firstSeen: link.firstSeen,
    });
  }
  return assetId;
}

/** The asset row, for an assertion. `null` when there is no such asset. */
export function readAsset(db: Database, id: ObjectId): Record<string, unknown> | null {
  return (db.query(`SELECT * FROM assets WHERE id = ?`).get(id.toHexString()) ?? null) as Record<
    string,
    unknown
  > | null;
}

/** One asset's locations, in array order. */
export function readLocations(db: Database, id: ObjectId): Record<string, unknown>[] {
  return db
    .query(`SELECT * FROM asset_locations WHERE asset_id = ? ORDER BY ordinal`)
    .all(id.toHexString()) as Record<string, unknown>[];
}

/** One asset's PHAsset links, oldest first. */
export function readPhassetLinks(db: Database, id: ObjectId): Record<string, unknown>[] {
  return db
    .query(`SELECT * FROM asset_phasset_links WHERE asset_id = ? ORDER BY id`)
    .all(id.toHexString()) as Record<string, unknown>[];
}

/** Every asset carrying this content id, newest insert last. */
export function findAssetsByMapleId(db: Database, mapleId: string): Record<string, unknown>[] {
  return db.query(`SELECT * FROM assets WHERE maple_id = ?`).all(mapleId) as Record<
    string,
    unknown
  >[];
}

/**
 * The one asset carrying this content id, or `null`.
 *
 * `assets_maple_id` is unique over non-null ids, so "the row with this
 * maple_id" is a single answer — this is the id an assertion then reads
 * locations or links for.
 */
export function findAssetIdByMapleId(db: Database, mapleId: string): ObjectId | null {
  const row = db.query(`SELECT id FROM assets WHERE maple_id = ?`).get(mapleId) as {
    id: string;
  } | null;
  return row === null ? null : new ObjectId(row.id);
}

/**
 * Every PHAsset link carrying this local id, whichever asset or device it
 * belongs to.
 *
 * Stands in for the `findOne({ 'phasset_links.phasset_local_id': … })` the
 * backup suites used to assert an upload was recorded: the link row IS the
 * record, so its presence is the assertion and its columns are the detail.
 */
export function findPhassetLinksByLocalId(
  db: Database,
  phassetLocalId: string,
): Record<string, unknown>[] {
  return db
    .query(`SELECT * FROM asset_phasset_links WHERE phasset_local_id = ? ORDER BY id`)
    .all(phassetLocalId) as Record<string, unknown>[];
}
