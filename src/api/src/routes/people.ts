/**
 * /api/people/* — face-cluster identity routes.
 *
 *   GET    /api/people                — list with face counts
 *   GET    /api/people/:id            — single person + recent face thumbnails
 *   POST   /api/people                — body { name } → create or return existing
 *   PUT    /api/people/:id            — body { name } → rename; merge on collision
 *   DELETE /api/people/:id            — re-points faces to null + removes the row
 *   POST   /api/people/cluster        — kicks off online clustering
 *   POST   /api/people/assign         — manual face → person override
 *
 * Mounted behind `requireAuth` in `src/api/src/index.ts`.
 */

import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  backfillCoverAssets,
  runOnlineClustering,
} from "../people/clustering-job.ts";
import {
  assignFaceToPerson,
  createPerson,
  deletePerson,
  getPerson,
  listPeople,
  renamePerson,
} from "../people/people.repo.ts";
import { child as childLogger } from "../log.ts";

const log = childLogger("people:routes");

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

function safeObjectId(raw: string): ObjectId | null {
  if (!raw || raw.length !== 24 || !/^[0-9a-f]{24}$/i.test(raw)) return null;
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

export const peopleRoutes = new Elysia({ prefix: "/api/people" })
  // ── List ────────────────────────────────────────────────────────────
  .get("/", async () => {
    // Opportunistic heal: installs clustered before cover_asset_id shipped
    // still have null covers on every person doc. backfillCoverAssets is
    // idempotent and fast on a healthy DB (one find that returns 0 rows).
    // Errors are logged but don't fail the listing.
    try {
      await backfillCoverAssets();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "cover backfill failed; serving list anyway",
      );
    }
    const rows = await listPeople({ withCounts: true });
    return rows.map((r) => ({
      id: r.person._id.toHexString(),
      name: r.person.name,
      face_count: r.faceCount,
      cover_asset_id: r.person.cover_asset_id ?? null,
      created_at: r.person.created_at,
      updated_at: r.person.updated_at,
    }));
  })

  // ── Single ──────────────────────────────────────────────────────────
  .get("/:id", async ({ params, set }) => {
    const id = safeObjectId(params.id);
    if (!id) {
      set.status = 400;
      return { error: "invalid person id" };
    }
    const detail = await getPerson(id);
    if (!detail) {
      set.status = 404;
      return { error: "person not found" };
    }
    return {
      id: detail.person._id.toHexString(),
      name: detail.person.name,
      created_at: detail.person.created_at,
      updated_at: detail.person.updated_at,
      cover_asset_id: detail.person.cover_asset_id ?? null,
      faces: detail.faces.map((f) => ({
        asset_id: f.asset_id,
        face_index: f.face_index,
        abs_path: f.abs_path,
        bbox: f.bbox,
        confidence: f.confidence,
      })),
    };
  })

  // ── Create (or dedupe) ──────────────────────────────────────────────
  .post(
    "/",
    async ({ body, set }) => {
      const name = body.name.trim();
      if (name.length === 0) {
        set.status = 400;
        return { error: "name must not be empty" };
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
    "/:id",
    async ({ params, body, set }) => {
      const id = safeObjectId(params.id);
      if (!id) {
        set.status = 400;
        return { error: "invalid person id" };
      }
      const name = body.name.trim();
      if (name.length === 0) {
        set.status = 400;
        return { error: "name must not be empty" };
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
        if (msg.startsWith("person not found") || msg.startsWith("person already merged")) {
          set.status = 404;
          return { error: msg };
        }
        log.error({ err: msg }, "rename failed");
        set.status = 500;
        return { error: msg };
      }
    },
    { body: NameBody },
  )

  // ── Soft delete (re-point faces, remove row) ────────────────────────
  .delete("/:id", async ({ params, set }) => {
    const id = safeObjectId(params.id);
    if (!id) {
      set.status = 400;
      return { error: "invalid person id" };
    }
    await deletePerson(id);
    set.status = 204;
    return null;
  })

  // ── Online clustering ───────────────────────────────────────────────
  .post(
    "/cluster",
    async ({ body }) => {
      const opts: { similarityThreshold?: number } = {};
      if (body && typeof body.similarity_threshold === "number") {
        opts.similarityThreshold = body.similarity_threshold;
      }
      const result = await runOnlineClustering(opts);
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
    "/assign",
    async ({ body, set }) => {
      const assetId = safeObjectId(body.asset_id);
      if (!assetId) {
        set.status = 400;
        return { error: "invalid asset_id" };
      }
      const personId = body.person_id ? safeObjectId(body.person_id) : null;
      if (body.person_id && !personId) {
        set.status = 400;
        return { error: "invalid person_id" };
      }
      try {
        await assignFaceToPerson(assetId, body.face_index, personId);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        set.status = msg.includes("not found") ? 404 : 400;
        return { error: msg };
      }
    },
    { body: AssignBody },
  );
