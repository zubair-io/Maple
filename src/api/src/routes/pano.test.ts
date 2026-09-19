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
 * The handlers reach `sqliteDb()` with no override, so each test installs its
 * own database as the process-wide handle for the block. Nothing external is
 * required and nothing is skipped.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { panoRoutes } from './pano.ts';
import {
  createLiveTestDatabase,
  insertFolder,
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
  libraryId: folderId ?? new ObjectId().toHexString(),
  options: { retention: 'keep', localAlign: 'mesh' },
});

// ── probeStrategySupported (comment #4) ───────────────────────────────────────
// These are unit tests against the private probe logic exercised via
// PUT /api/pano/config, which invalidates the cache and re-probes.

describe('probeStrategySupported via PUT /api/pano/config', () => {
  it('returns strategy_supported:true when help output contains --strategy flag', async () => {
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
    const res = await getReq('/api/pano/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; maple_cli_path: null };
    expect(body.enabled).toBe(false);
    expect(body.maple_cli_path).toBeNull();
  });
});

describe('PUT /api/pano/config', () => {
  it('persists config and returns updated values', async () => {
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
    const res = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pano_not_provisioned');
  });

  it('returns 409 pano_not_provisioned when enabled=false', async () => {
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
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
  });

  it('creates a queued job and returns 201 + id', async () => {
    const res = await postJson('/api/pano/stitch', STITCH_BODY());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(ObjectId.isValid(body.id)).toBe(true);
  });

  it('returns 409 pano_job_running when a job is already running', async () => {
    // Manually insert a running job to simulate the concurrent-job guard.
    const now = new Date().toISOString();
    run(
      live.db,
      `INSERT INTO jobs
         (id, kind, status, locked_by, lease_expires_at, cancel_requested,
          progress_current, progress_total, error, created_at, updated_at, params)
       VALUES (?, 'pano_stitch', 'running', 'worker-1', ?, 0, 0, 0, NULL, ?, ?, '{}')`,
      new ObjectId().toHexString(),
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
    );

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
    const res = await getReq(`/api/pano/jobs/${new ObjectId().toHexString()}`);
    expect(res.status).toBe(404);
  });

  it('returns the job when it exists', async () => {
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
    await putJson('/api/pano/config', { maple_cli_path: fakeCli, enabled: true });
    const { id } = (await (await postJson('/api/pano/stitch', STITCH_BODY())).json()) as {
      id: string;
    };

    const res = await deleteReq(`/api/pano/jobs/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify the flag was set.
    const row = live.db.query(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(id) as {
      cancel_requested: number;
    } | null;
    expect(row?.cancel_requested).toBe(1);
  });
});
