/**
 * POST /api/libraries/:id/backup/rendered — the Apple-rendered companion
 * upload.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * (#3787). The suite shares one database and one tmp library across the block
 * on purpose: the last test inspects the upload sessions the earlier ones left
 * behind, so the state has to accumulate.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from '../src/db/object-id.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  findAssetIdByMapleId,
  readAsset,
  seedBackupAsset,
  seedLibrary,
} from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const deviceId = 'test-device-rendered';
const phid = 'REND/L0/001';
const phid2 = 'REND/L0/002';
const mapleId = '02371b94aade2246ba56c6770a7624e1';
const originalRelPath = '2024/Tokyo/03-15/IMG_RENDERED.HEIC';

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;

/** An asset as a prior ingest would have left it: one live location in this
 * library and this device's PHAsset link. The rendered route resolves its
 * update by `(maple_id, a location in this library)`, so both matter. */
function seedIngested(args: {
  mapleId: string;
  relPath: string;
  phassetLocalId: string;
  size: number;
}): ObjectId {
  return seedBackupAsset(live.db, {
    mapleId: args.mapleId,
    size: args.size,
    locations: [{ libraryId: libId, relPath: args.relPath }],
    links: [{ deviceId, phassetLocalId: args.phassetLocalId }],
  });
}

/** The completed upload session for a resume key, or `null`. */
function completedSessionId(phassetLocalId: string): string | null {
  const row = live.db
    .query(
      `SELECT id FROM upload_sessions
        WHERE device_id = ? AND phasset_local_id = ? AND state = 'completed'`,
    )
    .get(deviceId, phassetLocalId) as { id: string } | null;
  return row?.id ?? null;
}

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-rendered-test-'));
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, { path: tmpLib, label: 'rendered-test' });
  invalidateLibraryRoots();

  // Pre-create the asset a prior ingest would have written, bytes included.
  const assetPath = path.join(tmpLib, originalRelPath);
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, Buffer.alloc(64, 1));
  seedIngested({ mapleId, relPath: originalRelPath, phassetLocalId: phid, size: 64 });
});

afterAll(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function rendered(body: Buffer, headers: Record<string, string>, libOverride?: string): Request {
  const id = libOverride ?? libId.toHexString();
  return new Request(`http://localhost/api/libraries/${id}/backup/rendered`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body: new Uint8Array(body),
  });
}

describe('POST /api/libraries/:id/backup/rendered', () => {
  test('happy path single chunk → .rendered.HEIC created + asset row updated', async () => {
    const bytes = Buffer.alloc(128, 7);
    const res = await authedHandle(
      rendered(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': originalRelPath,
        'X-Maple-Total-Bytes': '128',
        'X-Maple-Maple-Id': mapleId,
        'Content-Range': 'bytes 0-127/128',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = '2024/Tokyo/03-15/IMG_RENDERED.rendered.HEIC';
    expect(body.target_rel_path).toBe(expected);

    // File exists on disk.
    const onDisk = await fs.readFile(path.join(tmpLib, expected));
    expect(onDisk.byteLength).toBe(128);

    // Asset row updated with apple_rendered_path.
    const assetId = findAssetIdByMapleId(live.db, mapleId);
    expect(assetId).not.toBeNull();
    expect(readAsset(live.db, assetId!)?.apple_rendered_path).toBe(expected);
  });

  test('explicit extension via X-Maple-Filename-Ext', async () => {
    const phidExt = 'REND/L0/EXT';
    const mapleIdExt = '026120dc19a247bbd0298afea4874eea';
    const bytes = Buffer.alloc(64, 8);

    // Seed a minimal asset so the rendered endpoint can update it.
    seedIngested({
      mapleId: mapleIdExt,
      relPath: '2024/05/01/IMG_EXT.HEIC',
      phassetLocalId: phidExt,
      size: 64,
    });

    const res = await authedHandle(
      rendered(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidExt,
        'X-Maple-Target-Rel-Path': '2024/05/01/IMG_EXT.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Filename-Ext': '.JPEG',
        'X-Maple-Maple-Id': mapleIdExt,
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/05/01/IMG_EXT.rendered.JPEG');
  });

  test('X-Maple-Suffix-Override: Live Photo .mov lands as <base>.mov (no .rendered. infix)', async () => {
    const phidMov = 'REND/L0/MOV';
    const mapleIdMov = '0291b57f1646235c26b1fe54758048e9';
    const bytes = Buffer.alloc(96, 9);

    seedIngested({
      mapleId: mapleIdMov,
      relPath: '2024/08/01/IMG_MOV.HEIC',
      phassetLocalId: phidMov,
      size: 96,
    });

    const res = await authedHandle(
      rendered(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidMov,
        'X-Maple-Target-Rel-Path': '2024/08/01/IMG_MOV.HEIC',
        'X-Maple-Total-Bytes': '96',
        'X-Maple-Rendered-Ext': 'mov',
        'X-Maple-Suffix-Override': 'mov',
        'X-Maple-Maple-Id': mapleIdMov,
        'Content-Range': 'bytes 0-95/96',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // With suffix-override "mov" the file is "IMG_MOV.mov", NOT "IMG_MOV.rendered.mov".
    expect(body.target_rel_path).toBe('2024/08/01/IMG_MOV.mov');

    // File exists on disk with the correct name.
    const onDisk = await fs.readFile(path.join(tmpLib, body.target_rel_path));
    expect(onDisk.byteLength).toBe(96);
  });

  test('chunked resume across two chunks', async () => {
    const mapleId2 = '02ac8d4d43295e11b7487e09f0563977';

    seedIngested({
      mapleId: mapleId2,
      relPath: '2024/06/01/IMG_RESUME.HEIC',
      phassetLocalId: phid2,
      size: 256,
    });

    const r1 = await authedHandle(
      rendered(Buffer.alloc(128, 3), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid2,
        'X-Maple-Target-Rel-Path': '2024/06/01/IMG_RESUME.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r1.status).toBe(202);
    const b1 = await r1.json();
    expect(b1.next_offset).toBe(128);

    const r2 = await authedHandle(
      rendered(Buffer.alloc(128, 3), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid2,
        'X-Maple-Target-Rel-Path': '2024/06/01/IMG_RESUME.HEIC',
        'X-Maple-Total-Bytes': '256',
        'X-Maple-Maple-Id': mapleId2,
        'Content-Range': 'bytes 128-255/256',
      }),
    );
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.target_rel_path).toBe('2024/06/01/IMG_RESUME.rendered.HEIC');

    // Assembled file is 256 bytes.
    const onDisk = await fs.readFile(path.join(tmpLib, b2.target_rel_path));
    expect(onDisk.byteLength).toBe(256);
  });

  test('missing required header → 400', async () => {
    const r = await authedHandle(
      rendered(Buffer.alloc(16), {
        'X-Maple-Device-Id': deviceId,
        // no phasset id
        'X-Maple-Target-Rel-Path': originalRelPath,
        'X-Maple-Total-Bytes': '16',
        'Content-Range': 'bytes 0-15/16',
      }),
    );
    expect(r.status).toBe(400);
  });

  test('409 on resume offset mismatch', async () => {
    const phidOff = 'REND/L0/OFF';
    const mapleIdOff = '02a6633b6643f75243e080e787fedf0c';

    seedIngested({
      mapleId: mapleIdOff,
      relPath: '2024/07/01/IMG_OFF.HEIC',
      phassetLocalId: phidOff,
      size: 256,
    });

    const r1 = await authedHandle(
      rendered(Buffer.alloc(128, 5), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidOff,
        'X-Maple-Target-Rel-Path': '2024/07/01/IMG_OFF.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 0-127/256',
      }),
    );
    expect(r1.status).toBe(202);

    const r2 = await authedHandle(
      rendered(Buffer.alloc(128, 5), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phidOff,
        'X-Maple-Target-Rel-Path': '2024/07/01/IMG_OFF.HEIC',
        'X-Maple-Total-Bytes': '256',
        'Content-Range': 'bytes 64-191/256', // wrong start
      }),
    );
    expect(r2.status).toBe(409);
    const b2 = await r2.json();
    expect(b2.expected_offset).toBe(128);
  });

  test('path traversal in X-Maple-Target-Rel-Path → 400', async () => {
    const r = await authedHandle(
      rendered(Buffer.alloc(16), {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': '../../../etc/passwd',
        'X-Maple-Total-Bytes': '16',
        'Content-Range': 'bytes 0-15/16',
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toContain('unsafe');
  });

  test('library not found → 404', async () => {
    const r = await authedHandle(
      rendered(
        Buffer.alloc(16),
        {
          'X-Maple-Device-Id': deviceId,
          'X-Maple-Phasset-Id': phid,
          'X-Maple-Target-Rel-Path': originalRelPath,
          'X-Maple-Total-Bytes': '16',
          'X-Maple-Maple-Id': mapleId,
          'Content-Range': 'bytes 0-15/16',
        },
        new ObjectId().toHexString(),
      ),
    );
    expect(r.status).toBe(404);
  });

  test("rendered session de-dup: synthetic phid doesn't collide with original session", async () => {
    // After the first happy-path test, the rendered session (phid::rendered) is
    // completed. It is a distinct row from any session the original phid would
    // open — this suite never ingests an original, so there is none at all.
    const origSess = completedSessionId(phid);
    const rendSess = completedSessionId(`${phid}::rendered`);
    expect(rendSess).not.toBeNull();
    expect(origSess).not.toEqual(rendSess);
  });
});
