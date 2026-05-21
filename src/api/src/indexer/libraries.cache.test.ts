/**
 * Tests the process-wide library-roots cache used by every code path that
 * resolves `fileinfo[]` entries to an absolute on-disk location.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import {
  invalidateLibraryRoots,
  loadLibraryRoots,
} from "./libraries.cache.ts";
import { closeDb, foldersCollection } from "../db/client.ts";

beforeEach(async () => {
  const f = await foldersCollection();
  await f.deleteMany({});
  invalidateLibraryRoots();
});

afterAll(async () => {
  await closeDb();
});

describe("loadLibraryRoots", () => {
  test("returns a map keyed by hex _id", async () => {
    const f = await foldersCollection();
    const id = new ObjectId();
    await f.insertOne({
      _id: id,
      path: "/srv/lib-a",
      label: "A",
      last_scan: null,
      file_count: 0,
      created_at: "2026-05-20T00:00:00Z",
    });
    const roots = await loadLibraryRoots();
    expect(roots.get(id.toHexString())).toBe("/srv/lib-a");
  });

  test("returns the same map on a second call without refetching", async () => {
    const f = await foldersCollection();
    const id = new ObjectId();
    await f.insertOne({
      _id: id,
      path: "/x",
      label: "X",
      last_scan: null,
      file_count: 0,
      created_at: "now",
    });
    const first = await loadLibraryRoots();
    // Wipe behind the cache; the cached map should still be returned.
    await f.deleteMany({});
    const second = await loadLibraryRoots();
    expect(second).toBe(first);
    expect(second.size).toBe(1);
  });

  test("invalidate forces a re-read", async () => {
    const f = await foldersCollection();
    await f.insertOne({
      _id: new ObjectId(),
      path: "/x",
      label: "X",
      last_scan: null,
      file_count: 0,
      created_at: "now",
    });
    const first = await loadLibraryRoots();
    expect(first.size).toBe(1);
    invalidateLibraryRoots();
    await f.deleteMany({});
    const second = await loadLibraryRoots();
    expect(second.size).toBe(0);
  });
});
