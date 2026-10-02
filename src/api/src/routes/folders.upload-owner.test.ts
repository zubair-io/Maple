import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { ObjectId } from '../db/object-id.ts';
import { upsertUploadedAsset, type UploadedAsset } from '../db/repos/assets.address.ts';
import type { SqliteDb } from '../db/repos/db-handle.ts';
import type { SqlParams } from '../db/sqlite/protocol.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { mkdtemp, readFile, rm } from '../fs/mirrored.ts';
import { foldersRoutes } from './folders.ts';

const memberId = '1'.repeat(24);
const serverOwnerId = '2'.repeat(24);
const unknownUserId = '3'.repeat(24);

function seedUsers(live: LiveTestDatabase): void {
  for (const [id, role] of [
    [memberId, 'member'],
    [serverOwnerId, 'owner'],
  ] as const) {
    run(
      live.db,
      'INSERT INTO users (id, email, email_key, role, file_access, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      id,
      `${role}@maple.local`,
      `${role}@maple.local`,
      role,
      new Date().toISOString(),
    );
  }
}

function owner(live: LiveTestDatabase, assetId: string): string | null {
  return (
    live.db.query('SELECT owner_id FROM assets WHERE id = ?').get(assetId) as {
      owner_id: string | null;
    }
  ).owner_id;
}

function uploadInput(libraryId: string, ownerId?: string): UploadedAsset {
  return {
    libraryId: new ObjectId(libraryId),
    path: '',
    filename: 'upload.dng',
    size: 4,
    mtimeMs: Date.now(),
    indexedAt: new Date().toISOString(),
    mediaKind: 'image',
    stages: ['thumb'],
    ownerId,
  };
}

function watcherAsset(live: LiveTestDatabase, libraryId: string): string {
  const id = insertAsset(live.db);
  insertLocation(live.db, { assetId: id, libraryId, path: '', filename: 'upload.dng' });
  run(live.db, 'UPDATE assets SET owner_id = ? WHERE id = ?', serverOwnerId, id);
  return id;
}

test.each(['upload.dng', 'vacation/2024/upload.dng'])(
  'direct upload %s records the authenticated member and preserves bytes',
  async (target) => {
    using live = await createLiveTestDatabase();
    seedUsers(live);
    const folderPath = await mkdtemp(path.join(tmpdir(), 'maple-upload-owner-'));
    try {
      const folderId = insertFolder(live.db, { path: folderPath, slug: 'upload-owner' });
      const app = new Elysia().use(fakeAuth({ sub: memberId, role: 'member' })).use(foldersRoutes);
      const bytes = new Uint8Array([0x49, 0x49, 0x2a, 0]);
      const response = await app.handle(
        new Request(`http://localhost/api/folders/${folderId}/upload`, {
          method: 'POST',
          headers: {
            'X-Maple-Target-Path': target,
            'X-Maple-Owner-Id': serverOwnerId,
            'Content-Type': 'application/octet-stream',
          },
          body: bytes,
        }),
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { asset_id: string };
      expect(new Uint8Array(await readFile(path.join(folderPath, target)))).toEqual(bytes);
      expect(owner(live, body.asset_id)).toBe(memberId);
    } finally {
      await rm(folderPath, { recursive: true, force: true });
    }
  },
);

test('upload replaces watcher attribution while reusing its asset and address', async () => {
  using live = await createLiveTestDatabase();
  seedUsers(live);
  const libraryId = insertFolder(live.db);
  const existing = watcherAsset(live, libraryId);
  const result = await upsertUploadedAsset(uploadInput(libraryId, memberId), live.handle);
  expect(result.toHexString()).toBe(existing);
  expect(owner(live, existing)).toBe(memberId);
  expect(live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
});

test('upload attributes the watcher winner when the address insert loses a race', async () => {
  using live = await createLiveTestDatabase();
  seedUsers(live);
  const libraryId = insertFolder(live.db);
  let winner: string | undefined;
  // Interleave a real watcher write after the empty address read. The real
  // transaction must roll back the losing asset, then update the winner.
  const interleaved: SqliteDb = {
    read: async <T>(sql: string, params?: SqlParams): Promise<T[]> => {
      const rows = await live.handle.read<T>(sql, params);
      if (winner === undefined) winner = watcherAsset(live, libraryId);
      return rows;
    },
    write: (sql, params) => live.handle.write(sql, params),
    transaction: (statements) => live.handle.transaction(statements),
  };
  const result = await upsertUploadedAsset(uploadInput(libraryId, memberId), interleaved);
  expect(result.toHexString()).toBe(winner!);
  expect(owner(live, result.toHexString())).toBe(memberId);
  expect(live.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
  expect(live.db.query('SELECT COUNT(*) AS n FROM asset_locations').get()).toEqual({ n: 1 });
});

test.each([undefined, unknownUserId])(
  'new upload with unavailable owner %s stays unassigned',
  async (ownerId) => {
    using live = await createLiveTestDatabase();
    seedUsers(live);
    const libraryId = insertFolder(live.db);
    const result = await upsertUploadedAsset(uploadInput(libraryId, ownerId), live.handle);
    expect(owner(live, result.toHexString())).toBeNull();
  },
);

test.each([undefined, unknownUserId])(
  'existing upload with unavailable owner %s keeps attribution',
  async (ownerId) => {
    using live = await createLiveTestDatabase();
    seedUsers(live);
    const libraryId = insertFolder(live.db);
    const existing = watcherAsset(live, libraryId);
    await upsertUploadedAsset(uploadInput(libraryId, ownerId), live.handle);
    expect(owner(live, existing)).toBe(serverOwnerId);
  },
);
