/**
 * Cross-library backup regression suite.
 *
 * Reproduces the production failure where ~half of an iOS device's photos
 * back up successfully and the rest fail with HTTP 404 even though the
 * original bytes uploaded fine.
 *
 * Root cause: `maple_id` is a GLOBAL content hash (not scoped to a library).
 * The ingest dedup looks an asset up by content id with no library filter, so a
 * photo whose content already lives in some OTHER folder/library (e.g. it was
 * discovered by a folder scan, or backed up to a different library first)
 * matches that other-library row. If ingest merely link-and-dedups against it
 * without materializing a location for the TARGET library, the folder-scoped
 * sidecar / rendered lookups find nothing and 404 — failing the asset even
 * though step 1 wrote bytes.
 *
 * The invariant under test: backing a photo up to library B must leave a
 * usable location referencing B, so the sidecar + rendered companions attach
 * correctly — even when the same content already exists in library A.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for the test (#3787), with both libraries rooted at their own tmp directory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { ObjectId } from '../src/db/object-id.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import {
  findAssetIdByMapleId,
  findAssetsByMapleId,
  readLocations,
  readPhassetLinks,
  seedBackupAsset,
  seedLibrary,
} from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';

const deviceId = 'test-device-cross-lib';
const phid = 'XLIB/L0/001';
// A content hash that already lives in library A (e.g. a prior folder scan).
const sharedMapleId = '02e759ceff3390dab8d6cd1425d1e196';
// The bytes the device uploads — identical content, hence the same maple_id.
const sharedBytes = Buffer.alloc(256, 0x5a);

// The rel-path the SAME content occupies inside library A. The device backing
// up to library B derives a different rel-path from capture date + filename.
const relPathInA = 'scanned/originals/IMG_XLIB.HEIC';

let live: LiveTestDatabase;
let libA: ObjectId;
let libB: ObjectId;
let tmpLibA: string;
let tmpLibB: string;

beforeEach(async () => {
  tmpLibA = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xlib-A-'));
  tmpLibB = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xlib-B-'));

  live = await createLiveTestDatabase();
  libA = seedLibrary(live.db, { path: tmpLibA, label: 'library-A' });
  libB = seedLibrary(live.db, { path: tmpLibB, label: 'library-B' });
  // The library-roots cache memoizes folder rows; invalidate so the freshly
  // seeded libraries resolve.
  invalidateLibraryRoots();

  // Materialize the shared content on disk inside library A and record an
  // asset whose ONLY location points at library A. This is the "already exists
  // in another folder" precondition.
  const aPath = path.join(tmpLibA, relPathInA);
  await fs.mkdir(path.dirname(aPath), { recursive: true });
  await fs.writeFile(aPath, sharedBytes);

  seedBackupAsset(live.db, {
    mapleId: sharedMapleId,
    size: sharedBytes.byteLength,
    locations: [{ libraryId: libA, relPath: relPathInA }],
  });
});

afterEach(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLibA, { recursive: true, force: true });
  await fs.rm(tmpLibB, { recursive: true, force: true });
});

function ingest(body: Buffer, headers: Record<string, string>): Request {
  return new Request(`http://localhost/api/libraries/${libB.toHexString()}/backup/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body: new Uint8Array(body),
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
    body: new Uint8Array(body),
  });
}

describe('cross-library backup: same content already in library A, backing up to library B', () => {
  test('ingest → sidecar → rendered to library B all succeed (no 404)', async () => {
    // ---- Step 1: original bytes → library B ingest -----------------------
    // The content already exists (in library A), so ingest hits the dedup
    // branch. It must MATERIALIZE a location for library B rather than
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

    // Still exactly one asset row for this content (dedup, not a fresh row),
    // now carrying locations for BOTH libraries.
    const rows = findAssetsByMapleId(live.db, sharedMapleId);
    expect(rows).toHaveLength(1);
    const assetId = findAssetIdByMapleId(live.db, sharedMapleId);
    expect(assetId).not.toBeNull();
    const libIds = readLocations(live.db, assetId!).map((location) => location.library_id);
    expect(libIds).toContain(libA.toHexString());
    expect(libIds).toContain(libB.toHexString());
    // The device link was attached.
    expect(
      readPhassetLinks(live.db, assetId!).some(
        (link) => link.device_id === deviceId && link.phasset_local_id === phid,
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
