import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from 'mongodb';
import { app } from '../src/index.ts';
import { foldersCollection, assetsCollection } from '../src/db/client.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const libId = new ObjectId();
const deviceId = 'test-device-sidecar';
const phid = 'SIDE/L0/001';
const mapleId = 'sidecar-maple-id';
const targetRelPath = '2024/Tokyo/03-15/IMG_SIDECAR.HEIC';
let tmpLib: string;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-test-'));
  const f = await foldersCollection();
  await f.insertOne({
    _id: libId,
    path: tmpLib,
    label: 'test',
    created_at: new Date(),
    file_count: 0,
  } as any);

  // Pre-create an AssetDoc that simulates a prior ingest.
  const assetPath = path.join(tmpLib, targetRelPath);
  await fs.mkdir(path.dirname(assetPath), { recursive: true });
  await fs.writeFile(assetPath, Buffer.alloc(64, 1));

  const a = await assetsCollection();
  await a.deleteMany({ 'phasset_links.device_id': deviceId });
  // Post drop-abs-path-2026-05-21: the on-disk pointer lives on `fileinfo[]`,
  // and the sidecar route scopes its prior-upload lookup by
  // `{ 'fileinfo.library_id', phasset_links… }`. Seed must carry a
  // `fileinfo[].library_id` entry for this library or the lookup 404s.
  await a.insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        library_id: libId,
        path: path.dirname(targetRelPath),
        filename: path.basename(targetRelPath),
        deleted_at: null,
      },
    ],
    size: 64,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    maple_id: mapleId,
    phasset_links: [{ device_id: deviceId, phasset_local_id: phid, first_seen: new Date() }],
    deleted_from_photos: false,
  } as any);
});

afterAll(async () => {
  // Drop the asset + folder rows this suite seeded so they don't leak into the
  // shared Mongo for later test files (KTLO #895) — beforeAll only cleared its
  // own prior run, never tore down afterward. Scoped to this suite's
  // libId/deviceId to stay parallel-safe with the sibling backup suites.
  try {
    const a = await assetsCollection();
    await a.deleteMany({
      $or: [{ 'fileinfo.library_id': libId }, { 'phasset_links.device_id': deviceId }],
    });
    const f = await foldersCollection();
    await f.deleteMany({ _id: libId });
  } catch {
    // Best-effort teardown — never mask a test failure with a cleanup error.
  }
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function sidecarRequest(
  body: string | Buffer,
  headers: Record<string, string>,
  libOverride?: string,
): Request {
  const id = libOverride ?? libId.toHexString();
  return new Request(`http://localhost/api/libraries/${id}/backup/sidecar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
}

describe('POST /api/libraries/:id/backup/sidecar', () => {
  test('happy path — writes .xmp next to original', async () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>`;
    const res = await app.handle(
      sidecarRequest(xmp, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': targetRelPath,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe(`${targetRelPath}.xmp`);

    // Verify file exists on disk with correct content.
    const onDisk = await fs.readFile(path.join(tmpLib, body.target_rel_path), 'utf8');
    expect(onDisk).toBe(xmp);
  });

  test('Content-Type: application/xml — body must arrive as raw bytes', async () => {
    // iOS UploadClient sends `Content-Type: application/xml` for sidecars.
    // Elysia's content-type-driven body parser must not coerce the XMP into
    // a parsed URLSearchParams-style object; the route handler expects raw
    // bytes. Regression test for sidecar uploads silently failing in prod.
    //
    // Uses a unique target path so the write actually happens (the route now
    // skips-if-exists, #698) and the raw-bytes assertion stays meaningful.
    const xmlRelPath = '2024/Tokyo/03-15/IMG_XML_CTYPE.HEIC';
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description maple:favorite="False"/></rdf:RDF></x:xmpmeta>`;
    const res = await app.handle(
      sidecarRequest(xmp, {
        'Content-Type': 'application/xml',
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': xmlRelPath,
      }),
    );
    expect(res.status).toBe(200);
    const onDisk = await fs.readFile(path.join(tmpLib, `${xmlRelPath}.xmp`), 'utf8');
    expect(onDisk).toBe(xmp);
  });

  test('second write to same path — skipped, first sidecar preserved (#698)', async () => {
    // The backup route no longer overwrites an existing sidecar — a re-upload
    // must not clobber a possibly-edited first copy. (Edit-sync force-overwrite
    // is a separate, out-of-scope path.)
    const v1RelPath = '2024/Tokyo/03-15/IMG_NOCLOBBER.HEIC';
    const xmp1 = `<x:xmpmeta>v1</x:xmpmeta>`;
    const xmp2 = `<x:xmpmeta>v2</x:xmpmeta>`;

    const r1 = await app.handle(
      sidecarRequest(xmp1, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': v1RelPath,
      }),
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()).skipped).toBeUndefined();

    const r2 = await app.handle(
      sidecarRequest(xmp2, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': v1RelPath,
      }),
    );
    expect(r2.status).toBe(200);
    expect((await r2.json()).skipped).toBe(true);

    const onDisk = await fs.readFile(path.join(tmpLib, `${v1RelPath}.xmp`), 'utf8');
    expect(onDisk).toBe(xmp1);
  });

  test('missing required header → 400', async () => {
    const r = await app.handle(
      sidecarRequest('<x/>', {
        'X-Maple-Device-Id': deviceId,
        // no phasset id
        'X-Maple-Target-Rel-Path': targetRelPath,
      }),
    );
    expect(r.status).toBe(400);
  });

  test('no prior ingest for this device+phasset → 404', async () => {
    const r = await app.handle(
      sidecarRequest('<x/>', {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'UNKNOWN/L0/999',
        'X-Maple-Target-Rel-Path': targetRelPath,
      }),
    );
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error).toContain('no prior upload');
  });

  test('library not found → 404', async () => {
    const r = await app.handle(
      sidecarRequest(
        '<x/>',
        {
          'X-Maple-Device-Id': deviceId,
          'X-Maple-Phasset-Id': phid,
          'X-Maple-Target-Rel-Path': targetRelPath,
        },
        new ObjectId().toHexString(),
      ),
    );
    expect(r.status).toBe(404);
  });

  test('body exceeds 256 KB → 413', async () => {
    const big = Buffer.alloc(257 * 1024, 0x41); // 257 KB of 'A'
    const r = await app.handle(
      sidecarRequest(big, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': targetRelPath,
      }),
    );
    expect(r.status).toBe(413);
  });

  test('path traversal in X-Maple-Target-Rel-Path → 400', async () => {
    const r = await app.handle(
      sidecarRequest('<x/>', {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': '../../etc/passwd',
      }),
    );
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toContain('unsafe');
  });

  // #698 — dedup / cross-device assets: this device's phasset_link is not
  // attached, so the (device_id, phasset_local_id) lookup misses. The
  // X-Maple-Id (maple_id) primary lookup must still resolve the asset.
  describe('#698 maple_id lookup + skip-if-exists', () => {
    // A maple_id present on the asset, but a phasset id that is NOT linked
    // for this device — so the device+phasset fallback alone would 404.
    const dedupRelPath = '2024/Tokyo/03-15/IMG_DEDUP.HEIC';
    const dedupPhid = 'DEDUP/L0/NOT-LINKED';

    test('maple_id resolves where device+phasset would miss → 200 + file written', async () => {
      // Sanity: device+phasset alone (no X-Maple-Id) misses → 404, proving the
      // phasset link for `dedupPhid` is genuinely absent.
      const miss = await app.handle(
        sidecarRequest('<x/>', {
          'X-Maple-Device-Id': deviceId,
          'X-Maple-Phasset-Id': dedupPhid,
          'X-Maple-Target-Rel-Path': dedupRelPath,
        }),
      );
      expect(miss.status).toBe(404);

      // With X-Maple-Id present, the maple_id primary lookup resolves the
      // existing asset even though `dedupPhid` isn't linked.
      const xmp = `<x:xmpmeta>dedup</x:xmpmeta>`;
      const res = await app.handle(
        sidecarRequest(xmp, {
          'X-Maple-Device-Id': deviceId,
          'X-Maple-Phasset-Id': dedupPhid,
          'X-Maple-Target-Rel-Path': dedupRelPath,
          'X-Maple-Id': mapleId,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBeUndefined();
      expect(body.target_rel_path).toBe(`${dedupRelPath}.xmp`);

      const onDisk = await fs.readFile(path.join(tmpLib, body.target_rel_path), 'utf8');
      expect(onDisk).toBe(xmp);
    });

    test('existing .xmp → 200 skipped, file bytes unchanged', async () => {
      const finalPath = path.join(tmpLib, `${dedupRelPath}.xmp`);
      const before = await fs.readFile(finalPath, 'utf8');

      // A second device re-uploads (dedup) with different XMP bytes — must NOT
      // clobber the first device's sidecar.
      const res = await app.handle(
        sidecarRequest('<x:xmpmeta>SECOND-DEVICE</x:xmpmeta>', {
          'X-Maple-Device-Id': 'other-device',
          'X-Maple-Phasset-Id': 'OTHER/L0/999',
          'X-Maple-Target-Rel-Path': dedupRelPath,
          'X-Maple-Id': mapleId,
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skipped).toBe(true);
      expect(body.target_rel_path).toBe(`${dedupRelPath}.xmp`);

      const after = await fs.readFile(finalPath, 'utf8');
      expect(after).toBe(before);
    });

    test('no X-Maple-Id header → device+phasset fallback still 200', async () => {
      // Older client: no maple_id header. The fallback (device_id +
      // phasset_local_id) must still resolve the original linked asset.
      const fallbackRelPath = '2024/Tokyo/03-15/IMG_FALLBACK.HEIC';
      const xmp = `<x:xmpmeta>fallback</x:xmpmeta>`;
      const res = await app.handle(
        sidecarRequest(xmp, {
          'X-Maple-Device-Id': deviceId,
          'X-Maple-Phasset-Id': phid,
          'X-Maple-Target-Rel-Path': fallbackRelPath,
        }),
      );
      expect(res.status).toBe(200);
      const onDisk = await fs.readFile(path.join(tmpLib, `${fallbackRelPath}.xmp`), 'utf8');
      expect(onDisk).toBe(xmp);
    });

    test('neither maple_id nor device+phasset matches → 404', async () => {
      const res = await app.handle(
        sidecarRequest('<x/>', {
          'X-Maple-Device-Id': 'ghost-device',
          'X-Maple-Phasset-Id': 'GHOST/L0/000',
          'X-Maple-Target-Rel-Path': '2024/Tokyo/03-15/IMG_GHOST.HEIC',
          'X-Maple-Id': 'no-such-maple-id',
        }),
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('no prior upload');
    });
  });
});
