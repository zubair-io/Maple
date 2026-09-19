/**
 * POST /api/folders/:id/upload — the File Provider's streaming drop-in.
 *
 * Drives the composed app, so the database has to be the process-wide one:
 * `createLiveTestDatabase()` installs a private in-memory SQLite database for
 * the file and puts the previous handle back on the way out (#3787). Real
 * files in a private temp directory; no external service, so nothing to skip
 * on.
 *
 * The Mongo version of this file opened with an explicit `ensureIndexes()` so
 * the unique `(folder_id, filename)` index existed before the concurrency test
 * ran. There is nothing to arrange here: `asset_locations_lib_path_name` is
 * part of the schema the harness migrates, so the constraint those tests lean
 * on is present by construction.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { signAccessToken } from '../src/auth/tokens.ts';
import { newObjectIdHex } from '../src/db/sqlite/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';
import {
  assetIdsAtAddress,
  assetIdsWithFilename,
  assetRow,
  primaryAbsPath,
  registerLibrary,
  seedRouteAsset,
  stageStateRow,
} from './helpers/assets-route-fixtures.ts';

// JWT bootstrap MUST run before any module that touches `requireAuth`, which
// rules out `withTestEnv` here: its write happens in `beforeAll`, and the
// token below is signed while this module body runs.
process.env.MAPLE_JWT_SECRET = 'x'.repeat(32);
const BEARER =
  'Bearer ' +
  (await signAccessToken(
    {
      file_access: true,
      sub: '00000000000000000000000a',
      email: 'tester@maple.local',
      role: 'owner',
    },
    process.env.MAPLE_JWT_SECRET,
  ));

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-fp3-upload-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let folderId: string;

/** Whether an asset is live, i.e. not soft-deleted. */
function isLive(id: string): boolean {
  return assetRow(live.db, id)?.deleted_at === null;
}

describe('POST /api/folders/:id/upload', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    folderId = registerLibrary(live.db, ROOT, 'upload-suite');
  });

  afterAll(async () => {
    live.close();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  function upload(body: Buffer, headers: Record<string, string>): Request {
    return new Request(`http://localhost/api/folders/${folderId}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        Authorization: BEARER,
        ...headers,
      },
      body: new Uint8Array(body),
    });
  }

  test('happy path: ARW upload writes file + inserts asset with stage skeleton', async () => {
    const { app } = await import('../src/index.ts');
    const bytes = Buffer.alloc(64, 7);
    const res = await app.handle(upload(bytes, { 'X-Maple-Target-Path': '2024/IMG_42.ARW' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      asset_id: string;
      abs_path: string;
      size: number;
      mtime: string;
    };
    expect(body.size).toBe(64);
    expect(body.abs_path).toBe(path.join(ROOT, '2024', 'IMG_42.ARW'));
    // mtime must be ISO-8601 (Swift Date decoder expects this format).
    expect(typeof body.mtime).toBe('string');
    expect(body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const onDisk = await fs.readFile(body.abs_path);
    expect(onDisk.byteLength).toBe(64);

    const assetId = body.asset_id;
    expect(assetRow(live.db, assetId)!.deleted_at).toBeNull();
    // Every stage must be seeded pending so controllers pick it up. Post
    // drop-abs-path-2026-05-21 the `hash` stage is retired — discover hashes
    // inline — so the skeleton no longer includes it.
    for (const stage of [
      'exif',
      'thumb',
      'preview',
      'face-detect',
      'face-embed',
      'describe',
      'geocode',
      'meili',
    ]) {
      const row = stageStateRow(live.db, assetId, stage);
      expect(row).not.toBeNull();
      expect(row!.version).toBe(0);
      expect(row!.processed_at).toBeNull();
    }
  });

  test('non-image upload is stored on disk but creates no asset row', async () => {
    const { app } = await import('../src/index.ts');
    const res = await app.handle(
      upload(Buffer.from('hello'), { 'X-Maple-Target-Path': 'notes.txt' }),
    );
    // Any file type may be synced now — the bytes land on disk.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_id?: string; abs_path: string; size: number };
    // No asset for non-image files: the response omits `asset_id`.
    expect(body.asset_id).toBeUndefined();
    const onDisk = await fs.readFile(path.join(ROOT, 'notes.txt'), 'utf8');
    expect(onDisk).toBe('hello');
    // The catalog stays media-only — nothing inserted for this path.
    expect(assetIdsWithFilename(live.db, folderId, 'notes.txt')).toEqual([]);
  });

  test('extensionless upload is stored on disk with no asset row', async () => {
    const { app } = await import('../src/index.ts');
    const res = await app.handle(
      upload(Buffer.from('README-bytes'), { 'X-Maple-Target-Path': 'README' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset_id?: string };
    expect(body.asset_id).toBeUndefined();
    const onDisk = await fs.readFile(path.join(ROOT, 'README'), 'utf8');
    expect(onDisk).toBe('README-bytes');
  });

  // Every target path the route must refuse, and the reason it refuses it.
  // `broken%ZZ.ARW` is the one that is not a shape rule: `%ZZ` is not a valid
  // percent escape, so `decodeURIComponent` throws a URIError, and the route
  // has to surface 400 rather than fall through to the global 500 handler.
  const REJECTED_TARGETS: ReadonlyArray<[why: string, target: string]> = [
    ['path-escape attempt', '../../etc/IMG.ARW'],
    ['malformed percent-escape in X-Maple-Target-Path', 'broken%ZZ.ARW'],
    ['absolute path', '/etc/IMG.ARW'],
    ['leading-dot path component (would land in .maple/)', '.maple/IMG.ARW'],
  ];

  for (const [why, target] of REJECTED_TARGETS) {
    test(`400 on ${why}`, async () => {
      const { app } = await import('../src/index.ts');
      const res = await app.handle(upload(Buffer.from('x'), { 'X-Maple-Target-Path': target }));
      expect(res.status).toBe(400);
    });
  }

  test('404 on unknown folder id', async () => {
    const { app } = await import('../src/index.ts');
    const otherId = newObjectIdHex();
    const res = await app.handle(
      new Request(`http://localhost/api/folders/${otherId}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '1',
          'X-Maple-Target-Path': 'x.ARW',
          Authorization: BEARER,
        },
        body: Buffer.from('x'),
      }),
    );
    expect(res.status).toBe(404);
  });

  // Duplicate upload: the file at the target path is moved to
  // `.maple/trash/<rel>` (preserving the prior copy for restore) and
  // the new bytes land at the original path. Returns 201, not 409 —
  // the File Provider treats a re-drop as an idempotent replace.
  test('duplicate upload: existing file moves to trash, new bytes land at target', async () => {
    const { app } = await import('../src/index.ts');
    const dest = path.join(ROOT, 'dup.ARW');
    // Seed both the file and a live asset, mirroring real state.
    await fs.writeFile(dest, 'old');
    const priorId = seedRouteAsset(live.db, {
      libraryId: folderId,
      path: '',
      filename: 'dup.ARW',
      sha1Head: 'deadbeef',
    });

    const res = await app.handle(upload(Buffer.from('new'), { 'X-Maple-Target-Path': 'dup.ARW' }));
    expect(res.status).toBe(201);
    expect(await fs.readFile(dest, 'utf-8')).toBe('new');

    // Prior file is in trash, prior row soft-deleted and repointed at it.
    const trashPath = path.join(ROOT, '.maple', 'trash', 'dup.ARW');
    expect(await fs.readFile(trashPath, 'utf-8')).toBe('old');
    const prior = assetRow(live.db, priorId);
    expect(prior).not.toBeNull();
    expect(prior!.deleted_at).toBeTruthy();
    expect(prior!.original_path).toBe(dest);
    expect(primaryAbsPath(live.db, ROOT, priorId)).toBe(trashPath);

    // A fresh live asset was inserted for the new bytes.
    const atTarget = assetIdsAtAddress(live.db, folderId, '', 'dup.ARW');
    expect(atTarget.length).toBe(1);
    expect(atTarget[0]).not.toBe(priorId);
    expect(isLive(atTarget[0]!)).toBe(true);
  });

  // Duplicate upload with byte-identical content: nothing to recover,
  // so the trash entry is purged after the new write lands.
  test('duplicate upload with identical content purges the redundant trash entry', async () => {
    const { app } = await import('../src/index.ts');
    const dest = path.join(ROOT, 'same.ARW');
    const bytes = Buffer.alloc(128, 0xab);
    await fs.writeFile(dest, bytes);
    // Pre-compute the sha1 of the first 64 KB (the file is only 128 B,
    // so that's the whole file) to match what the upload route hashes.
    const { sha1 } = await import('@noble/hashes/legacy.js');
    const digest = sha1(new Uint8Array(bytes));
    let hex = '';
    for (let i = 0; i < digest.length; i++) hex += digest[i]!.toString(16).padStart(2, '0');
    const priorId = seedRouteAsset(live.db, {
      libraryId: folderId,
      path: '',
      filename: 'same.ARW',
      size: bytes.byteLength,
      sha1Head: hex,
    });

    const res = await app.handle(upload(bytes, { 'X-Maple-Target-Path': 'same.ARW' }));
    expect(res.status).toBe(201);

    // No trash artifact for THIS upload — same content was detected via
    // sha1_head + size, so the moved-aside file was unlinked and the
    // soft-deleted row removed. (Filter by stem because the shared root
    // accumulates trash from other tests in this suite.)
    const trashDir = path.join(ROOT, '.maple', 'trash');
    const trashEntries = await fs.readdir(trashDir).catch(() => [] as string[]);
    expect(trashEntries.filter((n) => n.startsWith('same'))).toEqual([]);
    expect(assetRow(live.db, priorId)).toBeNull();
  });

  // Regression: Cat B — the prior `type: "arrayBuffer"` config made
  // Elysia buffer the entire body in memory before the handler ran. A
  // 1 GB upload would have spiked server RSS by 1 GB. The fix switches
  // to streaming `request.body` chunk-by-chunk via Bun's FileSink. A
  // ~100 MB body verifies the route doesn't fail on a payload size
  // that would be obviously inefficient if buffered; the byte-for-byte
  // comparison rules out streaming corruption.
  test('streaming upload: 100MB body lands intact on disk', async () => {
    const { app } = await import('../src/index.ts');
    const SIZE = 100 * 1024 * 1024; // 100 MB
    // Don't allocate a single 100MB Buffer — that would defeat the
    // streaming test on the *test* side. Build a ReadableStream that
    // emits 1MB chunks deterministically.
    const CHUNK = 1024 * 1024;
    const chunks = SIZE / CHUNK;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // @ts-ignore: ad-hoc counter on the stream's underlying source
        const n = (this._n ??= 0);
        if (n >= chunks) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(CHUNK);
        // Fill with the chunk index so corruption shows up visibly.
        chunk.fill(n & 0xff);
        controller.enqueue(chunk);
        // @ts-ignore
        this._n = n + 1;
      },
    });
    const res = await app.handle(
      new Request(`http://localhost/api/folders/${folderId}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(SIZE),
          'X-Maple-Target-Path': 'BIG.ARW',
          Authorization: BEARER,
        },
        body: stream,
        // @ts-ignore — Bun's fetch supports duplex; Node typings don't.
        duplex: 'half',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { abs_path: string; size: number };
    expect(body.size).toBe(SIZE);
    // Spot-check first + last chunk: every byte in chunk n equals n & 0xff.
    const fh = await fs.open(body.abs_path, 'r');
    try {
      const buf = Buffer.alloc(16);
      await fh.read(buf, 0, 16, 0);
      expect(buf[0]).toBe(0);
      await fh.read(buf, 0, 16, SIZE - 16);
      expect(buf[0]).toBe((chunks - 1) & 0xff);
    } finally {
      await fh.close();
    }
  });

  // Regression: Cat A1+A4 — a soft-deleted asset under the same filename
  // must NOT block a fresh upload. The trashed row's location moved under
  // `.maple/trash`, so the address the new upload claims is free.
  test('re-upload after soft-delete with the same filename succeeds', async () => {
    const { app } = await import('../src/index.ts');
    // Seed a previously-soft-deleted asset under the upload's intended name,
    // parked at the trash location with `original_path` recording where to
    // restore it.
    seedRouteAsset(live.db, {
      libraryId: folderId,
      path: '.maple/trash',
      filename: 'REUSE.ARW',
      size: 1,
      deletedAt: new Date().toISOString(),
      originalPath: path.join(ROOT, 'REUSE.ARW'),
    });

    const res = await app.handle(
      upload(Buffer.alloc(4, 9), { 'X-Maple-Target-Path': 'REUSE.ARW' }),
    );
    expect(res.status).toBe(201);
    // Both rows now exist — the trashed one and the new live one.
    const all = assetIdsWithFilename(live.db, folderId, 'REUSE.ARW');
    expect(all.length).toBe(2);
    expect(all.filter(isLive).length).toBe(1);
  });

  // Concurrent uploads to the same target: both succeed (201) — the
  // trash-on-duplicate behaviour means there is no exclusive claim
  // anymore. The route streams each body to a unique `.upload-<uuid>`
  // tmp, then atomically renames into place, so the file on disk
  // always matches one of the two complete payloads (never a torn
  // mixture). No tmp files are left behind.
  test('concurrent uploads to the same target: both 201, one intact file, no orphan tmps', async () => {
    const { app } = await import('../src/index.ts');
    const targetRel = 'race/IMG_RACE.ARW';
    const dest = path.join(ROOT, targetRel);

    const [resA, resB] = await Promise.all([
      app.handle(upload(Buffer.alloc(32, 1), { 'X-Maple-Target-Path': targetRel })),
      app.handle(upload(Buffer.alloc(32, 2), { 'X-Maple-Target-Path': targetRel })),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const onDisk = await fs.readFile(dest);
    expect(onDisk.byteLength).toBe(32);
    // Every byte must equal a single payload's fill byte (1 or 2) —
    // never a torn mixture.
    const fill = onDisk[0];
    expect(fill === 1 || fill === 2).toBe(true);
    expect(onDisk.every((b) => b === fill)).toBe(true);

    const dirEntries = await fs.readdir(path.dirname(dest));
    expect(dirEntries.filter((n) => n.startsWith('.upload-'))).toEqual([]);

    // Exactly one live asset holds the destination address.
    const relDir = path.relative(ROOT, path.dirname(dest));
    const atTarget = assetIdsAtAddress(live.db, folderId, relDir, path.basename(dest));
    expect(atTarget.filter(isLive).length).toBe(1);
  });
});
