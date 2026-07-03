/**
 * End-to-end tests for the relocateBackupScreenshot describe-stage hook.
 */
import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ObjectId } from "mongodb";
import { relocateBackupScreenshot } from "./refile-backups.ts";
import type { getDb as GetDbFn } from "../../db/client.ts";

async function connectOrSkip(
  label: string,
): Promise<Awaited<ReturnType<typeof GetDbFn>> | null> {
  try {
    const { getDb } = await import("../../db/client.ts");
    return await getDb();
  } catch {
    console.log(`MongoDB unreachable — skipping ${label}`);
    return null;
  }
}

describe("relocateBackupScreenshot (describe-stage hook)", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("files a backup screenshot the ingest heuristic missed into year/Screenshot", async () => {
    const db = await connectOrSkip("relocate e2e");
    if (!db) return;
    const { setLibraryRootsForTests } =
      await import("../../indexer/libraries.cache.ts");
    const assets = db.collection("assets");
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "refile-reloc-"));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const oldRel = "2024/03";
    await fs.mkdir(path.join(dir, ...oldRel.split("/")), { recursive: true });
    await fs.writeFile(path.join(dir, oldRel, "IMG_4523.PNG"), "pixels");

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: "refile-reloc-id",
      fileinfo: [
        {
          path: oldRel,
          filename: "IMG_4523.PNG",
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [
        { device_id: "dev", phasset_local_id: "ph", first_seen: new Date() },
      ],
      // Still false on disk — relocate trusts the caller's verdict, not this.
      is_screenshot: false,
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
      stages: { thumb: { version: 1 }, preview: { version: 1 } },
    } as never);

    try {
      expect(await relocateBackupScreenshot(_id)).toBe("moved");
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe("2024/Screenshot");
      expect(
        await fs.readFile(
          path.join(dir, "2024/Screenshot/IMG_4523.PNG"),
          "utf8",
        ),
      ).toBe("pixels");
    } finally {
      await assets.deleteOne({ _id });
      setLibraryRootsForTests(null);
    }
  });

  it("is not-applicable for a non-backup asset (no phasset_links)", async () => {
    const db = await connectOrSkip("relocate non-backup e2e");
    if (!db) return;
    const { setLibraryRootsForTests } =
      await import("../../indexer/libraries.cache.ts");
    const assets = db.collection("assets");
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "refile-reloc-nb-"));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const rel = "2024/03";
    await fs.mkdir(path.join(dir, ...rel.split("/")), { recursive: true });
    await fs.writeFile(path.join(dir, rel, "IMG_X.PNG"), "pixels");

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: "refile-reloc-nb-id",
      fileinfo: [
        {
          path: rel,
          filename: "IMG_X.PNG",
          library_id: libId,
          deleted_at: null,
        },
      ],
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
    } as never);

    try {
      expect(await relocateBackupScreenshot(_id)).toBe("not-applicable");
      const doc = (await assets.findOne({ _id })) as {
        fileinfo?: { path: string }[];
      } | null;
      expect(doc?.fileinfo?.[0].path).toBe(rel);
    } finally {
      await assets.deleteOne({ _id });
      setLibraryRootsForTests(null);
    }
  });

  it("is not-applicable when already filed under year/Screenshot", async () => {
    const db = await connectOrSkip("relocate already-filed e2e");
    if (!db) return;
    const { setLibraryRootsForTests } =
      await import("../../indexer/libraries.cache.ts");
    const assets = db.collection("assets");
    const libId = new ObjectId();

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "refile-reloc-af-"));
    setLibraryRootsForTests(new Map([[libId.toHexString(), dir]]));

    const _id = new ObjectId();
    await assets.insertOne({
      _id,
      maple_id: "refile-reloc-af-id",
      fileinfo: [
        {
          path: "2024/Screenshot",
          filename: "IMG_Y.PNG",
          library_id: libId,
          deleted_at: null,
        },
      ],
      phasset_links: [
        { device_id: "dev", phasset_local_id: "ph3", first_seen: new Date() },
      ],
      size: 6,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: "",
      indexed_at: new Date().toISOString(),
    } as never);

    try {
      expect(await relocateBackupScreenshot(_id)).toBe("not-applicable");
    } finally {
      await assets.deleteOne({ _id });
      setLibraryRootsForTests(null);
    }
  });
});
