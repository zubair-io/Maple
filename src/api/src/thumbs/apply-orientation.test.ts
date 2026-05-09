import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { applyExifOrientationInPlace } from "./apply-orientation.ts";

// A 16x8 JPEG: portrait when the orientation tag asks for 90° CW (orientation=6),
// landscape on disk. After rotation, dimensions must swap to 8x16 and the tag
// must be stripped (sharp metadata returns undefined or 1).
async function makeOrientedJpeg(
  dir: string,
  orientation: number,
): Promise<string> {
  const file = path.join(dir, `oriented-${orientation}.jpg`);
  const buf = await sharp({
    create: { width: 16, height: 8, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation })
    .toBuffer();
  await writeFile(file, buf);
  return file;
}

describe("applyExifOrientationInPlace", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "orient-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rotates pixels and strips the tag for orientation 6 (90° CW)", async () => {
    const file = await makeOrientedJpeg(dir, 6);
    const before = await sharp(file).metadata();
    expect(before.width).toBe(16);
    expect(before.height).toBe(8);
    expect(before.orientation).toBe(6);

    await applyExifOrientationInPlace(file);

    const after = await sharp(file).metadata();
    // After physical rotation, sharp reports the rotated dimensions.
    expect(after.width).toBe(8);
    expect(after.height).toBe(16);
    // After re-encoding with .rotate(), the orientation tag is gone (or 1).
    expect(after.orientation === undefined || after.orientation === 1).toBe(true);
  });

  it("is a no-op for orientation 1 (no rotation needed)", async () => {
    const file = await makeOrientedJpeg(dir, 1);
    const beforeBytes = await readFile(file);

    await applyExifOrientationInPlace(file);

    // Byte-identical: the helper must not re-encode when orientation is already 1.
    const afterBytes = await readFile(file);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  it("is a no-op when the orientation tag is missing", async () => {
    // Build a JPEG with no metadata at all.
    const file = path.join(dir, "no-meta.jpg");
    const buf = await sharp({
      create: { width: 16, height: 8, channels: 3, background: { r: 0, g: 100, b: 0 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    await writeFile(file, buf);
    const beforeBytes = await readFile(file);

    await applyExifOrientationInPlace(file);

    const afterBytes = await readFile(file);
    expect(afterBytes.equals(beforeBytes)).toBe(true);
  });

  it("handles orientation 8 (90° CCW)", async () => {
    const file = await makeOrientedJpeg(dir, 8);
    await applyExifOrientationInPlace(file);
    const after = await sharp(file).metadata();
    expect(after.width).toBe(8);
    expect(after.height).toBe(16);
  });
});
