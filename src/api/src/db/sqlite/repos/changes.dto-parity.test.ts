/**
 * Parity with the Mongo change-feed repository.
 *
 * **By type.** The `Exact<>` assertions fail to compile when a ported
 * function's input or return type drifts from the Mongo one, which is what lets
 * the port claim "unchanged signature" rather than assert it. The one
 * difference is deliberate and is spelled out below: the optional leading
 * `dbOverride` takes a SQLite handle instead of a Mongo `Db`, because it is the
 * tests' seam and no route passes it.
 *
 * `allocateCursor` is absent from the SQLite module on purpose — see that
 * module's header — so there is nothing to compare for it.
 *
 * **By value.** A stored row is projected exactly the way `routes/changes.ts`
 * projects one onto the wire, and the result is compared key for key. The field
 * that has caused trouble before is `relative_path`, whose contract is an
 * explicit null rather than an absent key.
 */

import { describe, expect, test } from 'bun:test';
import { ObjectId } from 'mongodb';
import type * as MongoRepo from '../../changes.repo.ts';
import * as SqliteRepo from './changes.repo.ts';
import type { AssetChangeWithId } from '../../schema.ts';
import { createTestDatabase, testSqliteDb } from '../test-sqlite.test-helpers.ts';

/** `true` only when the two types are mutually assignable. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The change payload each verb accepts and reports.
const _input: Exact<
  Parameters<typeof MongoRepo.recordAssetChange>[1],
  Parameters<typeof SqliteRepo.recordAssetChange>[1]
> = true;
const _query: Exact<MongoRepo.ListChangesQuery, SqliteRepo.ListChangesQuery> = true;
const _publishInput: Exact<
  Parameters<typeof MongoRepo.recordAndPublishAssetChange>[0],
  Parameters<typeof SqliteRepo.recordAndPublishAssetChange>[0]
> = true;

// What each verb returns.
const _cursor: Exact<
  ReturnType<typeof MongoRepo.recordAssetChange>,
  ReturnType<typeof SqliteRepo.recordAssetChange>
> = true;
const _row: Exact<
  ReturnType<typeof MongoRepo.recordAssetChangeRow>,
  ReturnType<typeof SqliteRepo.recordAssetChangeRow>
> = true;
const _list: Exact<
  ReturnType<typeof MongoRepo.listChangesSince>,
  ReturnType<typeof SqliteRepo.listChangesSince>
> = true;
const _publish: Exact<
  ReturnType<typeof MongoRepo.recordAndPublishAssetChange>,
  ReturnType<typeof SqliteRepo.recordAndPublishAssetChange>
> = true;
const _highest: Exact<
  ReturnType<typeof MongoRepo.highestCursor>,
  ReturnType<typeof SqliteRepo.highestCursor>
> = true;

// The pure helper is shared verbatim, so it must stay identical.
const _relative: Exact<
  typeof MongoRepo.computeRelativePath,
  typeof SqliteRepo.computeRelativePath
> = true;

/** `asPayload` from `routes/changes.ts`, which is not exported. */
function asPayload(row: AssetChangeWithId): Record<string, unknown> {
  return {
    cursor: row.cursor,
    asset_id: row.asset_id?.toHexString() ?? null,
    folder_id: row.folder_id?.toHexString() ?? null,
    kind: row.kind,
    abs_path: row.abs_path,
    relative_path: row.relative_path ?? null,
    at: row.at.toISOString(),
  };
}

describe('type parity', () => {
  test('every ported signature matches the Mongo one', () => {
    expect([
      _input,
      _query,
      _publishInput,
      _cursor,
      _row,
      _list,
      _publish,
      _highest,
      _relative,
    ]).toEqual(Array(9).fill(true));
  });
});

describe('wire parity', () => {
  test('a stored row projects onto the same payload the SSE route sends', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    const assetId = new ObjectId();
    const folderId = new ObjectId();
    const written = await SqliteRepo.recordAssetChangeRow(db, {
      kind: 'restore',
      asset_id: assetId,
      folder_id: folderId,
      abs_path: '/srv/photos/a.dng',
      relative_path: 'a.dng',
    });
    const [read] = await SqliteRepo.listChangesSince(db, { since: 0, limit: 10 });

    expect(asPayload(read!)).toEqual({
      cursor: 1,
      asset_id: assetId.toHexString(),
      folder_id: folderId.toHexString(),
      kind: 'restore',
      abs_path: '/srv/photos/a.dng',
      relative_path: 'a.dng',
      at: written.at.toISOString(),
    });
  });

  test('a row with no relative path carries the key with an explicit null', async () => {
    using handle = await createTestDatabase();
    const db = testSqliteDb(handle.db);
    await SqliteRepo.recordAssetChange(db, {
      kind: 'delete',
      asset_id: null,
      folder_id: null,
      abs_path: null,
    });
    const [read] = await SqliteRepo.listChangesSince(db, { since: 0, limit: 10 });
    const payload = asPayload(read!);

    expect(Object.hasOwn(payload, 'relative_path')).toBe(true);
    expect(payload.relative_path).toBeNull();
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      cursor: 1,
      asset_id: null,
      folder_id: null,
      kind: 'delete',
      abs_path: null,
      relative_path: null,
      at: read!.at.toISOString(),
    });
  });
});
