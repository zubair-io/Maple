/**
 * Tests for POST /api/admin/faces/purge-subthreshold.
 *
 * Real SQLite, installed as the process-wide handle per test, so the route,
 * the enrichment settings it reads and the faces it deletes all see the same
 * database.
 *
 * Covers:
 *   - Audit (dry-run) returns the correct unassigned / assigned / hidden
 *     breakdown.
 *   - Apply (default) removes only unassigned sub-threshold faces.
 *   - Assigned and hidden sub-threshold faces are preserved in default apply
 *     mode.
 *   - Apply with includeAssigned=true also removes assigned sub-threshold
 *     faces.
 *   - Hidden sub-threshold faces are ALWAYS preserved (even with
 *     includeAssigned).
 *   - Above-threshold faces and their person_id are untouched.
 *   - The per-person face count is recomputed for affected people after apply.
 *   - Idempotent: a second apply run removes nothing new.
 *   - Returns 400 when face_min_detection_size is 0.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { saveEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { insertFaceRow, insertPersonRow } from '../db/repos/assets.test-helpers.ts';
import { seedSearchAsset } from '../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';

let live: LiveTestDatabase;
let libraryId: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  libraryId = insertFolder(live.db, { path: '/lib', slug: 'purge-sub' });
});

afterEach(() => {
  live.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One face to seed, described the way the threshold reads it. */
interface SeedFace {
  w: number;
  h: number;
  personId?: string | null;
  hidden?: boolean;
  embedding?: number[];
}

function face(w: number, h: number, opts: Omit<SeedFace, 'w' | 'h'> = {}): SeedFace {
  return { w, h, ...opts };
}

/** An asset carrying these faces, at ascending `face_index`. */
function insertAssetWithFaces(faces: SeedFace[]): string {
  const assetId = seedSearchAsset(live.db, libraryId, { capturedAt: null });
  faces.forEach((f, index) => {
    insertFaceRow(live.db, {
      assetId,
      faceIndex: index,
      personId: f.personId ?? null,
      hidden: f.hidden === true,
      bbox: { x: 0, y: 0, w: f.w, h: f.h },
      embedding: f.embedding === undefined ? null : JSON.stringify(f.embedding),
    });
  });
  return assetId;
}

/** The surviving faces on one asset, in `face_index` order. */
function facesOf(assetId: string): Array<{
  face_index: number;
  person_id: string | null;
  hidden: number;
  bbox_w: number;
  bbox_h: number;
  embedding: string | null;
}> {
  return live.db
    .query(
      `SELECT face_index, person_id, hidden, bbox_w, bbox_h, embedding
         FROM faces WHERE asset_id = ? ORDER BY face_index`,
    )
    .all(assetId) as never;
}

async function setMinSize(size: number): Promise<void> {
  await saveEnrichmentConfig({ face_min_detection_size: size });
}

/** POST to the purge route and parse JSON. */
async function callRoute(
  params: { apply?: boolean; includeAssigned?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { purgeSubthresholdFacesRoutes } = await import('./admin-purge-subthreshold-faces.ts');
  const app = new Elysia().use(purgeSubthresholdFacesRoutes);
  const search = new URLSearchParams();
  if (params.apply) search.set('apply', 'true');
  if (params.includeAssigned) search.set('includeAssigned', 'true');
  const qs = search.toString() ? `?${search.toString()}` : '';
  const res = await app.handle(
    new Request(`http://localhost/api/admin/faces/purge-subthreshold${qs}`, { method: 'POST' }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('purge-subthreshold', () => {
  it('returns 400 when face_min_detection_size is 0', async () => {
    await setMinSize(0);
    const { status } = await callRoute();
    expect(status).toBe(400);
  });

  it('dry-run counts unassigned / assigned / hidden sub-threshold faces', async () => {
    await setMinSize(0.1);
    const personId = insertPersonRow(live.db, 'Audit-Person');

    // 1 unassigned sub-threshold, alongside one above the threshold.
    insertAssetWithFaces([face(0.05, 0.05), face(0.2, 0.2)]);
    // 1 assigned sub-threshold.
    insertAssetWithFaces([face(0.05, 0.08, { personId })]);
    // 1 hidden sub-threshold.
    insertAssetWithFaces([face(0.07, 0.09, { hidden: true })]);

    const { status, body } = await callRoute();
    expect(status).toBe(200);

    const sub = body.subThresholdFaces as Record<string, number>;
    expect(sub.unassigned).toBe(1);
    expect(sub.assigned).toBe(1);
    expect(sub.hidden).toBe(1);
    expect(sub.total).toBe(3);
    expect(body.assetsScanned).toBe(3);
    expect(body.assetsAffected).toBe(3);
    expect(body.mode).toBe('dry-run');
    // Dry-run must NOT include applied stats.
    expect(body.applied).toBeUndefined();
  });

  it('apply default — removes only unassigned sub-threshold, preserves assigned+hidden', async () => {
    await setMinSize(0.1);
    const personId = insertPersonRow(live.db, 'Preserved-Person');

    const assetId = insertAssetWithFaces([
      face(0.04, 0.04), // sub-threshold, unassigned → REMOVE
      face(0.06, 0.06, { personId }), // sub-threshold, assigned → KEEP
      face(0.08, 0.08, { hidden: true }), // sub-threshold, hidden → KEEP
      face(0.2, 0.2), // above-threshold → KEEP
    ]);

    const { status, body } = await callRoute({ apply: true });
    expect(status).toBe(200);

    const applied = body.applied as Record<string, unknown>;
    expect(applied.facesRemoved).toBe(1);
    expect(applied.assetsUpdated).toBe(1);
    expect(body.mode).toBe('apply:unassigned-only');

    const remaining = facesOf(assetId);
    expect(remaining.length).toBe(3);
    // Unassigned sub-threshold is gone.
    expect(
      remaining.some(
        (f) => Math.min(f.bbox_w, f.bbox_h) < 0.1 && f.person_id === null && f.hidden === 0,
      ),
    ).toBe(false);
    // Assigned sub-threshold stays.
    expect(remaining.some((f) => f.person_id === personId)).toBe(true);
    // Hidden stays.
    expect(remaining.some((f) => f.hidden === 1)).toBe(true);
  });

  it('apply with includeAssigned — also removes assigned sub-threshold, still preserves hidden', async () => {
    await setMinSize(0.1);
    const personId = insertPersonRow(live.db, 'Assigned-Remove');

    const assetId = insertAssetWithFaces([
      face(0.04, 0.04), // sub-threshold, unassigned → REMOVE
      face(0.06, 0.06, { personId }), // sub-threshold, assigned → REMOVE (opted in)
      face(0.07, 0.07, { hidden: true }), // sub-threshold, hidden → KEEP (always)
      face(0.3, 0.3, { personId }), // above-threshold, assigned → KEEP
    ]);

    const { status, body } = await callRoute({ apply: true, includeAssigned: true });
    expect(status).toBe(200);
    expect(body.mode).toBe('apply:all');

    const applied = body.applied as Record<string, unknown>;
    expect(applied.facesRemoved).toBe(2);
    expect(applied.assetsUpdated).toBe(1);

    const remaining = facesOf(assetId);
    expect(remaining.length).toBe(2);
    // Hidden still present.
    expect(remaining.some((f) => f.hidden === 1)).toBe(true);
    // Above-threshold assigned still present.
    expect(
      remaining.some((f) => Math.min(f.bbox_w, f.bbox_h) >= 0.1 && f.person_id === personId),
    ).toBe(true);
  });

  it('face count recomputed correctly for affected people after apply', async () => {
    await setMinSize(0.1);
    const personId = insertPersonRow(live.db, 'Recompute-Person');

    // 1 assigned sub-threshold (removed) + 1 above-threshold (kept).
    insertAssetWithFaces([
      face(0.05, 0.05, { personId }), // sub-threshold → REMOVE
      face(0.3, 0.3, { personId }), // above-threshold → KEEP
    ]);

    const { status, body } = await callRoute({ apply: true, includeAssigned: true });
    expect(status).toBe(200);

    const applied = body.applied as Record<string, unknown>;
    expect(applied.personCountsRecomputed).toBe(1);
    // Only one above-threshold assigned, unhidden face survives. The count is
    // derived from the rows rather than stored, so this is what the route
    // reports back rather than a column it wrote.
    expect(applied.personRecomputes).toEqual([{ personId, newCount: 1 }]);
  });

  it('above-threshold faces and their person_id are untouched', async () => {
    await setMinSize(0.1);
    const personId = insertPersonRow(live.db, 'Untouched');

    const assetId = insertAssetWithFaces([face(0.2, 0.25, { personId })]);

    const { status, body } = await callRoute({ apply: true, includeAssigned: true });
    expect(status).toBe(200);

    const applied = body.applied as Record<string, unknown>;
    expect(applied.facesRemoved).toBe(0);
    expect(applied.assetsUpdated).toBe(0);

    const remaining = facesOf(assetId);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.person_id).toBe(personId);
  });

  it('idempotent — second apply run removes nothing new', async () => {
    await setMinSize(0.1);
    insertAssetWithFaces([face(0.04, 0.04), face(0.3, 0.3)]);

    const first = await callRoute({ apply: true });
    expect((first.body.applied as Record<string, unknown>).facesRemoved).toBe(1);

    const second = await callRoute({ apply: true });
    expect((second.body.applied as Record<string, unknown>).facesRemoved).toBe(0);
    expect((second.body.applied as Record<string, unknown>).assetsUpdated).toBe(0);
  });

  it('a concurrent per-face write survives the purge, and indices do not shift', async () => {
    await setMinSize(0.1);

    // Three faces: [0] above-threshold (kept), [1] sub-threshold unassigned
    // (removed), [2] above-threshold (kept). On MongoDB this was the `$pull`
    // test: `faces[]` was an array, so removing [1] renumbered [2] to [1] and
    // a concurrent `$set faces.2.embedding` would land on the wrong face. A
    // face is a row here and `face_index` is a stored column, so the surviving
    // faces keep the indices they had — which is what a concurrent embed
    // write, addressed by index, depends on.
    const assetId = insertAssetWithFaces([face(0.3, 0.3), face(0.04, 0.04), face(0.25, 0.25)]);

    // Simulate a concurrent face-embed worker writing an embedding onto a
    // SURVIVING face (index 2) just before the purge runs.
    const embedding = [0.1, 0.2, 0.3, 0.4];
    run(
      live.db,
      `UPDATE faces SET embedding = ? WHERE asset_id = ? AND face_index = 2`,
      JSON.stringify(embedding),
      assetId,
    );

    const { status, body } = await callRoute({ apply: true });
    expect(status).toBe(200);
    expect((body.applied as Record<string, unknown>).facesRemoved).toBe(1);

    const remaining = facesOf(assetId);
    expect(remaining.length).toBe(2);
    // The removed face is gone, and the embedding is still on face 2 — it did
    // not move, and nothing overwrote it.
    expect(remaining.map((f) => f.face_index)).toEqual([0, 2]);
    const withEmbedding = remaining.find((f) => f.embedding !== null);
    expect(withEmbedding?.face_index).toBe(2);
    expect(JSON.parse(withEmbedding!.embedding!)).toEqual(embedding);
    expect(Math.min(withEmbedding!.bbox_w, withEmbedding!.bbox_h) >= 0.1).toBe(true);
  });

  it('the delete matches exactly the faces the audit called removable', async () => {
    // The Mongo route carried two spellings of "this face is removable" — a
    // `$pull` element predicate and a JavaScript mirror of it for the audit
    // tally — and a unit test held them in lockstep by comparing their shapes.
    // There is one spelling now, in SQL, so the thing worth pinning is the
    // population: the audit's own numbers, and the rows that survive.
    await setMinSize(0.1);
    const personId = insertPersonRow(live.db, 'Lockstep');

    const assetId = insertAssetWithFaces([
      face(0.05, 0.05), // sub, unassigned, visible
      face(0.05, 0.05, { personId }), // sub, assigned, visible
      face(0.05, 0.05, { hidden: true }), // sub, hidden
      face(0.3, 0.3), // above threshold
      // Only ONE side below the threshold is still below it: the predicate is
      // an OR over the two sides, not a test of the larger one.
      face(0.05, 0.4),
      face(0.4, 0.05),
    ]);

    const dryRun = await callRoute();
    const sub = dryRun.body.subThresholdFaces as Record<string, number>;
    expect(sub).toEqual({ unassigned: 3, assigned: 1, hidden: 1, total: 5 });

    // Default mode removes the three visible, unassigned ones and nothing else.
    const applied = await callRoute({ apply: true });
    expect((applied.body.applied as Record<string, unknown>).facesRemoved).toBe(3);
    expect(facesOf(assetId).map((f) => f.face_index)).toEqual([1, 2, 3]);

    // Opting in then takes the assigned one, and still never the hidden one.
    const withAssigned = await callRoute({ apply: true, includeAssigned: true });
    expect((withAssigned.body.applied as Record<string, unknown>).facesRemoved).toBe(1);
    expect(facesOf(assetId).map((f) => f.face_index)).toEqual([2, 3]);
  });
});
