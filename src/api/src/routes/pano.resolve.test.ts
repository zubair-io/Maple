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
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block. Nothing external is
 * required and nothing is skipped.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from '../db/object-id.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { panoRoutes } from './pano.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const app = new Elysia().use(panoRoutes);

let live: LiveTestDatabase;

/** Absolute path of the fake maple-cli shell script. */
let fakeCli = '';
let tmpDir = '';
let folderId: string;

// 1×1 white PNG (PNG spec: 8-byte signature + IHDR + IDAT + IEND).
// Generated once and embedded as base64 to avoid any runtime dependency.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(async () => {
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
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  folderId = insertFolder(live.db, { path: libPath, slug: 'pano-lib' });
  // The roots map is a process-wide cache with no TTL, so a sibling test's
  // library would otherwise answer this one's jail check.
  invalidateLibraryRoots();
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
});

/** One indexed asset at the library root, backed by a real file. */
function seedIndexed(filename: string, mapleId: string): string {
  const assetId = insertAsset(live.db);
  run(live.db, `UPDATE assets SET maple_id = ? WHERE id = ?`, mapleId, assetId);
  insertLocation(live.db, { assetId, libraryId: folderId, path: '', filename });
  return assetId;
}

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
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
  });

  it('resolves already-indexed assets by path and creates a queued job', async () => {
    const libPath = path.join(tmpDir, 'lib');

    // Write real files and seed asset docs pointing at them.
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const assetPaths: string[] = [];
    for (const name of ['path-a.png', 'path-b.png']) {
      const filePath = path.join(libPath, name);
      await fs.writeFile(filePath, png);
      assetPaths.push(filePath);
      seedIndexed(name, `seed-path-${name}`);
    }

    const res = await postJson('/api/pano/stitch', {
      assetPaths,
      libraryId: folderId,
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; indexing?: number };
    expect(ObjectId.isValid(body.id)).toBe(true);
    // All paths were already indexed — no on-demand indexing needed.
    expect(body.indexing).toBeUndefined();
  });

  it('indexes an in-library path on-demand when not yet in the DB', async () => {
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

    const res = await postJson('/api/pano/stitch', {
      assetPaths,
      libraryId: folderId,
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; indexing?: number };
    expect(ObjectId.isValid(body.id)).toBe(true);
    // Both paths were indexed on-demand.
    expect(body.indexing).toBe(2);
    // Both catalog rows must now exist.
    for (const p of assetPaths) {
      const filename = path.basename(p);
      const row = live.db
        .query(`SELECT asset_id FROM asset_locations WHERE filename = ?`)
        .get(filename);
      expect(row).not.toBeNull();
    }
  });

  it('rejects a path that is outside every registered library root (security)', async () => {
    const res = await postJson('/api/pano/stitch', {
      // /etc/passwd is never under a registered library root.
      assetPaths: ['/etc/passwd', '/etc/hosts'],
      libraryId: folderId,
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
    const libPath = path.join(tmpDir, 'lib');

    // Craft a traversal path: starts with the library root so a raw-string
    // prefix check would pass, but resolves outside it via "..".
    const traversalPath = path.join(libPath, '..', '..', 'etc', 'hosts');

    const res = await postJson('/api/pano/stitch', {
      assetPaths: [traversalPath, traversalPath],
      libraryId: folderId,
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
    const res = await postJson('/api/pano/stitch', {
      libraryId: folderId,
      options: { retention: 'keep', localAlign: 'mesh' },
    });
    expect(res.status).toBe(422);
  });

  it('accepts legacy assetIds-only request without paths', async () => {
    const res = await postJson('/api/pano/stitch', {
      assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
      libraryId: folderId,
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
    const libPath = path.join(tmpDir, 'lib');
    const png = Buffer.from(TINY_PNG_B64, 'base64');

    // One asset referenced by path (indexed on-demand), one by id only.
    const onlyPath = path.join(libPath, 'mixed-a.png');
    await fs.writeFile(onlyPath, png);

    const res = await postJson('/api/pano/stitch', {
      assetPaths: [onlyPath],
      assetIds: [new ObjectId().toHexString()],
      libraryId: folderId,
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
    // Two seeded input assets backed by real files in the library root.
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const assetIds: string[] = [];
    for (const name of ['in-a.png', 'in-b.png']) {
      await fs.writeFile(path.join(tmpDir, 'lib', name), png);
      assetIds.push(seedIndexed(name, `seed-${name}`));
    }

    const outputDir = path.join(tmpDir, `handler-out-${process.pid}`);
    const { panoStitchHandler } = await import('../job-runner/handlers/pano-stitch.ts');
    const outcome = await panoStitchHandler.run(
      {
        assetIds,
        libraryId: folderId,
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
    if (outcome.kind !== 'done') throw new Error('Expected completed stitch');
    const r = outcome.result;
    if (typeof r.outputAssetId !== 'string') throw new Error('Expected output asset ID');
    expect(r.outputAssetId).not.toBeNull();

    const doc = live.db
      .query(`SELECT maple_id, sha1_head FROM assets WHERE id = ?`)
      .get(r.outputAssetId!) as { maple_id: string; sha1_head: string } | null;
    expect(doc).not.toBeNull();

    // The registered identity must be the file's real one: a parseable
    // fallback-form maple_id (a stitched PNG has no camera serial) and a
    // sha1_head equal to an independently computed SHA-1 of the head bytes.
    const { fromHex, SHA1_HEAD_BYTES } = await import('../indexer/id.ts');
    expect(fromHex(doc!.maple_id).kind).toBe('fallback');

    if (typeof r.outputPath !== 'string') throw new Error('Expected output path');
    const written = await fs.readFile(r.outputPath);
    const head = written.subarray(0, Math.min(written.length, SHA1_HEAD_BYTES));
    expect(doc!.sha1_head).toBe(createHash('sha1').update(head).digest('hex'));
  });
});
