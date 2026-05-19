import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import previewStage from "./preview.ts";
import { PREVIEW_LONG_EDGE_PX, PREVIEW_SIZE_KEY } from "../../indexer/previewer.ts";

function makeDoc(absPath: string) {
  return {
    _id: "000000000000000000000004" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    sha1_head: "c".repeat(40),
    maple_id: "d".repeat(32),
    exif: null,
    stages: {
      hash:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      exif:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      thumb:    { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      preview:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      ocr:      { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("preview handler — bitmap path", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "preview-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a 1280-px preview for a 2000-px JPEG and returns preview_path", async () => {
    const file = path.join(dir, "wide.jpg");
    const buf = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await previewStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.preview_path).toBe("string");
    expect((patch.preview_path as string).endsWith(`_${PREVIEW_SIZE_KEY}.jpg`)).toBe(true);

    // The file must exist and be downscaled to 1280-px long edge.
    const s = await stat(patch.preview_path as string);
    expect(s.size).toBeGreaterThan(0);
    const meta = await sharp(patch.preview_path as string).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(PREVIEW_LONG_EDGE_PX);
  });

  it("does not enlarge a smaller source — a 600-px JPEG stays at 600", async () => {
    const file = path.join(dir, "small.jpg");
    const buf = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 50, g: 80, b: 100 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await previewStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const meta = await sharp(patch.preview_path as string).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it("bakes in EXIF orientation so the preview is upright", async () => {
    const file = path.join(dir, "rotated.jpg");
    const buf = await sharp({
      create: { width: 1600, height: 800, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 }) // 90° CW
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await previewStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const meta = await sharp(patch.preview_path as string).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("reuses a cached preview when its mtime is >= the source's", async () => {
    const file = path.join(dir, "cached.jpg");
    const buf = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const first = await previewStage.handler(doc as never, {} as never);
    const { patch: p1 } = first as { patch: Record<string, unknown> };
    const previewPath = p1.preview_path as string;
    const stat1 = await stat(previewPath);

    // Touch the source to a time BEFORE the preview, then re-run. The stale-
    // check should reuse the existing preview file unchanged.
    const past = new Date(stat1.mtimeMs - 60_000);
    await utimes(file, past, past);

    await previewStage.handler(doc as never, {} as never);
    const stat2 = await stat(previewPath);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("returns { patch: { preview_path } } for a RAW when the FFI is unavailable (soft pass)", async () => {
    // Mirrors the thumb stage test: the handler must never throw when the
    // FFI dylib is absent; downstream stages skip via ENOENT.
    const dng = path.resolve(process.cwd(), "../../test-fixtures/raws/test_0017.dng");
    let dngExists = false;
    try {
      await stat(dng);
      dngExists = true;
    } catch {
      // no fixture — test still runs but skips the file-existence assertion
    }
    if (!dngExists) return;

    const doc = makeDoc(dng);
    const result = await previewStage.handler(doc as never, {} as never);
    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.preview_path).toBe("string");
  });
});
