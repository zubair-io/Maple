/**
 * Slow-tier enrichment dead-letter triage: the `dead-letter.repo.ts` surface
 * the operator UI calls, and the `/api/enrichment/dead-letter/*` routes on top
 * of it.
 *
 * The storage-level behaviour — the index-ordered list, the histogram's
 * grouping, the guard that stops a reset touching a row that is not parked —
 * is pinned in `src/db/sqlite/repos/enrichment-state.repo.test.ts`. What this
 * file adds is the policy this module owns (the default and maximum limit, the
 * 80-character error class) and the HTTP surface.
 */

import { describe, it, expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import type { EnrichmentStage } from '../src/enrichment/dead-letter.repo.ts';
import {
  groupEnrichmentDeadLetter,
  listEnrichmentDeadLetter,
  resetEnrichmentDeadLetter,
} from '../src/enrichment/dead-letter.repo.ts';
import { enrichmentAdminRoutes } from '../src/routes/enrichment-admin.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { insertEnrichmentState } from '../src/db/sqlite/repos/assets.test-helpers.ts';

// Mounted WITHOUT requireAuth — mirrors enrichment-route.test.ts.
const app = new Elysia().use(enrichmentAdminRoutes);

interface SeedOpts {
  stage: EnrichmentStage;
  deadLetterAt: string | null;
  lastError?: string | null;
  attempts?: number;
  /** Optional second stage to seed in dead-letter on the SAME asset. */
  alsoStage?: EnrichmentStage;
  alsoDeadLetterAt?: string | null;
  alsoLastError?: string | null;
  alsoAttempts?: number;
}

/**
 * One asset with a live location under a library rooted at `/lib`, so
 * `abs_path` resolves to `/lib/<id>.dng`.
 */
function seedAsset(db: Database, opts: SeedOpts): string {
  const rows = db.query(`SELECT id FROM folders LIMIT 1`).all() as Array<{ id: string }>;
  const libraryId = rows[0]?.id ?? insertFolder(db, { path: '/lib' });
  const id = insertAsset(db);
  insertLocation(db, { assetId: id, libraryId, path: '', filename: `${id}.dng` });
  insertEnrichmentState(db, id, opts.stage, {
    deadLetterAt: opts.deadLetterAt,
    lastError: opts.lastError ?? null,
    attempts: opts.attempts ?? 0,
  });
  if (opts.alsoStage) {
    insertEnrichmentState(db, id, opts.alsoStage, {
      deadLetterAt: opts.alsoDeadLetterAt ?? null,
      lastError: opts.alsoLastError ?? null,
      attempts: opts.alsoAttempts ?? 0,
    });
  }
  return id;
}

function enrichmentRow(
  db: Database,
  assetId: string,
  stage: EnrichmentStage,
): { attempts: number; last_error: string | null; dead_letter_at: string | null } {
  return db
    .query(
      `SELECT attempts, last_error, dead_letter_at FROM enrichment_state
        WHERE asset_id = ? AND stage = ?`,
    )
    .get(assetId, stage) as {
    attempts: number;
    last_error: string | null;
    dead_letter_at: string | null;
  };
}

describe('listEnrichmentDeadLetter', () => {
  it('filters by stage, sorts newest first, and resolves the file path', async () => {
    using live = await createLiveTestDatabase();
    const idOldest = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: 'Nominatim 503',
      attempts: 5,
    });
    const idNewest = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-08T00:00:00.000Z',
      lastError: 'Nominatim timeout',
      attempts: 5,
    });
    const idMiddle = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-04T00:00:00.000Z',
      lastError: 'parse error',
      attempts: 5,
    });
    // A face-stage dead letter that should NOT appear in the geocode list.
    seedAsset(live.db, {
      stage: 'face',
      deadLetterAt: '2026-05-09T00:00:00.000Z',
      lastError: 'face boom',
      attempts: 5,
    });
    // A pending (not dead-lettered) geocode row that should also be excluded.
    seedAsset(live.db, { stage: 'geocode', deadLetterAt: null });

    const rows = await listEnrichmentDeadLetter({ stage: 'geocode' });
    expect(rows.map((r) => r.asset_id)).toEqual([idNewest, idMiddle, idOldest]);
    const newest = rows[0]!;
    expect(newest.last_error).toBe('Nominatim timeout');
    expect(newest.attempts).toBe(5);
    expect(newest.dead_letter_at).toBe('2026-05-08T00:00:00.000Z');
    expect(newest.abs_path).toBe(`/lib/${idNewest}.dng`);
  });

  it('respects the limit parameter', async () => {
    using live = await createLiveTestDatabase();
    for (let i = 0; i < 5; i++) {
      seedAsset(live.db, {
        stage: 'geocode',
        deadLetterAt: `2026-05-0${i + 1}T00:00:00.000Z`,
        lastError: `err ${i}`,
        attempts: 5,
      });
    }
    const rows = await listEnrichmentDeadLetter({ stage: 'geocode', limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dead_letter_at).toBe('2026-05-05T00:00:00.000Z');
    expect(rows[1]!.dead_letter_at).toBe('2026-05-04T00:00:00.000Z');
  });
});

describe('groupEnrichmentDeadLetter', () => {
  it('clusters identical errors and returns count + latestTs', async () => {
    using live = await createLiveTestDatabase();
    for (const at of ['2026-05-01', '2026-05-08', '2026-05-05']) {
      seedAsset(live.db, {
        stage: 'geocode',
        deadLetterAt: `${at}T00:00:00.000Z`,
        lastError: 'Nominatim 503',
        attempts: 5,
      });
    }
    seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-09T00:00:00.000Z',
      lastError: 'parse error',
      attempts: 5,
    });
    // face-stage dead letter — must NOT appear when we group geocode.
    seedAsset(live.db, {
      stage: 'face',
      deadLetterAt: '2026-05-09T00:00:00.000Z',
      lastError: 'Nominatim 503',
      attempts: 5,
    });

    const groups = await groupEnrichmentDeadLetter({ stage: 'geocode' });
    expect(groups).toEqual([
      { errorClass: 'Nominatim 503', count: 3, latestTs: '2026-05-08T00:00:00.000Z' },
      { errorClass: 'parse error', count: 1, latestTs: '2026-05-09T00:00:00.000Z' },
    ]);
  });

  it('truncates errorClass at 80 chars so long messages with the same head collapse', async () => {
    using live = await createLiveTestDatabase();
    const head = 'Nominatim 503 - retry after backoff (';
    expect(head.length).toBeLessThan(80);
    const longA = head + 'x'.repeat(80) + '_unique_A';
    const longB = head + 'x'.repeat(80) + '_unique_B';
    seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: longA,
      attempts: 5,
    });
    seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-02T00:00:00.000Z',
      lastError: longB,
      attempts: 5,
    });

    const groups = await groupEnrichmentDeadLetter({ stage: 'geocode' });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.errorClass.length).toBe(80);
    expect(longA.startsWith(groups[0]!.errorClass)).toBe(true);
  });
});

describe('resetEnrichmentDeadLetter', () => {
  it('targets one asset when assetId is provided and leaves the rest parked', async () => {
    using live = await createLiveTestDatabase();
    const target = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: 'Nominatim 503',
      attempts: 5,
    });
    const other = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-02T00:00:00.000Z',
      lastError: 'parse error',
      attempts: 5,
    });

    expect(await resetEnrichmentDeadLetter({ stage: 'geocode', assetId: target })).toEqual({
      resetCount: 1,
    });
    // All three fields flip together, so the post-state is one read.
    expect(enrichmentRow(live.db, target, 'geocode')).toEqual({
      attempts: 0,
      last_error: null,
      dead_letter_at: null,
    });
    expect(enrichmentRow(live.db, other, 'geocode')).toMatchObject({
      dead_letter_at: '2026-05-02T00:00:00.000Z',
      attempts: 5,
    });
  });

  it('resets every dead-lettered row for the stage when assetId is omitted', async () => {
    using live = await createLiveTestDatabase();
    const a = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: 'err a',
      attempts: 5,
    });
    const b = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-02T00:00:00.000Z',
      lastError: 'err b',
      attempts: 5,
    });
    // Pending (not dead-lettered) geocode row — must NOT be counted or touched.
    const pending = seedAsset(live.db, { stage: 'geocode', deadLetterAt: null });

    expect(await resetEnrichmentDeadLetter({ stage: 'geocode' })).toEqual({ resetCount: 2 });
    for (const id of [a, b, pending]) {
      expect(enrichmentRow(live.db, id, 'geocode')).toMatchObject({
        dead_letter_at: null,
        attempts: 0,
      });
    }
  });

  it('does not touch other stages on the same asset', async () => {
    using live = await createLiveTestDatabase();
    const id = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: 'geocode err',
      attempts: 5,
      alsoStage: 'face',
      alsoDeadLetterAt: '2026-05-02T00:00:00.000Z',
      alsoLastError: 'face err',
      alsoAttempts: 5,
    });

    expect(await resetEnrichmentDeadLetter({ stage: 'geocode', assetId: id })).toEqual({
      resetCount: 1,
    });
    expect(enrichmentRow(live.db, id, 'face')).toEqual({
      dead_letter_at: '2026-05-02T00:00:00.000Z',
      last_error: 'face err',
      attempts: 5,
    });
  });

  it('returns resetCount: 0 for an unknown or malformed asset id', async () => {
    using live = await createLiveTestDatabase();
    expect(await resetEnrichmentDeadLetter({ stage: 'geocode', assetId: 'a'.repeat(24) })).toEqual({
      resetCount: 0,
    });
    expect(
      await resetEnrichmentDeadLetter({ stage: 'geocode', assetId: 'not-a-valid-objectid' }),
    ).toEqual({ resetCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(new Request(`http://localhost${path}`));
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function post(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe('GET /api/enrichment/dead-letter', () => {
  it('returns rows newest-first for the stage', async () => {
    using live = await createLiveTestDatabase();
    const idNewest = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-08T00:00:00.000Z',
      lastError: 'Nominatim timeout',
      attempts: 5,
    });
    seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: 'Nominatim 503',
      attempts: 5,
    });
    const r = await get('/api/enrichment/dead-letter?stage=geocode&limit=10');
    expect(r.status).toBe(200);
    const body = r.body as { rows: Array<{ asset_id: string; last_error: string }> };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.asset_id).toBe(idNewest);
    expect(body.rows[0]!.last_error).toBe('Nominatim timeout');
  });

  it('rejects unknown stage with 400', async () => {
    using live = await createLiveTestDatabase();
    const r = await get('/api/enrichment/dead-letter?stage=bogus');
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Invalid stage/);
  });
});

describe('GET /api/enrichment/dead-letter/groups', () => {
  it('returns clustered groups for the stage', async () => {
    using live = await createLiveTestDatabase();
    for (const at of ['2026-05-01', '2026-05-02', '2026-05-03']) {
      seedAsset(live.db, {
        stage: 'geocode',
        deadLetterAt: `${at}T00:00:00.000Z`,
        lastError: 'Nominatim 503',
        attempts: 5,
      });
    }
    const r = await get('/api/enrichment/dead-letter/groups?stage=geocode');
    expect(r.status).toBe(200);
    const body = r.body as { groups: Array<{ errorClass: string; count: number }> };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]!.count).toBe(3);
    expect(body.groups[0]!.errorClass).toBe('Nominatim 503');
  });

  it('rejects unknown stage with 400', async () => {
    using live = await createLiveTestDatabase();
    expect((await get('/api/enrichment/dead-letter/groups?stage=bogus')).status).toBe(400);
  });
});

describe('POST /api/enrichment/dead-letter/reset', () => {
  it('resets one row when assetId is provided', async () => {
    using live = await createLiveTestDatabase();
    const target = seedAsset(live.db, {
      stage: 'geocode',
      deadLetterAt: '2026-05-01T00:00:00.000Z',
      lastError: 'Nominatim 503',
      attempts: 5,
    });
    const r = await post('/api/enrichment/dead-letter/reset', {
      stage: 'geocode',
      assetId: target,
    });
    expect(r.status).toBe(200);
    expect((r.body as { resetCount: number }).resetCount).toBe(1);
    expect(enrichmentRow(live.db, target, 'geocode')).toMatchObject({
      dead_letter_at: null,
      attempts: 0,
    });
  });

  it('resets all dead-lettered rows when assetId is omitted', async () => {
    using live = await createLiveTestDatabase();
    for (const at of ['2026-05-01', '2026-05-02']) {
      seedAsset(live.db, {
        stage: 'geocode',
        deadLetterAt: `${at}T00:00:00.000Z`,
        lastError: 'err',
        attempts: 5,
      });
    }
    const r = await post('/api/enrichment/dead-letter/reset', { stage: 'geocode' });
    expect(r.status).toBe(200);
    expect((r.body as { resetCount: number }).resetCount).toBe(2);
  });

  it('rejects unknown stage with 400', async () => {
    using live = await createLiveTestDatabase();
    expect((await post('/api/enrichment/dead-letter/reset', { stage: 'bogus' })).status).toBe(400);
  });
});
