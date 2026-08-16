/**
 * People repo tests — real Mongo, skip-pass when unreachable. Mirrors the
 * pattern in `enrichment-route.test.ts` but exercises the repo functions
 * directly (route tests live in `tests/people-route.test.ts`).
 *
 * The `mergePeopleInto` describe block lives in `people-merge.repo.test.ts`
 * (extracted to keep both files within the 600-LOC budget gate, #1303).
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { AssetDoc, PersonDoc } from '../db/schema.ts';
import { setupMongoHarness, makeEmbedding } from './people-repo.test-helpers.ts';

const TEST_DB = `maple_test_people_repo_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;

const h = setupMongoHarness(TEST_DB);

describe('people.repo — createPerson', () => {
  it('creates a person with a fresh name', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const p = await createPerson('Alice');
    expect(p.name).toBe('Alice');
    expect(p._id).toBeInstanceOf(ObjectId);
  });

  it('dedupes case-insensitively (returns the existing row)', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    const a = await createPerson('Bob');
    const b = await createPerson('BOB');
    const c = await createPerson('bob');
    expect(b._id.toHexString()).toBe(a._id.toHexString());
    expect(c._id.toHexString()).toBe(a._id.toHexString());
    const count = await h.db.collection<PersonDoc>('people').countDocuments({
      merged_into: null,
    });
    expect(count).toBe(1);
  });

  it('rejects empty name', async () => {
    if (!h.mongoReachable) return;
    const { createPerson } = await import('./people.repo.ts');
    await expect(createPerson('   ')).rejects.toThrow(/empty/);
  });
});

describe('people.repo — renamePerson', () => {
  it('renames a person to a new unique name', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, renamePerson } = await import('./people.repo.ts');
    const p = await createPerson('Carol');
    const result = await renamePerson(p._id, 'Caroline');
    expect(result.survivor.name).toBe('Caroline');
    expect(result.mergedFrom).toBeUndefined();
  });

  it('merges on collision: face person_ids are repointed at survivor', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, renamePerson, assignFaceToPerson } = await import('./people.repo.ts');
    const dave = await createPerson('Dave');
    const david = await createPerson('David');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 1),
      },
    ]);
    await assignFaceToPerson(asset, 0, david._id);
    // Rename Dave to "David" — collision with the existing David row.
    const result = await renamePerson(dave._id, 'David');
    expect(result.mergedFrom).toBeDefined();
    // Survivor is the older _id (lexicographic min).
    const expectedSurvivor = dave._id.toString() < david._id.toString() ? dave._id : david._id;
    expect(result.survivor._id.toHexString()).toBe(expectedSurvivor.toHexString());
    expect(result.survivor.name).toBe('David');
    // Face person_id was repointed to the survivor.
    const faceAsset = await h.db.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(faceAsset?.faces?.[0]?.person_id).toBe(result.survivor._id.toHexString());
    // Orphan is marked merged.
    const orphanId = result.mergedFrom!;
    const orphan = await h.db.collection<PersonDoc>('people').findOne({
      _id: orphanId,
    });
    expect(orphan?.merged_into?.toHexString()).toBe(result.survivor._id.toHexString());
  });

  it('idempotent rename to same name (case-insensitive)', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, renamePerson } = await import('./people.repo.ts');
    const p = await createPerson('Eve');
    const r = await renamePerson(p._id, 'EVE');
    expect(r.survivor.name).toBe('EVE');
    expect(r.mergedFrom).toBeUndefined();
  });
});

describe('people.repo — listPeople', () => {
  it('returns face counts via aggregation, excludes merged people', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, renamePerson, listPeople, assignFaceToPerson } =
      await import('./people.repo.ts');
    const a = await createPerson('Anna');
    const b = await createPerson('Beth');
    const c = await createPerson('Cara');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 2),
      },
      {
        bbox: { x: 11, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 3),
      },
      {
        bbox: { x: 22, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 4),
      },
    ]);
    await assignFaceToPerson(asset, 0, a._id);
    await assignFaceToPerson(asset, 1, a._id);
    await assignFaceToPerson(asset, 2, b._id);
    // Merge c into a.
    await renamePerson(c._id, 'Anna');
    const list = await listPeople({ withCounts: true });
    // Only live people show up.
    expect(list.map((r) => r.person.name).sort()).toEqual(['Anna', 'Beth']);
    const anna = list.find((r) => r.person.name === 'Anna');
    const beth = list.find((r) => r.person.name === 'Beth');
    expect(anna?.faceCount).toBe(2);
    expect(beth?.faceCount).toBe(1);
  });

  it('populates coverAbsPath from the cover_asset_id → assets.abs_path join', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, listPeople } = await import('./people.repo.ts');
    // Three people: one whose cover points at a real asset, one whose
    // cover points at a deleted asset (the doc was removed but the
    // people row still references it), one with no cover_asset_id at
    // all. The first should resolve, the other two stay null.
    const live = await createPerson('Live');
    const orphan = await createPerson('Orphan');
    await createPerson('NoCover');
    const liveAsset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 8),
      },
    ]);
    const liveAssetDoc = await h.db.collection<AssetDoc>('assets').findOne({ _id: liveAsset });
    // Compose the wire abs_path the way the route would: library root + filename.
    const primary = liveAssetDoc?.fileinfo?.[0];
    expect(primary).toBeDefined();
    const folderDoc = await h.db
      .collection<{ path: string }>('folders')
      .findOne({ _id: primary!.library_id });
    const livePath = `${folderDoc!.path}/${primary!.filename}`;
    expect(typeof livePath).toBe('string');
    // Set covers directly. Mixed-case hex on the orphan exercises the
    // safeObjectId normalisation in coverAbsPathByPerson.
    await h.db
      .collection<PersonDoc>('people')
      .updateOne({ _id: live._id }, { $set: { cover_asset_id: liveAsset.toHexString() } });
    await h.db
      .collection<PersonDoc>('people')
      .updateOne(
        { _id: orphan._id },
        { $set: { cover_asset_id: new ObjectId().toHexString().toUpperCase() } },
      );

    const list = await listPeople({ withCounts: false });
    const byName = new Map(list.map((r) => [r.person.name, r]));
    expect(byName.get('Live')?.coverAbsPath).toBe(livePath ?? null);
    expect(byName.get('Orphan')?.coverAbsPath).toBeNull();
    expect(byName.get('NoCover')?.coverAbsPath).toBeNull();
  });
});

describe('people.repo — assignFaceToPerson', () => {
  it('sets person_id; null unassigns', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Frank');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 5),
      },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    let row = await h.db.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBe(p._id.toHexString());
    await assignFaceToPerson(asset, 0, null);
    row = await h.db.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBeNull();
  });

  it('rejects out-of-range face index', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson } = await import('./people.repo.ts');
    const p = await createPerson('Grace');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 6),
      },
    ]);
    await expect(assignFaceToPerson(asset, 5, p._id)).rejects.toThrow(/range/);
  });
});

describe('people.repo — hidePerson / unhidePerson', () => {
  it('hidePerson sets hidden=true, keeps faces assigned, keeps the row', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, hidePerson } = await import('./people.repo.ts');
    const p = await createPerson('Henry');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 7),
      },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await h.db
      .collection<AssetDoc>('assets')
      .updateOne({ _id: asset }, { $set: { 'stages.meili.version': 7 } } as never);
    await hidePerson(p._id);
    // Faces stay assigned — soft-hide does NOT unassign.
    const row = await h.db.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.person_id).toBe(p._id.toHexString());
    // The row is still present, just flagged hidden.
    const stored = await h.db.collection<PersonDoc>('people').findOne({ _id: p._id });
    expect(stored).not.toBeNull();
    expect(stored?.hidden).toBe(true);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rearmed = (await h.db.collection<AssetDoc>('assets').findOne({ _id: asset })) as
        | (AssetDoc & { stages?: Record<string, { version?: number }> })
        | null;
      if (rearmed?.stages?.meili?.version === 0) break;
      await Bun.sleep(5);
    }
    const rearmed = (await h.db.collection<AssetDoc>('assets').findOne({ _id: asset })) as
      | (AssetDoc & { stages?: Record<string, { version?: number }> })
      | null;
    expect(rearmed?.stages?.meili?.version).toBe(0);
  });

  it('listPeople excludes hidden; listHiddenPeople returns them with counts', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, hidePerson, listPeople, listHiddenPeople } =
      await import('./people.repo.ts');
    const visible = await createPerson('Visible Vera');
    const hidden = await createPerson('Hidden Hugo');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 11, y: 0, w: 10, h: 10 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, visible._id);
    await assignFaceToPerson(asset, 1, hidden._id);
    await hidePerson(hidden._id);

    const normal = await listPeople({ withCounts: true });
    expect(normal.map((r) => r.person.name)).toEqual(['Visible Vera']);
    expect(normal[0].faceCount).toBe(1);

    const hiddenList = await listHiddenPeople({ withCounts: true });
    expect(hiddenList.map((r) => r.person.name)).toEqual(['Hidden Hugo']);
    // Hidden person keeps its assigned faces, so the count is preserved.
    expect(hiddenList[0].faceCount).toBe(1);
  });

  it('unhidePerson restores: returns to listPeople, drops off listHiddenPeople', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, hidePerson, unhidePerson, listPeople, listHiddenPeople } =
      await import('./people.repo.ts');
    const p = await createPerson('Iris');
    await hidePerson(p._id);
    expect((await listPeople()).map((r) => r.person.name)).toEqual([]);
    expect((await listHiddenPeople()).map((r) => r.person.name)).toEqual(['Iris']);
    await unhidePerson(p._id);
    expect((await listPeople()).map((r) => r.person.name)).toEqual(['Iris']);
    expect((await listHiddenPeople()).map((r) => r.person.name)).toEqual([]);
  });
});

describe('people.repo — hideFace', () => {
  it('sets hidden=true AND person_id=null in one write', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, hideFace } = await import('./people.repo.ts');
    const p = await createPerson('Ivan');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        person_id: null,
        confidence: 0.95,
        embedding: makeEmbedding(512, 10),
      },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await hideFace(asset, 0);
    const row = await h.db.collection<AssetDoc>('assets').findOne({ _id: asset });
    expect(row?.faces?.[0]?.hidden).toBe(true);
    expect(row?.faces?.[0]?.person_id).toBeNull();
  });

  it('rejects out-of-range face index', async () => {
    if (!h.mongoReachable) return;
    const { hideFace } = await import('./people.repo.ts');
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
        person_id: null,
        confidence: 0.5,
      },
    ]);
    await expect(hideFace(asset, 4)).rejects.toThrow(/range/);
  });

  it('hidden faces drop out of getPerson and faceCountByPerson', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, hideFace, getPerson, listPeople } =
      await import('./people.repo.ts');
    const p = await createPerson('Jane');
    // Two faces — one stays assigned, one gets hidden.
    const asset = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 0.2, h: 0.2 },
        person_id: null,
        confidence: 0.9,
        embedding: makeEmbedding(512, 11),
      },
      {
        bbox: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
        person_id: null,
        confidence: 0.8,
        embedding: makeEmbedding(512, 12),
      },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await assignFaceToPerson(asset, 1, p._id);
    // Sanity: both faces visible before hiding.
    const before = await getPerson(p._id);
    expect(before?.faces.length).toBe(2);
    const beforeList = await listPeople();
    expect(beforeList.find((r) => r.person.name === 'Jane')?.faceCount).toBe(2);
    // Hide face index 0.
    await hideFace(asset, 0);
    const after = await getPerson(p._id);
    expect(after?.faces.length).toBe(1);
    expect(after?.faces[0]?.bbox.x).toBeCloseTo(0.3);
    const afterList = await listPeople();
    expect(afterList.find((r) => r.person.name === 'Jane')?.faceCount).toBe(1);
  });
});

describe('people-search-reindex — markAssetsForMeiliReindex', () => {
  it('resets stages.meili.version to 0 on assets carrying a matching face', async () => {
    if (!h.mongoReachable) return;
    const { markAssetsForMeiliReindex } = await import('./people-search-reindex.ts');
    const personId = new ObjectId();
    const otherPersonId = new ObjectId();
    const matching = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: personId.toHexString(), confidence: 0.9 },
    ]);
    const unrelated = await h.insertAssetWithFaces([
      {
        bbox: { x: 0, y: 0, w: 0.2, h: 0.2 },
        person_id: otherPersonId.toHexString(),
        confidence: 0.9,
      },
    ]);
    // Mark both as already-indexed at v6 with dead-letter bookkeeping set.
    await h.db
      .collection('assets')
      .updateMany(
        { _id: { $in: [matching, unrelated] } },
        { $set: { 'stages.meili': { version: 6, dead: true, attempts: 3, last_error: 'x' } } },
      );

    const modified = await markAssetsForMeiliReindex([personId]);
    expect(modified).toBe(1);

    const m = await h.db.collection('assets').findOne({ _id: matching });
    const u = await h.db.collection('assets').findOne({ _id: unrelated });
    const ms = (m as { stages?: { meili?: Record<string, unknown> } }).stages?.meili ?? {};
    const us = (u as { stages?: { meili?: Record<string, unknown> } }).stages?.meili ?? {};
    // Matching asset is re-queued (version < targetVersion) with cleared
    // dead-letter state.
    expect(ms.version).toBe(0);
    expect(ms.dead).toBe(false);
    expect(ms.attempts).toBe(0);
    expect(ms.last_error).toBeNull();
    // Unrelated asset is untouched.
    expect(us.version).toBe(6);
  });

  it('is a no-op for an empty id list', async () => {
    if (!h.mongoReachable) return;
    const { markAssetsForMeiliReindex } = await import('./people-search-reindex.ts');
    expect(await markAssetsForMeiliReindex([])).toBe(0);
  });

  it('markAssetIdsForMeiliReindex resets only the targeted assets', async () => {
    if (!h.mongoReachable) return;
    const { markAssetIdsForMeiliReindex } = await import('./people-search-reindex.ts');
    const personId = new ObjectId();
    // Two assets carry the SAME person — the asset-targeted reset must touch
    // only the one we name, not the whole person's corpus.
    const target = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: personId.toHexString(), confidence: 0.9 },
    ]);
    const sibling = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: personId.toHexString(), confidence: 0.9 },
    ]);
    await h.db
      .collection('assets')
      .updateMany(
        { _id: { $in: [target, sibling] } },
        { $set: { 'stages.meili': { version: 6, dead: true, attempts: 3, last_error: 'x' } } },
      );

    const modified = await markAssetIdsForMeiliReindex([target]);
    expect(modified).toBe(1);

    const t = await h.db.collection('assets').findOne({ _id: target });
    const s = await h.db.collection('assets').findOne({ _id: sibling });
    const ts = (t as { stages?: { meili?: Record<string, unknown> } }).stages?.meili ?? {};
    const ss = (s as { stages?: { meili?: Record<string, unknown> } }).stages?.meili ?? {};
    expect(ts.version).toBe(0);
    expect(ts.dead).toBe(false);
    // The same person's other asset is left alone.
    expect(ss.version).toBe(6);
  });

  it('markAssetIdsForMeiliReindex is a no-op for an empty list', async () => {
    if (!h.mongoReachable) return;
    const { markAssetIdsForMeiliReindex } = await import('./people-search-reindex.ts');
    expect(await markAssetIdsForMeiliReindex([])).toBe(0);
  });

  it("renamePerson re-queues the renamed person's assets", async () => {
    if (!h.mongoReachable) return;
    const { createPerson, assignFaceToPerson, renamePerson } = await import('./people.repo.ts');
    const p = await createPerson('Rho');
    const asset = await h.insertAssetWithFaces([
      { bbox: { x: 0, y: 0, w: 0.2, h: 0.2 }, person_id: null, confidence: 0.9 },
    ]);
    await assignFaceToPerson(asset, 0, p._id);
    await h.db
      .collection('assets')
      .updateOne({ _id: asset }, { $set: { 'stages.meili.version': 6 } });
    await renamePerson(p._id, 'RhoRenamed');
    // The reindex is fire-and-forget; poll briefly for the reset to land.
    let version: unknown = 6;
    for (let i = 0; i < 20; i += 1) {
      const row = await h.db.collection('assets').findOne({ _id: asset });
      version = (row as { stages?: { meili?: { version?: unknown } } }).stages?.meili?.version;
      if (version === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(version).toBe(0);
  });
});

describe('getPerson — suggestedMerge', () => {
  it('resolves suggested_merge_person_id into display info', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Person S1');
    const target = await createPerson('Person T1');
    await peopleC.updateOne(
      { _id: target._id },
      { $set: { cover_asset_id: 'abc123', cover_bbox: { x: 0, y: 0, w: 1, h: 1 } } },
    );
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.87 } },
    );

    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge?.personId.toHexString()).toBe(target._id.toHexString());
    expect(detail?.suggestedMerge?.name).toBe('Person T1');
    expect(detail?.suggestedMerge?.coverAssetId).toBe('abc123');
    expect(detail?.suggestedMerge?.score).toBe(0.87);
  });

  it('returns null when no suggestion is set', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');

    const subject = await createPerson('Person S2');
    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge).toBeNull();
  });

  it('defensively returns null when the suggested target has since been merged away', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Person S3');
    const target = await createPerson('Person T3');
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne({ _id: target._id }, { $set: { merged_into: subject._id } });

    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge).toBeNull();
  });

  it('defensively returns null when the suggested target has since been hidden', async () => {
    if (!h.mongoReachable) return;
    const { createPerson, getPerson } = await import('./people.repo.ts');
    const { peopleCollection } = await import('../db/client.ts');
    const peopleC = await peopleCollection();

    const subject = await createPerson('Person S4');
    const target = await createPerson('Person T4');
    await peopleC.updateOne(
      { _id: subject._id },
      { $set: { suggested_merge_person_id: target._id, suggested_merge_score: 0.9 } },
    );
    await peopleC.updateOne({ _id: target._id }, { $set: { hidden: true } });

    const detail = await getPerson(subject._id);
    expect(detail?.suggestedMerge).toBeNull();
  });
});
