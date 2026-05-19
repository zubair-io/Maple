import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import exifStage from "./exif.ts";
import { EXIF_PICK_TAGS } from "../../indexer/exif.ts";

function makeDoc(absPath: string) {
  return {
    _id: "000000000000000000000002" as unknown as import("mongodb").ObjectId,
    abs_path: absPath,
    sha1_head: "a".repeat(40), // pretend hash stage already ran
    maple_id: "b".repeat(32),
    stages: {
      hash:     { version: 1, attempts: 0, last_error: null, processed_at: new Date().toISOString(), dead: false },
      exif:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      thumb:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face:     { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode:  { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili:    { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe("exif handler", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "exif-stage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a patch with an exif key for a file without EXIF", async () => {
    // A raw JPEG with no metadata — exifr returns null; handler must still
    // return a patch (with exif: null) so the runtime can mark the stage done.
    const file = path.join(dir, "no-exif.jpg");
    const { default: sharp } = await import("sharp");
    const buf = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file);
    const result = await exifStage.handler(doc as never, {} as never);

    expect("patch" in result).toBe(true);
    const { patch } = result as { patch: Record<string, unknown> };
    // exif may be null (no EXIF data) — that is a valid and expected value.
    expect("exif" in patch).toBe(true);
  });

  it("patch.exif contains camera_make when a DNG fixture is present", async () => {
    const dng = path.resolve(process.cwd(), "../../test-fixtures/raws/test_0017.dng");
    try {
      await import("node:fs/promises").then((f) => f.stat(dng));
    } catch {
      return; // fixture absent — soft pass on CI
    }
    const doc = makeDoc(dng);
    const result = await exifStage.handler(doc as never, {} as never);
    const { patch } = result as { patch: Record<string, unknown> };
    const exif = patch.exif as Record<string, unknown> | null;
    expect(exif).not.toBeNull();
    expect(typeof exif?.camera_make).toBe("string");
  });

  it("throws when the file does not exist", async () => {
    const doc = makeDoc(path.join(dir, "ghost.jpg"));
    await expect(exifStage.handler(doc as never, {} as never)).rejects.toThrow();
  });

  // exifr's `pick` filter only reads listed tags. If GPSLatitudeRef /
  // GPSLongitudeRef are not picked, exifr's internal DMS-to-DD conversion
  // sees direction=undefined and never negates — every western/southern
  // coordinate comes out positive. Removing these from the pick list
  // silently breaks every photo south of the equator or west of Greenwich.
  it("picks GPS hemisphere refs so exifr applies coordinate sign", () => {
    expect(EXIF_PICK_TAGS).toContain("GPSLatitudeRef");
    expect(EXIF_PICK_TAGS).toContain("GPSLongitudeRef");
  });

  it("exif stage targetVersion is at least 2 (post-GPS-sign-fix)", () => {
    expect(exifStage.targetVersion).toBeGreaterThanOrEqual(2);
  });
});
