/**
 * Tests for POST /api/admin/faces/purge-subthreshold.
 *
 * Uses a real throwaway MongoDB on MAPLE_MONGO_URI (defaults to
 * mongodb://localhost:27017 — CI overrides to :27077 to avoid the dev DB).
 * Each test gets a fresh assets/people state via setupMongoHarness beforeEach.
 * Tests skip-pass when MongoDB is unreachable.
 *
 * Covers:
 *   - Audit (dry-run) returns correct unassigned / assigned / hidden breakdown.
 *   - Apply (default) removes only unassigned sub-threshold faces.
 *   - Assigned and hidden sub-threshold faces preserved in default apply mode.
 *   - Apply with includeAssigned=true also removes assigned sub-threshold faces.
 *   - Hidden sub-threshold faces are ALWAYS preserved (even with includeAssigned).
 *   - Above-threshold faces and their person_id are untouched.
 *   - face_count is recomputed correctly for affected people after apply.
 *   - Idempotent: a second apply run removes nothing new.
 *   - Returns 400 when face_min_detection_size is 0.
 */

import { describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId } from 'mongodb';
import { setupMongoHarness } from '../people/people-repo.test-helpers.ts';
import type { AssetFaceDoc, PersonDoc } from '../db/schema.ts';

const TEST_DB = `maple_test_purge_sub_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal face doc. */
function face(
  w: number,
  h_: number,
  opts: { person_id?: string | null; hidden?: boolean } = {},
): AssetFaceDoc {
  return {
    bbox: { x: 0, y: 0, w, h: h_ },
    confidence: 0.9,
    person_id: opts.person_id ?? null,
    hidden: opts.hidden ?? false,
  };
}

/** Inject / update the enrichment config threshold in the test DB.
 * The persisted shape is `{ _id: 'enrichment', config: { ... } }`. */
async function setMinSize(size: number): Promise<void> {
  await h.db
    .collection('app_settings')
    .updateOne(
      { _id: 'enrichment' as never },
      { $set: { 'config.face_min_detection_size': size } },
      { upsert: true },
    );
}

/** Insert a minimal PersonDoc so recomputePersonFaceCount can write to it. */
async function insertPerson(name: string, faceCount = 0): Promise<string> {
  const oid = new ObjectId();
  await h.db.collection('people').insertOne({
    _id: oid,
    name,
    face_count: faceCount,
    hidden: false,
    created_at: new Date().toISOString(),
  } as unknown as PersonDoc);
  return oid.toHexString();
}

/** Build the route app from a fresh import each call. */
async function buildApp() {
  const { purgeSubthresholdFacesRoutes } = await import('./admin-purge-subthreshold-faces.ts');
  return new Elysia().use(purgeSubthresholdFacesRoutes);
}

/** POST to the purge route and parse JSON. */
async function callRoute(
  params: { apply?: boolean; includeAssigned?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = await buildApp();
  const search = new URLSearchParams();
  if (params.apply) search.set('apply', 'true');
  if (params.includeAssigned) search.set('includeAssigned', 'true');
  const qs = search.toString() ? `?${search.toString()}` : '';
  const res = await app.handle(
    new Request(`http://localhost/api/admin/faces/purge-subthreshold${qs}`, {
      method: 'POST',
    }),
  );
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('purge-subthreshold', () => {
  it('returns 400 when face_min_detection_size is 0', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0);
    const { status } = await callRoute();
    expect(status).toBe(400);
  });

  it('dry-run counts unassigned / assigned / hidden sub-threshold faces', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0.1);

    const personId = await insertPerson('Audit-Person', 5);

    // 1 unassigned sub-threshold
    await h.insertAssetWithFaces([
      face(0.05, 0.05),
      face(0.2, 0.2), // above-threshold
    ]);
    // 1 assigned sub-threshold
    await h.insertAssetWithFaces([face(0.05, 0.08, { person_id: personId })]);
    // 1 hidden sub-threshold
    await h.insertAssetWithFaces([face(0.07, 0.09, { hidden: true })]);

    const { status, body } = await callRoute();
    expect(status).toBe(200);

    const sub = body.subThresholdFaces as Record<string, number>;
    expect(sub.unassigned).toBe(1);
    expect(sub.assigned).toBe(1);
    expect(sub.hidden).toBe(1);
    expect(sub.total).toBe(3);
    expect(body.mode).toBe('dry-run');
    // Dry-run must NOT include applied stats.
    expect(body.applied).toBeUndefined();
  });

  it('apply default — removes only unassigned sub-threshold, preserves assigned+hidden', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0.1);

    const personId = await insertPerson('Preserved-Person', 2);

    const assetId = await h.insertAssetWithFaces([
      face(0.04, 0.04), // sub-threshold, unassigned → REMOVE
      face(0.06, 0.06, { person_id: personId }), // sub-threshold, assigned → KEEP
      face(0.08, 0.08, { hidden: true }), // sub-threshold, hidden → KEEP
      face(0.2, 0.2), // above-threshold → KEEP
    ]);

    const { status, body } = await callRoute({ apply: true });
    expect(status).toBe(200);

    const applied = body.applied as Record<string, unknown>;
    expect(applied.facesRemoved).toBe(1);
    expect(applied.assetsUpdated).toBe(1);
    expect(body.mode).toBe('apply:unassigned-only');

    const stored = (await h.db.collection('assets').findOne({ _id: assetId } as never)) as {
      faces?: AssetFaceDoc[];
    } | null;
    const remaining = stored?.faces ?? [];
    expect(remaining.length).toBe(3);
    // Unassigned sub-threshold is gone.
    const hasUnassignedSub = remaining.some(
      (f) => Math.min(f.bbox.w, f.bbox.h) < 0.1 && !f.person_id && !f.hidden,
    );
    expect(hasUnassignedSub).toBe(false);
    // Assigned sub-threshold stays.
    expect(remaining.some((f) => f.person_id === personId)).toBe(true);
    // Hidden stays.
    expect(remaining.some((f) => f.hidden === true)).toBe(true);
  });

  it('apply with includeAssigned — also removes assigned sub-threshold, still preserves hidden', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0.1);

    const personId = await insertPerson('Assigned-Remove', 3);

    const assetId = await h.insertAssetWithFaces([
      face(0.04, 0.04), // sub-threshold, unassigned → REMOVE
      face(0.06, 0.06, { person_id: personId }), // sub-threshold, assigned → REMOVE (opted in)
      face(0.07, 0.07, { hidden: true }), // sub-threshold, hidden → KEEP (always)
      face(0.3, 0.3, { person_id: personId }), // above-threshold, assigned → KEEP
    ]);

    const { status, body } = await callRoute({ apply: true, includeAssigned: true });
    expect(status).toBe(200);
    expect(body.mode).toBe('apply:all');

    const applied = body.applied as Record<string, unknown>;
    expect(applied.facesRemoved).toBe(2);
    expect(applied.assetsUpdated).toBe(1);

    const stored = (await h.db.collection('assets').findOne({ _id: assetId } as never)) as {
      faces?: AssetFaceDoc[];
    } | null;
    const remaining = stored?.faces ?? [];
    expect(remaining.length).toBe(2);
    // Hidden still present.
    expect(remaining.some((f) => f.hidden === true)).toBe(true);
    // Above-threshold assigned still present.
    expect(
      remaining.some((f) => Math.min(f.bbox.w, f.bbox.h) >= 0.1 && f.person_id === personId),
    ).toBe(true);
  });

  it('face_count recomputed correctly for affected people after apply', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0.1);

    const personId = await insertPerson('Recompute-Person', 10); // stale count

    // 1 assigned sub-threshold (removed) + 1 above-threshold (kept)
    await h.insertAssetWithFaces([
      face(0.05, 0.05, { person_id: personId }), // sub-threshold → REMOVE
      face(0.3, 0.3, { person_id: personId }), // above-threshold → KEEP
    ]);

    const { status, body } = await callRoute({ apply: true, includeAssigned: true });
    expect(status).toBe(200);

    const applied = body.applied as Record<string, unknown>;
    expect((applied.personCountsRecomputed as number) >= 1).toBe(true);

    const person = (await h.db
      .collection('people')
      .findOne({ _id: new ObjectId(personId) } as never)) as PersonDoc | null;
    // Only 1 above-threshold assigned non-hidden face survives.
    expect(person?.face_count).toBe(1);
  });

  it('above-threshold faces and their person_id are untouched', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0.1);

    const personId = await insertPerson('Untouched', 1);

    const assetId = await h.insertAssetWithFaces([
      face(0.2, 0.25, { person_id: personId }), // above-threshold, assigned
    ]);

    const { status, body } = await callRoute({ apply: true, includeAssigned: true });
    expect(status).toBe(200);

    const applied = body.applied as Record<string, unknown>;
    expect(applied.facesRemoved).toBe(0);
    expect(applied.assetsUpdated).toBe(0);

    const stored = (await h.db.collection('assets').findOne({ _id: assetId } as never)) as {
      faces?: AssetFaceDoc[];
    } | null;
    expect(stored?.faces?.length).toBe(1);
    expect(stored?.faces?.[0].person_id).toBe(personId);
  });

  it('idempotent — second apply run removes nothing new', async () => {
    if (!h.mongoReachable) return;
    await setMinSize(0.1);

    await h.insertAssetWithFaces([
      face(0.04, 0.04), // sub-threshold, unassigned
      face(0.3, 0.3), // above-threshold
    ]);

    // First apply.
    const first = await callRoute({ apply: true });
    expect((first.body.applied as Record<string, unknown>).facesRemoved).toBe(1);

    // Second apply — nothing left to remove.
    const second = await callRoute({ apply: true });
    expect((second.body.applied as Record<string, unknown>).facesRemoved).toBe(0);
    expect((second.body.applied as Record<string, unknown>).assetsUpdated).toBe(0);
  });
});
