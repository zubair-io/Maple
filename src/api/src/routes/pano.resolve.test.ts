/**
 * routes/pano.ts path-resolution integration tests (#1311, #1313).
 *
 * Covers:
 *   - (#1311) Path-based resolution: indexed assets resolved by path
 *   - (#1311) Index-on-demand: unindexed in-library paths get indexed then proceed
 *   - (#1311) Security: paths outside every registered library root are rejected
 *   - (#1313) Security: paths using ".." to escape the library root are rejected
 *   - panoStitchHandler: output asset registered with real content identity
 *
 * Uses a real MongoDB on :27077 (throwaway — never touches :27017).
 * Skip-passes when Mongo is unreachable (CI without services).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { panoRoutes } from './pano.ts';
import { withTestDb, withTestEnv } from '../db/test-db.test-helpers.ts';

// Standalone test DB — never touches the dev DB on :27017.
const MONGO_URL = 'mongodb://localhost:27077';
const TEST_DB = `maple_pano_resolve_test_${process.pid}`;

// Both overrides are claimed in beforeAll and restored in afterAll. Leaving
// the URI pointing at :27077 makes every later test file in the same process
// reconnect to a port that only exists on dev machines (CI has no :27077 —
// the whole tail of the suite times out "MongoDB unreachable"), and capturing
// the prior value at module scope would capture pano.test.ts's own :27077
// override and then restore THAT process-wide.
withTestEnv('MAPLE_MONGO_URI', MONGO_URL);
withTestDb(TEST_DB);

const app = new Elysia().use(panoRoutes);

let client: MongoClient | null = null;
let db: Db | null = null;
let mongoReachable = false;

/** Absolute path of the fake maple-cli shell script. */
let fakeCli = '';
let tmpDir = '';
let folderId: ObjectId;

// 1×1 white PNG (PNG spec: 8-byte signature + IHDR + IDAT + IEND).
// Generated once and embedded as base64 to avoid any runtime dependency.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(async () => {
  // Reset the getDb() singleton so this file's env vars take effect. In the
  // full test suite a prior file may have connected to :27017; closeDb() sets
  // _db back to null so the next getDb() call reconnects to :27077.
  const { closeDb } = await import('../db/client.ts');
  await closeDb();

  // Create fake maple-cli.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-resolve-test-'));
  fakeCli = path.join(tmpDir, 'fake-maple-cli');
  await fs.writeFile(
    fakeCli,
    `#!/bin/sh
# Fake maple-cli for pano resolve route tests.
# Parses --out <path> and writes a tiny PNG there; prints progress to stderr.
OUT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    shift; OUT="$1"
  fi
  shift
done
echo "pano: decoding frame 1" >&2
echo "pano: keypoints — 512 keypoints on 1280x960 proxy" >&2
echo "pano: graph — 3 verified edges" >&2
echo "pano: refine — 1024 matches NCC-refined" >&2
echo "pano: solve — mean 0.9px" >&2
echo "pano: wrote output.png (3840x1920)" >&2
if [ -n "$OUT" ]; then
  echo '${TINY_PNG_B64}' | base64 -d > "$OUT"
fi
exit 0
`,
  );
  await fs.chmod(fakeCli, 0o755);

  // Connect to the test Mongo with our own client (not getDb()).
  try {
    client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 1000 });
    await client.connect();
    db = client.db(TEST_DB);
    mongoReachable = true;
  } catch {
    mongoReachable = false;
  }
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  if (db) await db.dropDatabase().catch(() => {});
  await client?.close().catch(() => {});
  // Reset the singleton so subsequent test files reconnect to the suite's own
  // Mongo, not this file's throwaway :27077 (the env itself is already back).
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  // Reset relevant collections between tests.
  await db.collection('jobs').deleteMany({});
  await db.collection('app_settings').deleteMany({});
  await db.collection('assets').deleteMany({});
  await db.collection('folders').deleteMany({});

  folderId = new ObjectId();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  await db.collection('folders').insertOne({
    _id: folderId,
    path: libPath,
    label: 'Test lib',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function postJson(url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function putJson(url: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${url}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// ── #1311: server-authoritative path resolution ───────────────────────────────

describe('POST /api/pano/stitch — path-based resolution (#1311)', () => {
  beforeEach(async () => {
    if (!mongoReachable) return;
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
  });

  it('resolves already-indexed assets by path and creates a queued job', async () => {
    if (!mongoReachable || !db) return;
    const libPath = path.join(tmpDir, 'lib');

    // Write real files and seed asset docs pointing at them.
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const assetPaths: string[] = [];
    for (const name of ['path-a.png', 'path-b.png']) {
      const filePath = path.join(libPath, name);
      await fs.writeFile(filePath, png);
      assetPaths.push(filePath);
      const _id = new ObjectId();
      await db.collection('assets').insertOne({
        _id,
        maple_id: `seed-path-${name}`,
        fileinfo: [{ path: '', filename: name, library_id: folderId, deleted_at: null }],
      } as never);
    }
    // Force library-roots cache to reload so the route sees the test folder.
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const res = await postJson('/api/pano/stitch', {
      assetPaths,
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; indexing?: number };
    expect(ObjectId.isValid(body.id)).toBe(true);
    // All paths were already indexed — no on-demand indexing needed.
    expect(body.indexing).toBeUndefined();
  });

  it('indexes an in-library path on-demand when not yet in the DB', async () => {
    if (!mongoReachable || !db) return;
    const libPath = path.join(tmpDir, 'lib');

    // Write files but do NOT insert asset docs — simulate unindexed state.
    // Distinct content per file: identical bytes would dedup to ONE asset
    // document (the indexer's maple_id is content-addressed), collapsing the
    // two inputs to a single id and failing the ≥2 guard. Real pano frames are
    // always distinct, so give each file a unique tail.
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const assetPaths: string[] = [];
    for (const name of ['demand-a.png', 'demand-b.png']) {
      const filePath = path.join(libPath, name);
      await fs.writeFile(filePath, Buffer.concat([png, Buffer.from(name)]));
      assetPaths.push(filePath);
    }
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const res = await postJson('/api/pano/stitch', {
      assetPaths,
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; indexing?: number };
    expect(ObjectId.isValid(body.id)).toBe(true);
    // Both paths were indexed on-demand.
    expect(body.indexing).toBe(2);
    // Both asset docs must now exist in the DB.
    for (const p of assetPaths) {
      const filename = path.basename(p);
      const doc = await db.collection('assets').findOne({ 'fileinfo.filename': filename });
      expect(doc).not.toBeNull();
    }
  });

  it('rejects a path that is outside every registered library root (security)', async () => {
    if (!mongoReachable) return;
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const res = await postJson('/api/pano/stitch', {
      // /etc/passwd is never under a registered library root.
      assetPaths: ['/etc/passwd', '/etc/hosts'],
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('path_outside_library');
  });

  it('rejects a path that uses .. to escape the library root (path-traversal security)', async () => {
    // Regression test for the path-traversal vulnerability fixed in #1313.
    //
    // Without the fix: `<libroot>/../../etc/passwd` passes the raw-string
    // `isUnderRoot` check (it lexically starts with libroot + "/") and then
    // gets fed to `handleEvent`, indexing a file outside the library.
    //
    // With the fix: `fs.realpath` collapses the traversal to `/etc/passwd`
    // (or rejects with ENOENT if the file doesn't exist); either way the
    // normalized path fails the jail check and the request is rejected 400.
    if (!mongoReachable) return;
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const libPath = path.join(tmpDir, 'lib');

    // Craft a traversal path: starts with the library root so a raw-string
    // prefix check would pass, but resolves outside it via "..".
    const traversalPath = path.join(libPath, '..', '..', 'etc', 'hosts');

    const res = await postJson('/api/pano/stitch', {
      assetPaths: [traversalPath, traversalPath],
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Must be either path_outside_library (realpath succeeded, jail check
    // caught it) or path_not_found (realpath failed — non-existent target).
    // Both are correct outcomes; neither is the 201 that proves the escape.
    expect(['path_outside_library', 'path_not_found']).toContain(body.error);
  });

  it('rejects when neither assetIds nor assetPaths is supplied', async () => {
    if (!mongoReachable) return;
    const res = await postJson('/api/pano/stitch', {
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(422);
  });

  it('accepts legacy assetIds-only request without paths', async () => {
    if (!mongoReachable) return;
    const res = await postJson('/api/pano/stitch', {
      assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    // Job is created even for non-existent asset ids (the handler itself
    // validates at run time — the route only checks id format here).
    expect(res.status).toBe(201);
  });

  it('unions one resolvable path with one assetId (mixed selection, #1313)', async () => {
    // Regression for the both-fields handling: previously the route preferred
    // paths and IGNORED assetIds, so assetPaths:[one] + assetIds:[one] failed
    // the ≥2 guard even though two distinct assets were referenced. The union
    // accepts it.
    if (!mongoReachable || !db) return;
    const libPath = path.join(tmpDir, 'lib');
    const png = Buffer.from(TINY_PNG_B64, 'base64');

    // One asset referenced by path (indexed on-demand), one by id only.
    const onlyPath = path.join(libPath, 'mixed-a.png');
    await fs.writeFile(onlyPath, png);
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const res = await postJson('/api/pano/stitch', {
      assetPaths: [onlyPath],
      assetIds: [new ObjectId().toHexString()],
      libraryId: folderId.toHexString(),
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    // 1 path + 1 id = 2 distinct inputs → accepted, not rejected as <2 paths.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; indexing?: number };
    expect(ObjectId.isValid(body.id)).toBe(true);
    expect(body.indexing).toBe(1);
  });

  it('rejects a malformed libraryId before creating a job (#1313)', async () => {
    // libraryId flows into `new ObjectId(payload.libraryId)` in the handler;
    // validating it at request time avoids enqueuing a guaranteed-to-crash job.
    if (!mongoReachable) return;
    const res = await postJson('/api/pano/stitch', {
      assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
      libraryId: 'not-an-objectid',
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_library_id');
  });
});

// ── panoStitchHandler — job completion + content identity ────────────────────

describe('panoStitchHandler (completion)', () => {
  it('registers the output asset with its REAL content identity', async () => {
    if (!mongoReachable || !db) return;

    // Two seeded input assets backed by real files in the library root.
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const assetIds: string[] = [];
    for (const name of ['in-a.png', 'in-b.png']) {
      await fs.writeFile(path.join(tmpDir, 'lib', name), png);
      const _id = new ObjectId();
      await db.collection('assets').insertOne({
        _id,
        maple_id: `seed-${name}`,
        fileinfo: [{ path: '', filename: name, library_id: folderId, deleted_at: null }],
      } as never);
      assetIds.push(_id.toHexString());
    }
    // The roots map is a process-wide cache with no TTL; beforeEach inserted
    // a fresh folder doc, so force a reload before the handler resolves paths.
    const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const outputDir = path.join(tmpDir, `handler-out-${process.pid}`);
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const outcome = await panoStitchHandler.run(
      {
        assetIds,
        libraryId: folderId.toHexString(),
        outputDir,
        retention: 'keep',
        localAlign: 'mesh',
        strategy: null,
        strategySupported: false,
        mapleCli: fakeCli,
        modelsDir: null,
        ortDylibPath: null,
      },
      {
        jobId: new ObjectId(),
        reportProgress: async () => {},
        shouldCancel: async () => false,
      },
    );

    expect(outcome.kind).toBe('done');
    const r = (outcome as { result: { outputAssetId: string | null; outputPath: string } }).result;
    expect(r.outputAssetId).not.toBeNull();

    const doc = await db.collection('assets').findOne({ _id: new ObjectId(r.outputAssetId!) });
    expect(doc).not.toBeNull();

    // The registered identity must be the file's real one: a parseable
    // fallback-form maple_id (a stitched PNG has no camera serial) and a
    // sha1_head equal to an independently computed SHA-1 of the head bytes.
    const { fromHex, SHA1_HEAD_BYTES } = await import('../indexer/id.ts');
    expect(fromHex(doc!.maple_id as string).kind).toBe('fallback');

    const written = await fs.readFile(r.outputPath);
    const head = written.subarray(0, Math.min(written.length, SHA1_HEAD_BYTES));
    expect(doc!.sha1_head).toBe(createHash('sha1').update(head).digest('hex'));
  });
});
