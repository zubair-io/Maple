/**
 * routes/pano.ts integration tests (#1231).
 *
 * Uses a real MongoDB on :27077 (throwaway — never touches :27017).
 * Skip-passes when Mongo is unreachable (CI without services).
 *
 * A fake maple-cli shell script stands in for the real binary so tests
 * never need ML models. The fake:
 *   - Prints 6 pano: <stage> progress lines to stderr.
 *   - Writes a 1×1 white PNG to the path given via --out.
 *   - Exits 0.
 *
 * Tests cover:
 *   - 409 when pano is not provisioned
 *   - 409 when a job is already running
 *   - 201 + job id on success
 *   - GET /api/pano/jobs/:id returns the job
 *   - DELETE /api/pano/jobs/:id sets cancel_requested
 *   - GET/PUT /api/pano/config round-trips
 *   - 400 on bad ObjectId
 *
 * Path-resolution, index-on-demand, and security tests live in
 * pano.resolve.test.ts (#1311, #1313).
 *
 * DB isolation: getDb() is a singleton. When bun test runs the full suite in
 * one process, a prior test file may have already connected the singleton to
 * :27017. We reset it via closeDb() in beforeAll so the first route call in
 * this file reconnects using our :27077 env vars. The env vars are set at
 * module scope — they're evaluated before any route call even though ESM
 * imports are hoisted (getDb() is lazy; it reads env at connect-time).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { panoRoutes } from './pano.ts';
import { withTestDb, withTestEnv } from '../db/test-db.test-helpers.ts';

// Standalone test DB — never touches the dev DB on :27017.
const MONGO_URL = 'mongodb://localhost:27077';
const TEST_DB = `maple_pano_test_${process.pid}`;

// Both overrides are claimed in beforeAll and restored in afterAll. Leaving
// the URI pointing at :27077 makes every later test file in the same process
// reconnect to a port that only exists on dev machines (CI has no :27077 —
// the whole tail of the suite times out "MongoDB unreachable"), and capturing
// the prior value at module scope would capture pano.resolve.test.ts's own
// :27077 override and then restore THAT process-wide.
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-test-'));
  fakeCli = path.join(tmpDir, 'fake-maple-cli');
  await fs.writeFile(
    fakeCli,
    `#!/bin/sh
# Fake maple-cli for pano route tests.
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

async function getReq(url: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${url}`));
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

async function deleteReq(url: string): Promise<Response> {
  return app.handle(new Request(`http://localhost${url}`, { method: 'DELETE' }));
}

const STITCH_BODY = () => ({
  assetIds: [new ObjectId().toHexString(), new ObjectId().toHexString()],
  libraryId: folderId?.toHexString() ?? new ObjectId().toHexString(),
  options: { retention: 'keep', localAlign: 'mesh' },
});

// ── probeStrategySupported (comment #4) ───────────────────────────────────────
// These are unit tests against the private probe logic exercised via
// PUT /api/pano/config, which invalidates the cache and re-probes.

describe('probeStrategySupported via PUT /api/pano/config', () => {
  it('returns strategy_supported:true when help output contains --strategy flag', async () => {
    if (!mongoReachable) return;
    // Write a fake CLI that prints --strategy in its help output (to stdout).
    const strategyFakeCli = path.join(tmpDir, 'fake-cli-with-strategy');
    await fs.writeFile(
      strategyFakeCli,
      `#!/bin/sh\necho "Usage: maple-cli pano stitch [OPTIONS] [FILES]"\necho "    --strategy <STRATEGY>  Projection strategy [auto|rotation|tile]"\nexit 0\n`,
    );
    await fs.chmod(strategyFakeCli, 0o755);

    const res = await putJson('/api/pano/config', {
      maple_cli_path: strategyFakeCli,
      enabled: true,
    });
    const body = (await res.json()) as { strategy_supported: boolean };
    expect(body.strategy_supported).toBe(true);
  });

  it('returns strategy_supported:false when help output only mentions word "strategy" without the --flag', async () => {
    if (!mongoReachable) return;
    // A help text that mentions "strategy" as a noun but NOT "--strategy".
    // The old code matched `.includes('strategy')` which would be a false positive.
    const noFlagFakeCli = path.join(tmpDir, 'fake-cli-no-strategy-flag');
    await fs.writeFile(
      noFlagFakeCli,
      `#!/bin/sh\necho "Uses a rotation strategy for panoramas."\nexit 0\n`,
    );
    await fs.chmod(noFlagFakeCli, 0o755);

    const res = await putJson('/api/pano/config', { maple_cli_path: noFlagFakeCli, enabled: true });
    const body = (await res.json()) as { strategy_supported: boolean };
    expect(body.strategy_supported).toBe(false);
  });

  it('returns strategy_supported:true when --strategy flag appears on stderr (some clap versions)', async () => {
    if (!mongoReachable) return;
    // Some clap versions print help to stderr; the probe must capture both.
    const stderrFakeCli = path.join(tmpDir, 'fake-cli-strategy-stderr');
    await fs.writeFile(
      stderrFakeCli,
      `#!/bin/sh\necho "    --strategy <STRATEGY>  Projection strategy" >&2\nexit 0\n`,
    );
    await fs.chmod(stderrFakeCli, 0o755);

    const res = await putJson('/api/pano/config', { maple_cli_path: stderrFakeCli, enabled: true });
    const body = (await res.json()) as { strategy_supported: boolean };
    expect(body.strategy_supported).toBe(true);
  });
});

// ── config round-trip ─────────────────────────────────────────────────────────

describe('GET /api/pano/config', () => {
  it('returns defaults when no config saved', async () => {
    if (!mongoReachable) return;
    const res = await getReq('/api/pano/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; maple_cli_path: null };
    expect(body.enabled).toBe(false);
    expect(body.maple_cli_path).toBeNull();
  });
});

describe('PUT /api/pano/config', () => {
  it('persists config and returns updated values', async () => {
    if (!mongoReachable) return;
    const res = await putJson('/api/pano/config', {
      maple_cli_path: fakeCli,
      enabled: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; maple_cli_path: string; enabled: boolean };
    expect(body.ok).toBe(true);
    expect(body.maple_cli_path).toBe(fakeCli);
    expect(body.enabled).toBe(true);
  });
});

// ── provisioning gate ─────────────────────────────────────────────────────────

describe('POST /api/pano/stitch (provisioning)', () => {
  it('returns 409 pano_not_provisioned when config absent', async () => {
    if (!mongoReachable) return;
    const res = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pano_not_provisioned');
  });

  it('returns 409 pano_not_provisioned when enabled=false', async () => {
    if (!mongoReachable) return;
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: false });
    const res = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pano_not_provisioned');
  });
});

// ── job creation ──────────────────────────────────────────────────────────────

describe('POST /api/pano/stitch (provisioned)', () => {
  beforeEach(async () => {
    if (!mongoReachable) return;
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
  });

  it('creates a queued job and returns 201 + id', async () => {
    if (!mongoReachable) return;
    const res = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(ObjectId.isValid(body.id)).toBe(true);
  });

  it('returns 409 pano_job_running when a job is already running', async () => {
    if (!mongoReachable) return;
    // Manually insert a running job to simulate the concurrent-job guard.
    await db!.collection('jobs').insertOne({
      kind: 'pano_stitch',
      status: 'running',
      payload: {},
      progress: { current: 0, total: 0 },
      result: null,
      error: null,
      locked_by: 'worker-1',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      cancel_requested: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never);

    const res = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pano_job_running');
  });

  it('returns 409 pano_job_running when a queued job already exists (back-to-back requests)', async () => {
    // Two close-together stitch POSTs must not enqueue multiple concurrent jobs.
    // The first creates a queued job; the second must see the queued job and
    // return 409 — not enqueue a second job that a worker would later execute
    // concurrently (pano is ~tens of GB RSS, concurrent runs OOM the box).
    if (!mongoReachable) return;
    // First request — should succeed.
    const first = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(first.status).toBe(201);
    // Second request — the queued job from the first is already in DB.
    const second = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('pano_job_running');
  });

  it('rejects when assetIds has fewer than 2 items', async () => {
    if (!mongoReachable) return;
    const res = await postJson('/api/pano/stitch', {
      ...STITCH_BODY(),
      assetIds: [new ObjectId().toHexString()],
    });
    expect(res.status).toBe(422);
  });
});

// ── GET /api/pano/jobs/:id ────────────────────────────────────────────────────

describe('GET /api/pano/jobs/:id', () => {
  it('returns 400 on invalid ObjectId', async () => {
    const res = await getReq('/api/pano/jobs/not-an-id');
    expect(res.status).toBe(400);
  });

  it('returns 404 when job does not exist', async () => {
    if (!mongoReachable) return;
    const res = await getReq(`/api/pano/jobs/${new ObjectId().toHexString()}`);
    expect(res.status).toBe(404);
  });

  it('returns the job when it exists', async () => {
    if (!mongoReachable) return;
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
    const createRes = await postJson('/api/pano/stitch', STITCH_BODY());
    const { id } = (await createRes.json()) as { id: string };

    const res = await getReq(`/api/pano/jobs/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; kind: string; status: string };
    expect(body.id).toBe(id);
    expect(body.kind).toBe('pano_stitch');
    expect(body.status).toBe('queued');
  });
});

// ── DELETE /api/pano/jobs/:id ─────────────────────────────────────────────────

describe('DELETE /api/pano/jobs/:id', () => {
  it('returns 400 on invalid ObjectId', async () => {
    const res = await deleteReq('/api/pano/jobs/bad');
    expect(res.status).toBe(400);
  });

  it('sets cancel_requested on a queued job', async () => {
    if (!mongoReachable) return;
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
    const { id } = (await (await postJson('/api/pano/stitch', STITCH_BODY())).json()) as {
      id: string;
    };

    const res = await deleteReq(`/api/pano/jobs/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify the flag was set.
    const doc = await db!.collection('jobs').findOne({ _id: new ObjectId(id) });
    expect(doc?.cancel_requested).toBe(true);
  });
});
