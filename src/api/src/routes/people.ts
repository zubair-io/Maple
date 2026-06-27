/**
 * /api/people/* — face-cluster identity routes.
 *
 *   GET    /api/people                — list with face counts (excludes hidden)
 *   GET    /api/people/hidden         — soft-hidden people (the Hidden page)
 *   GET    /api/people/:id            — single person + recent face thumbnails
 *   POST   /api/people                — body { name } → create or return existing
 *   PUT    /api/people/:id            — body { name } → rename; merge on collision
 *   POST   /api/people/:id/hide       — soft-hide a person (keeps faces + row)
 *   POST   /api/people/:id/unhide     — restore a hidden person
 *   POST   /api/people/cluster        — kicks off online clustering
 *   POST   /api/people/assign         — manual face → person override
 *   POST   /api/people/hide           — hide a face (excluded from clustering)
 *   POST   /api/people/merge          — merge source people into a target (target survives)
 *
 * Mounted behind `requireAuth` in `src/api/src/index.ts`.
 */

import { Elysia, t } from 'elysia';
import { ObjectId } from 'mongodb';
import { backfillCoverAssets } from '../people/clustering-job.ts';
import { clusterCoordinator } from '../people/cluster-coordinator.ts';
import {
  assignFaceToPerson,
  createPerson,
  FACE_DETAIL_LIMIT,
  getPerson,
  hideFace,
  hidePerson,
  listHiddenPeople,
  listPeople,
  renamePerson,
  setPersonCover,
  unhidePerson,
  type PersonWithCount,
} from '../people/people.repo.ts';
import { mergePeopleInto } from '../people/people-merge.repo.ts';
import { child as childLogger } from '../log.ts';

const log = childLogger('people:routes');

const NameBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 200 }),
});

const ClusterBody = t.Optional(
  t.Object({
    similarity_threshold: t.Optional(t.Number()),
  }),
);

const AssignBody = t.Object({
  asset_id: t.String({ minLength: 1 }),
  face_index: t.Number(),
  person_id: t.Union([t.String(), t.Null()]),
});

const HideBody = t.Object({
  asset_id: t.String({ minLength: 1 }),
  face_index: t.Number(),
});

const MergeBody = t.Object({
  target_id: t.String({ minLength: 1 }),
  source_ids: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});

const CoverBody = t.Object({
  asset_id: t.String({ minLength: 1 }),
  face_index: t.Number(),
});

function safeObjectId(raw: string): ObjectId | null {
  if (!raw || raw.length !== 24 || !/^[0-9a-f]{24}$/i.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

/** Wire shape for one row of the people list (and the Hidden list). Kept as
 * one mapper so `GET /people` and `GET /people/hidden` return byte-identical
 * shapes — the web reuses `ApiPerson` for both. */
function toPersonListRow(r: PersonWithCount) {
  return {
    id: r.person._id.toHexString(),
    name: r.person.name,
    face_count: r.faceCount,
    cover_asset_id: r.person.cover_asset_id ?? null,
    // Surfaced so the web can request the cover via /api/fs/thumb (the
    // same URL the browse view uses) and reuse its blob-URL + HTTP cache.
    cover_abs_path: r.coverAbsPath,
    // Bbox of the cover face, in normalised [0,1] — the web applies the
    // same `faceCropTransform` it uses for detail-panel face thumbs so
    // the list cards show the person's face, not the whole asset. Null
    // for manually-created people who have no faces yet (or pre-backfill
    // rows on a stale install — backfill heals on the next list call).
    cover_bbox: r.person.cover_bbox ?? null,
    created_at: r.person.created_at,
    updated_at: r.person.updated_at,
  };
}

export const peopleRoutes = new Elysia({ prefix: '/api/people' })
  // ── List ────────────────────────────────────────────────────────────
  .get('/', async () => {
    // Opportunistic heal: installs clustered before cover_asset_id shipped
    // still have null covers on every person doc. backfillCoverAssets is
    // idempotent and fast on a healthy DB (one find that returns 0 rows).
    // Errors are logged but don't fail the listing.
    try {
      await backfillCoverAssets();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cover backfill failed; serving list anyway',
      );
    }
    const rows = await listPeople({ withCounts: true });
    return rows.map(toPersonListRow);
  })

  // ── Hidden (soft-hidden people; the Hidden page) ────────────────────
  // Registered BEFORE `/:id` so "hidden" isn't swallowed as a person id.
  // Same wire shape as `GET /` so the web reuses `ApiPerson`.
  .get('/hidden', async () => {
    try {
      await backfillCoverAssets();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'cover backfill failed; serving hidden list anyway',
      );
    }
    const rows = await listHiddenPeople({ withCounts: true });
    return rows.map(toPersonListRow);
  })

  // ── Single ──────────────────────────────────────────────────────────
  // Supports ?offset=N&limit=N for the infinite-scroll detail face grid.
  // A page with fewer than `limit` faces signals end-of-list to the client.
  .get(
    '/:id',
    async ({ params, query, set }) => {
      const id = safeObjectId(params.id);
      if (!id) {
        set.status = 400;
        return { error: 'invalid person id' };
      }
      const offset = Math.max(0, Number(query.offset ?? 0) || 0);
      const limit = Math.min(
        200,
        Math.max(1, Number(query.limit ?? FACE_DETAIL_LIMIT) || FACE_DETAIL_LIMIT),
      );
      const detail = await getPerson(id, offset, limit);
      if (!detail) {
        set.status = 404;
        return { error: 'person not found' };
      }
      return {
        id: detail.person._id.toHexString(),
        name: detail.person.name,
        created_at: detail.person.created_at,
        updated_at: detail.person.updated_at,
        cover_asset_id: detail.person.cover_asset_id ?? null,
        cover_bbox: detail.person.cover_bbox ?? null,
        faces: detail.faces.map((f) => ({
          asset_id: f.asset_id,
          face_index: f.face_index,
          abs_path: f.abs_path,
          bbox: f.bbox,
          confidence: f.confidence,
        })),
        /** Echoed back so the client can accumulate pages without tracking offset state. */
        offset,
        limit,
      };
    },
    {
      query: t.Object({
        offset: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  // ── Create (or dedupe) ──────────────────────────────────────────────
  .post(
    '/',
    async ({ body, set }) => {
      const name = body.name.trim();
      if (name.length === 0) {
        set.status = 400;
        return { error: 'name must not be empty' };
      }
      const person = await createPerson(name);
      return {
        id: person._id.toHexString(),
        name: person.name,
        created_at: person.created_at,
        updated_at: person.updated_at,
      };
    },
    { body: NameBody },
  )

  // ── Rename (merge on collision) ─────────────────────────────────────
  .put(
    '/:id',
    async ({ params, body, set }) => {
      const id = safeObjectId(params.id);
      if (!id) {
        set.status = 400;
        return { error: 'invalid person id' };
      }
      const name = body.name.trim();
      if (name.length === 0) {
        set.status = 400;
        return { error: 'name must not be empty' };
      }
      try {
        const result = await renamePerson(id, name);
        return {
          id: result.survivor._id.toHexString(),
          name: result.survivor.name,
          merged_from: result.mergedFrom?.toHexString() ?? null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('person not found') || msg.startsWith('person already merged')) {
          set.status = 404;
          return { error: msg };
        }
        log.error({ err: msg }, 'rename failed');
        set.status = 500;
        return { error: msg };
      }
    },
    { body: NameBody },
  )

  // ── Explicit merge: fold source people INTO a target (target survives) ──
  // Unlike rename-on-collision, the chosen target is always the survivor — it
  // keeps its id, cover, and created_at. Backs the list bulk-merge toolbar and
  // the detail "Merge into…" button.
  .post(
    '/merge',
    async ({ body, set }) => {
      const targetId = safeObjectId(body.target_id);
      if (!targetId) {
        set.status = 400;
        return { error: 'invalid target_id' };
      }
      // Parse + de-dupe source ids; drop invalid ones and the target itself.
      const seen = new Set<string>();
      const sourceIds: ObjectId[] = [];
      for (const raw of body.source_ids) {
        const oid = safeObjectId(raw);
        if (!oid) continue;
        const hex = oid.toHexString();
        if (hex === targetId.toHexString() || seen.has(hex)) continue;
        seen.add(hex);
        sourceIds.push(oid);
      }
      if (sourceIds.length === 0) {
        set.status = 400;
        return { error: 'no valid source_ids to merge' };
      }
      try {
        const result = await mergePeopleInto(targetId, sourceIds);
        return {
          id: result.survivor._id.toHexString(),
          name: result.survivor.name,
          merged_count: result.mergedCount,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith('person not found') || msg.startsWith('person already merged')) {
          set.status = 404;
          return { error: msg };
        }
        log.error({ err: msg }, 'merge failed');
        set.status = 500;
        return { error: msg };
      }
    },
    { body: MergeBody },
  )

  // ── Soft-hide a person (keeps faces + row; stays a clustering seed) ──
  .post('/:id/hide', async ({ params, set }) => {
    const id = safeObjectId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'invalid person id' };
    }
    await hidePerson(id);
    return { ok: true };
  })

  // ── Restore a hidden person ─────────────────────────────────────────
  .post('/:id/unhide', async ({ params, set }) => {
    const id = safeObjectId(params.id);
    if (!id) {
      set.status = 400;
      return { error: 'invalid person id' };
    }
    await unhidePerson(id);
    return { ok: true };
  })

  // ── Set a face as the person's cover ────────────────────────────────
  // body { asset_id, face_index } — bbox is read SERVER-SIDE from the
  // asset doc; the client never supplies coordinates. Validates that the
  // face belongs to this person and is not hidden.
  .post(
    '/:id/cover',
    async ({ params, body, set }) => {
      const id = safeObjectId(params.id);
      if (!id) {
        set.status = 400;
        return { error: 'invalid person id' };
      }
      const assetId = safeObjectId(body.asset_id);
      if (!assetId) {
        set.status = 400;
        return { error: 'invalid asset_id' };
      }
      const result = await setPersonCover(id, assetId, body.face_index);
      if ('error' in result) {
        set.status = result.status;
        return { error: result.error };
      }
      return { ok: true };
    },
    { body: CoverBody },
  )

  // ── Online clustering ───────────────────────────────────────────────
  .post(
    '/cluster',
    async ({ body }) => {
      const opts: { similarityThreshold?: number } = {};
      if (body && typeof body.similarity_threshold === 'number') {
        opts.similarityThreshold = body.similarity_threshold;
      }
      // Route the manual click through the shared single-flight coordinator so
      // an operator "Run clustering" and a face-embed auto-trigger can never
      // run two passes concurrently (both walk the whole faces space).
      const result = await clusterCoordinator().runClusterNow(opts);
      return {
        assigned: result.assigned,
        new_people: result.newPeople,
        scanned: result.scanned,
      };
    },
    { body: ClusterBody },
  )

  // ── Manual assign / unassign ────────────────────────────────────────
  .post(
    '/assign',
    async ({ body, set }) => {
      const assetId = safeObjectId(body.asset_id);
      if (!assetId) {
        set.status = 400;
        return { error: 'invalid asset_id' };
      }
      const personId = body.person_id ? safeObjectId(body.person_id) : null;
      if (body.person_id && !personId) {
        set.status = 400;
        return { error: 'invalid person_id' };
      }
      try {
        await assignFaceToPerson(assetId, body.face_index, personId);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set.status = msg.includes('not found') ? 404 : 400;
        return { error: msg };
      }
    },
    { body: AssignBody },
  )

  // ── Hide a face (operator "this isn't a face I want tracked") ───────
  .post(
    '/hide',
    async ({ body, set }) => {
      const assetId = safeObjectId(body.asset_id);
      if (!assetId) {
        set.status = 400;
        return { error: 'invalid asset_id' };
      }
      try {
        await hideFace(assetId, body.face_index);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set.status = msg.includes('not found') ? 404 : 400;
        return { error: msg };
      }
    },
    { body: HideBody },
  );
