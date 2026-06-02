/**
 * Cross-library backup regression suite.
 *
 * Reproduces the production failure where ~half of an iOS device's photos
 * back up successfully and the rest fail with HTTP 404 even though the
 * original bytes uploaded fine.
 *
 * Root cause: `maple_id` is a GLOBAL content hash (not scoped to a library).
 * The ingest dedup does `findOne({ maple_id })` with no library filter, so a
 * photo whose content already lives in some OTHER folder/library (e.g. it was
 * discovered by a folder scan, or backed up to a different library first)
 * matches that other-library row. If ingest merely link-and-dedups against it
 * without materializing a `fileinfo` entry for the TARGET library, the
 * folder-scoped sidecar / rendered lookups (`{ 'fileinfo.library_id': B, … }`)
 * find nothing and 404 — failing the asset even though step 1 wrote bytes.
 *
 * The invariant under test: backing a photo up to library B must leave a
 * usable `fileinfo` entry referencing B, so the sidecar + rendered companions
 * attach correctly — even when the same content already exists in library A.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import { assetsCollection, foldersCollection, uploadSessionsCollection } from '../src/db/client.ts';

const libA = new ObjectId();
const libB = new ObjectId();
const deviceId = 'test-device-cross-lib';
const phid = 'XLIB/L0/001';
// A content hash that already lives in library A (e.g. a prior folder scan).
const sharedMapleId = 'cross-library-shared-content-id';
// The bytes the device uploads — identical content, hence the same maple_id.
const sharedBytes = Buffer.alloc(256, 0x5a);

// The rel-path the SAME content occupies inside library A. The device backing
// up to library B derives a different rel-path from capture date + filename.
const relPathInA = 'scanned/originals/IMG_XLIB.HEIC';

let tmpLibA: string;
let tmpLibB: string;

beforeAll(async () => {
  tmpLibA = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xlib-A-'));
  tmpLibB = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xlib-B-'));

  const f = await foldersCollection();
  await f.deleteMany({ _id: { $in: [libA, libB] } });
  await f.insertOne({
    _id: libA,
    path: tmpLibA,
    label: 'library-A',
    created_at: new Date(),
    file_count: 0,
  } as never);
  await f.insertOne({
    _id: libB,
    path: tmpLibB,
    label: 'library-B',
    created_at: new Date(),
    file_count: 0,
  } as never);

  // The library-roots cache memoizes folder docs; invalidate so the freshly
  // inserted libraries resolve.
  const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
  invalidateLibraryRoots();

  // Materialize the shared content on disk inside library A and record an
  // AssetDoc whose ONLY fileinfo entry points at library A. This is the
  // "already exists in another folder" precondition.
  const aPath = path.join(tmpLibA, relPathInA);
  await fs.mkdir(path.dirname(aPath), { recursive: true });
  await fs.writeFile(aPath, sharedBytes);

  const a = await assetsCollection();
  await a.deleteMany({ maple_id: sharedMapleId });
  await a.deleteMany({ 'phasset_links.device_id': deviceId });
  await a.insertOne({
    _id: new ObjectId(),
    fileinfo: [
      {
        library_id: libA,
        path: path.dirname(relPathInA),
        filename: path.basename(relPathInA),
        deleted_at: null,
      },
    ],
    size: sharedBytes.byteLength,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    maple_id: sharedMapleId,
    phasset_links: [],
    deleted_from_photos: false,
  } as never);

  const u = await uploadSessionsCollection();
  await u.deleteMany({ device_id: deviceId });
});

afterAll(async () => {
  await fs.rm(tmpLibA, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tmpLibB, { recursive: true, force: true }).catch(() => {});
  const a = await assetsCollection();
  await a.deleteMany({ maple_id: sharedMapleId });
});

function ingest(body: Buffer, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libB.toHexString()}/backup/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
}

function sidecar(body: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libB.toHexString()}/backup/sidecar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', ...headers },
    body,
  });
}

function rendered(body: Buffer, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libB.toHexString()}/backup/rendered`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
}

describe('cross-library backup: same content already in library A, backing up to library B', () => {
  test('ingest → sidecar → rendered to library B all succeed (no 404)', async () => {
    // ---- Step 1: original bytes → library B ingest -----------------------
    // The content already exists (in library A), so ingest hits the dedup
    // branch. It must MATERIALIZE a fileinfo entry for library B rather than
    // pure-dedup against library A's row.
    const ingestRes = await authedHandle(
      ingest(sharedBytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Capture-Date': '2024-07-04T12:00:00Z',
        'X-Maple-Filename': 'IMG_XLIB.HEIC',
        'X-Maple-Total-Bytes': String(sharedBytes.byteLength),
        'X-Maple-Maple-Id': sharedMapleId,
        'Content-Range': `bytes 0-${sharedBytes.byteLength - 1}/${sharedBytes.byteLength}`,
      }),
    );
    expect(ingestRes.status).toBe(200);
    const ingestBody = await ingestRes.json();
    expect(ingestBody.maple_id).toBe(sharedMapleId);
    // The returned target_rel_path is the device-derived path inside library
    // B (date + filename), NOT library A's scanned path.
    const targetRelPath: string = ingestBody.target_rel_path;
    expect(targetRelPath).not.toBe(relPathInA);

    // Original bytes landed on disk inside library B.
    const onDiskB = await fs.readFile(path.join(tmpLibB, targetRelPath));
    expect(onDiskB.byteLength).toBe(sharedBytes.byteLength);

    // Still exactly one AssetDoc for this content (dedup, not a fresh row),
    // now carrying fileinfo entries for BOTH libraries.
    const a = await assetsCollection();
    const docs = await a.find({ maple_id: sharedMapleId }).toArray();
    expect(docs.length).toBe(1);
    const libIds = (docs[0].fileinfo ?? []).map((e: any) => e.library_id?.toHexString());
    expect(libIds).toContain(libA.toHexString());
    expect(libIds).toContain(libB.toHexString());
    // The device link was attached.
    expect(
      (docs[0].phasset_links ?? []).some(
        (l: any) => l.device_id === deviceId && l.phasset_local_id === phid,
      ),
    ).toBe(true);

    // ---- Step 2: sidecar → library B -------------------------------------
    // Before the fix, the folder-scoped sidecar lookup found no row for
    // library B and returned 404 — failing the whole asset.
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>`;
    const sidecarRes = await authedHandle(
      sidecar(xmp, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': targetRelPath,
      }),
    );
    expect(sidecarRes.status).toBe(200);
    const sidecarBody = await sidecarRes.json();
    expect(sidecarBody.target_rel_path).toBe(`${targetRelPath}.xmp`);
    const sidecarOnDisk = await fs.readFile(
      path.join(tmpLibB, sidecarBody.target_rel_path),
      'utf8',
    );
    expect(sidecarOnDisk).toBe(xmp);

    // ---- Step 3: rendered companion → library B --------------------------
    const renderedBytes = Buffer.alloc(128, 0x33);
    const renderedRes = await authedHandle(
      rendered(renderedBytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Target-Rel-Path': targetRelPath,
        'X-Maple-Total-Bytes': String(renderedBytes.byteLength),
        'X-Maple-Maple-Id': sharedMapleId,
        'Content-Range': `bytes 0-${renderedBytes.byteLength - 1}/${renderedBytes.byteLength}`,
      }),
    );
    expect(renderedRes.status).toBe(200);
    const renderedBody = await renderedRes.json();
    const renderedOnDisk = await fs.readFile(path.join(tmpLibB, renderedBody.target_rel_path));
    expect(renderedOnDisk.byteLength).toBe(renderedBytes.byteLength);

    // Library A's original copy is untouched — dedup never clobbered it.
    const stillInA = await fs.readFile(path.join(tmpLibA, relPathInA));
    expect(stillInA.byteLength).toBe(sharedBytes.byteLength);
  });
});
