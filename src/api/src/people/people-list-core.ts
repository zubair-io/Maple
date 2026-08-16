/**
 * Shared people-list query core — the one list body behind `listPeople`
 * (people.repo.ts) and the recovery lists (people-visibility.repo.ts).
 * Its own module so the visibility repo doesn't import people.repo.ts
 * (which re-exports the visibility API — that edge would be a cycle).
 */

import type { Filter, ObjectId, WithId } from 'mongodb';
import { safeObjectId } from '../db/safe-object-id.ts';
import { assetsCollection, peopleCollection } from '../db/client.ts';
import type { PersonDoc, PersonWithId } from '../db/schema.ts';
import { assetAbsPath, assetAddress } from '../indexer/images.repo.ts';
import { loadLibraryRoots, loadLibraryIdToSlug } from '../indexer/libraries.cache.ts';

/** Result of `listPeople({ withCounts: true })`. The face count is an
 * aggregation over `assets.faces` filtered by `person_id`.
 *
 * `coverAbsPath` is the absolute filesystem path of the cover asset, kept
 * for backward compat. `coverAddress` is the preferred `slug:relPath`
 * address — use this with `/api/thumb/:slug/*` for cache-coherent
 * thumbnail fetches. Null when the cover asset doc was deleted or never
 * resolved. */
export interface PersonWithCount {
  person: PersonWithId;
  faceCount: number;
  coverAbsPath: string | null;
  /** slug:relPath address of the cover asset. Null if the cover is missing
   * or the library has no slug (pre-M1 install). */
  coverAddress: string | null;
}

/** Options shared by the list endpoint. */
export interface ListPeopleOptions {
  /** When true, include a `faceCount` per person (one extra aggregation
   * pipeline). Default true — the `/api/people` UI always renders
   * counts. */
  withCounts?: boolean;
}

/** Shared list body — callers differ only in their person-level visibility
 * predicate; everything downstream (cover resolution, face counts, sort)
 * is identical. */
export async function listPeopleByFilter(
  filter: Filter<PersonDoc>,
  options: ListPeopleOptions = {},
): Promise<PersonWithCount[]> {
  const { withCounts = true } = options;
  const coll = await peopleCollection();
  const people = await coll
    .find(filter)
    .collation({ locale: 'en', strength: 2 })
    .sort({ name: 1 })
    .toArray();
  if (people.length === 0) return [];
  // One batched _id lookup gets every cover asset's abs_path. Indexed by
  // _id, so this is O(N) bytes returned, not O(N) round-trips.
  const coverInfos = await coverInfoByPerson(people);
  return people.map((p) => ({
    person: p as PersonWithId,
    // Read the denormalised face_count directly — O(1) per person, no
    // aggregation. Falls back to 0 when the migration hasn't run yet.
    faceCount: withCounts ? (p.face_count ?? 0) : 0,
    coverAbsPath: coverInfos.get(p._id.toHexString())?.absPath ?? null,
    coverAddress: coverInfos.get(p._id.toHexString())?.address ?? null,
  }));
}

interface CoverInfo {
  absPath: string | null;
  /** `slug:relPath` address, or null if the library has no slug (pre-M1). */
  address: string | null;
}

/** Batch-resolve `cover_asset_id` → cover info for a slice of people. One
 * `_id`-indexed `find({ _id: { $in: [...] } })` against `assets`; returns a
 * `personHex → CoverInfo` map. People whose `cover_asset_id` is null/missing
 * or whose asset doc was deleted simply don't appear in the map. */
async function coverInfoByPerson(people: WithId<PersonDoc>[]): Promise<Map<string, CoverInfo>> {
  const out = new Map<string, CoverInfo>();
  // Key by lowercase hex (`oid.toHexString()`) on both sides — Mongo
  // accepts mixed-case hex in `cover_asset_id` strings, but `_id`s round-
  // trip as lowercase. Normalising via `safeObjectId(...).toHexString()`
  // guarantees the keys match.
  const personByCover = new Map<string, string>();
  const coverObjectIds: ObjectId[] = [];
  for (const p of people) {
    const coverHex = p.cover_asset_id;
    if (!coverHex) continue;
    const oid = safeObjectId(coverHex);
    if (!oid) continue;
    coverObjectIds.push(oid);
    personByCover.set(oid.toHexString(), p._id.toHexString());
  }
  if (coverObjectIds.length === 0) return out;
  const assets = await assetsCollection();
  const cursor = assets.find({ _id: { $in: coverObjectIds } }, { projection: { fileinfo: 1 } });
  const libs = await loadLibraryRoots();
  const idToSlug = await loadLibraryIdToSlug();
  for await (const row of cursor) {
    const personHex = personByCover.get(row._id.toHexString());
    if (!personHex) continue;
    const absPath = assetAbsPath(row, libs);
    out.set(personHex, { absPath: absPath ?? null, address: assetAddress(row, idToSlug) });
  }
  return out;
}
