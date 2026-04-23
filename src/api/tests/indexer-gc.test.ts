/**
 * T7-gc: GC sweep must unlink .maple/{thumbs,previews}/*.jpg for assets
 * whose soft-delete retention window has elapsed.
 *
 * The sweep pipeline (list → hardDelete → unlink) is DB-coupled; here we
 * exercise the unlink half directly via `IndexerService.unlinkAssetCache`
 * since that is where the file-system contract lives. Behaviour exercised:
 *   - stale thumb + preview both present -> both unlinked
 *   - files already gone (ENOENT) -> swallowed, no throw
 *   - folder unreachable (parent missing) -> warn + skip, no throw
 */

import { describe, it, expect } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";

describe("GC sweep unlinks cached artefacts", () => {
  it("removes stale thumb + preview under .maple/ for a soft-deleted asset", async () => {
    const { IndexerService } = await import("../src/indexer/service.ts");
    const { cachePathFor } = await import("../src/fs/xmp.ts");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "maple-gc-"));
    const asset = path.join(root, "IMG_0001.dng");
    await fs.writeFile(asset, "dng-bytes");

    const thumb = cachePathFor(asset, "thumbs");
    const preview = cachePathFor(asset, "previews");
    await fs.mkdir(path.dirname(thumb), { recursive: true });
    await fs.mkdir(path.dirname(preview), { recursive: true });
    await fs.writeFile(thumb, "jpeg-bytes");
    await fs.writeFile(preview, "jpeg-bytes");

    // Sanity — files exist before the sweep.
    expect((await fs.stat(thumb)).isFile()).toBe(true);
    expect((await fs.stat(preview)).isFile()).toBe(true);

    const svc = new IndexerService();
    await svc.unlinkAssetCache("01deadbeef0000000000000000000000", asset);

    await expect(fs.stat(thumb)).rejects.toThrow();
    await expect(fs.stat(preview)).rejects.toThrow();

    await fs.rm(root, { recursive: true, force: true });
  });

  it("swallows ENOENT for already-unlinked files", async () => {
    const { IndexerService } = await import("../src/indexer/service.ts");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "maple-gc-"));
    const asset = path.join(root, "ghost.dng");
    // Note: no thumb/preview ever written. Parent folder does exist so the
    // reachability check passes.
    await fs.writeFile(asset, "placeholder");

    const svc = new IndexerService();
    // Must not throw — ENOENT is expected.
    await svc.unlinkAssetCache("01ghost00000000000000000000000000", asset);

    await fs.rm(root, { recursive: true, force: true });
  });

  it("skips (does not throw) when the asset's folder is unreachable", async () => {
    const { IndexerService } = await import("../src/indexer/service.ts");

    const missing = path.join(os.tmpdir(), "maple-gc-missing-" + Date.now(), "never");
    const svc = new IndexerService();
    // Parent does not exist; the sweep must log a warn and return cleanly.
    await svc.unlinkAssetCache(
      "01offline00000000000000000000000",
      path.join(missing, "x.dng")
    );
  });
});
