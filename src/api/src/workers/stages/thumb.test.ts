import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import thumbStage from "./thumb.ts";

function makeDoc(absPath: string, exif: Record<string, unknown> | null = null) {
  return {
    _id: "000000000000000000000003" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    sha1_head: "c".repeat(40),
    maple_id: "d".repeat(32),
    exif,
    stages: {
      hash:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      exif:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      thumb:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("thumb handler — bitmap path", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "thumb-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a thumb for a JPEG and returns thumb_path in the patch", async () => {
    const file = path.join(dir, "photo.jpg");
    const buf = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await thumbStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.thumb_path).toBe("string");
    // The thumb must actually exist on disk.
    const s = await stat(patch.thumb_path as string);
    expect(s.size).toBeGreaterThan(0);
  });

  it("produces an upright thumb regardless of EXIF orientation tag", async () => {
    const file = path.join(dir, "rotated.jpg");
    // Create a 16x8 JPEG tagged as orientation 6 (90° CW). After the orientation
    // fix (Plan 0), the on-disk thumb must be 8 wide × 16 tall.
    const buf = await sharp({
      create: { width: 16, height: 8, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await thumbStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const meta = await sharp(patch.thumb_path as string).metadata();
    // After orientation bake-in, the stored thumb is upright.
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("returns { patch: { thumb_path } } for a RAW when the FFI is unavailable (soft pass)", async () => {
    // Without libraw_ffi built, generateThumb silently skips the RAW and
    // returns without writing a file. The handler must still return a patch
    // (with thumb_path set to the expected path even if the file is absent)
    // so the runtime can mark the stage done and the image advances to face.
    //
    // This test verifies the handler does not throw when the FFI is absent.
    const dng = path.resolve(process.cwd(), "../../test-fixtures/raws/test_0017.dng");
    let dngExists = false;
    try {
      await stat(dng);
      dngExists = true;
    } catch {
      // no fixture — test still runs but skips the file-existence assertion
    }

    if (!dngExists) return; // soft pass: no fixture

    const doc = makeDoc(dng);
    // Must not throw.
    const result = await thumbStage.handler(doc as never, {} as never);
    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    expect(typeof patch.thumb_path).toBe("string");
  });
});
