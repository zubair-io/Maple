import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

describe("GET /api/fs/dir", () => {
  let tmpRoot: string;
  let realTmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "maple-fsdir-"));
    realTmpRoot = await fs.realpath(tmpRoot);

    // Subdirectories at this level (one normal, two hidden)
    await fs.mkdir(path.join(tmpRoot, "Trip1"));
    await fs.mkdir(path.join(tmpRoot, "Trip2"));
    await fs.mkdir(path.join(tmpRoot, ".hidden"));
    await fs.mkdir(path.join(tmpRoot, ".maple"));

    // RAW image files (mixed case, mixed extensions)
    await fs.writeFile(path.join(tmpRoot, "IMG_001.CR3"), "raw");
    await fs.writeFile(path.join(tmpRoot, "IMG_002.cr2"), "raw");
    await fs.writeFile(path.join(tmpRoot, "IMG_003.NEF"), "raw");
    await fs.writeFile(path.join(tmpRoot, "IMG_004.dng"), "raw");

    // Bitmap image files (mixed case) — also surfaced by the listing.
    await fs.writeFile(path.join(tmpRoot, "preview.jpg"), "x");
    await fs.writeFile(path.join(tmpRoot, "shot.JPEG"), "x");
    await fs.writeFile(path.join(tmpRoot, "scan.PNG"), "x");
    await fs.writeFile(path.join(tmpRoot, "phone.heic"), "x");

    // Video file — surfaced in images with isVideo=true.
    await fs.writeFile(path.join(tmpRoot, "clip.mp4"), "x");
    // Non-image, non-video files (and dotfiles) that must be filtered out.
    await fs.writeFile(path.join(tmpRoot, "notes.txt"), "x");
    await fs.writeFile(path.join(tmpRoot, ".env"), "x");

    // Pin MAPLE_ROOTS to our tmp dir so the jail rejects everything else.
    process.env.MAPLE_ROOTS = realTmpRoot;
  });

  afterAll(async () => {
    delete process.env.MAPLE_ROOTS;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns subdirs and image files (RAW + bitmap) at the level", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(tmpRoot)}`,
      ),
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.path).toBe(realTmpRoot);
    expect(json.parent).toBe(path.dirname(realTmpRoot));

    const dirNames = json.dirs.map((d: any) => d.name).sort();
    expect(dirNames).toEqual(["Trip1", "Trip2"]);
    for (const d of json.dirs) {
      expect(typeof d.path).toBe("string");
      expect(typeof d.mtime).toBe("string");
      expect(d.path.startsWith(realTmpRoot)).toBe(true);
    }

    const imgNames = json.images.map((i: any) => i.name).sort();
    expect(imgNames).toEqual([
      "IMG_001.CR3",
      "IMG_002.cr2",
      "IMG_003.NEF",
      "IMG_004.dng",
      "clip.mp4",
      "phone.heic",
      "preview.jpg",
      "scan.PNG",
      "shot.JPEG",
    ]);
    const allowedExts = new Set([
      "cr3", "cr2", "nef", "dng", "jpg", "jpeg", "png", "heic", "mp4",
    ]);
    for (const img of json.images) {
      expect(typeof img.size).toBe("number");
      expect(img.size).toBeGreaterThan(0);
      expect(typeof img.mtime).toBe("string");
      expect(typeof img.ext).toBe("string");
      // ext is the lowercase form, regardless of filename case
      expect(img.ext).toBe(img.ext.toLowerCase());
      expect(allowedExts.has(img.ext)).toBe(true);
    }
    // Video entries carry isVideo=true; still images do not.
    const clipEntry = json.images.find((i: any) => i.name === "clip.mp4");
    expect(clipEntry?.isVideo).toBe(true);
    const photoEntry = json.images.find((i: any) => i.name === "IMG_004.dng");
    expect(photoEntry?.isVideo).toBeUndefined();
  });

  it("filters out non-selectable files (.txt) but surfaces videos (.mp4) in images", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(tmpRoot)}`,
      ),
    );
    const json = await res.json();
    const names = json.images.map((i: any) => i.name);
    // Plain text files stay out of images.
    expect(names).not.toContain("notes.txt");
    // Video files are now surfaced in images with isVideo=true.
    expect(names).toContain("clip.mp4");
    const clipEntry = json.images.find((i: any) => i.name === "clip.mp4");
    expect(clipEntry?.isVideo).toBe(true);
  });

  it("filters out dotfiles and dotdirs (including .maple/)", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(tmpRoot)}`,
      ),
    );
    const json = await res.json();
    const dirNames = json.dirs.map((d: any) => d.name);
    const imgNames = json.images.map((i: any) => i.name);
    expect(dirNames).not.toContain(".hidden");
    expect(dirNames).not.toContain(".maple");
    expect(imgNames).not.toContain(".env");
  });

  it("400s on a path outside MAPLE_ROOTS", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    // /etc is real (and outside MAPLE_ROOTS=tmpRoot), so realpath() succeeds
    // and the jail check fires.
    const res = await fsRoutes.handle(
      new Request("http://localhost/api/fs/dir?path=/etc"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/MAPLE_ROOTS/i);
  });

  it("400s on a non-existent path", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const missing = path.join(tmpRoot, "does-not-exist-xyz");
    const res = await fsRoutes.handle(
      new Request(
        `http://localhost/api/fs/dir?path=${encodeURIComponent(missing)}`,
      ),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/cannot access/i);
  });

  it("400s on a relative path (validation in handler)", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://localhost/api/fs/dir?path=relative/here"),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/absolute/i);
  });

  it("422s when path query param is missing", async () => {
    const { fsRoutes } = await import("../src/routes/fs.ts");
    const res = await fsRoutes.handle(
      new Request("http://localhost/api/fs/dir"),
    );
    expect(res.status).toBe(422);
  });
});
