/**
 * Pure-path-math tests for the cache-path resolvers in `xmp.ts`. No Mongo, no
 * filesystem. Thumbs stay content-addressed (`library_root, fileinfo[0].path,
 * maple_id`); previews are path-keyed instead (`library_root,
 * fileinfo[0].path, fileinfo[0].filename, suffix`) — see `cachePathForAsset`'s
 * doc for why.
 *
 * The skip-when-Mongo-unreachable pattern from `libraries.cache.test.ts` is
 * not needed here.
 */
import { describe, test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import * as path from "node:path";
import {
  resolveThumbPathForAsset,
  cachePathForAsset,
  xmpSidecarPath,
} from "./xmp.ts";

const LIB_ID = new ObjectId("1234567890abcdef12345678");
const LIB_ROOT = "/srv/library";
const MAPLE_ID = "a".repeat(32);

function libs(): ReadonlyMap<string, string> {
  return new Map([[LIB_ID.toHexString(), LIB_ROOT]]);
}

function makeAsset(opts: {
  /** Pass `null` to omit maple_id explicitly; default is MAPLE_ID. */
  maple_id?: string | null;
  fileinfoPath?: string;
  filename?: string;
  library_id?: ObjectId;
  noFileinfo?: boolean;
}): {
  maple_id?: string;
  fileinfo?: { path: string; filename: string; library_id: ObjectId }[];
} {
  const mid = opts.maple_id === null ? undefined : (opts.maple_id ?? MAPLE_ID);
  const base: { maple_id?: string } =
    mid !== undefined ? { maple_id: mid } : {};
  if (opts.noFileinfo) return base;
  return {
    ...base,
    fileinfo: [
      {
        path: opts.fileinfoPath ?? "vacation/2024",
        filename: opts.filename ?? "IMG_001.dng",
        library_id: opts.library_id ?? LIB_ID,
      },
    ],
  };
}

describe("xmpSidecarPath", () => {
  test("RAW/image uses stem-swap: IMG_1.ARW → IMG_1.xmp", () => {
    expect(xmpSidecarPath("/photos/IMG_1.ARW")).toBe("/photos/IMG_1.xmp");
    expect(xmpSidecarPath("/photos/clip.heic")).toBe("/photos/clip.xmp");
    expect(xmpSidecarPath("/photos/clip.jpg")).toBe("/photos/clip.xmp");
  });

  test("video keeps its extension (full-name): clip.mov → clip.mov.xmp (M5 — #1635)", () => {
    expect(xmpSidecarPath("/photos/clip.mov")).toBe("/photos/clip.mov.xmp");
    expect(xmpSidecarPath("/photos/clip.mp4")).toBe("/photos/clip.mp4.xmp");
  });

  test("video extension match is case-insensitive: IMG_1234.MOV → IMG_1234.MOV.xmp", () => {
    expect(xmpSidecarPath("/photos/IMG_1234.MOV")).toBe(
      "/photos/IMG_1234.MOV.xmp",
    );
  });

  test("Live Photo: same-stem still + clip resolve to DIFFERENT sidecars", () => {
    const still = xmpSidecarPath("/photos/IMG_1234.HEIC");
    const clip = xmpSidecarPath("/photos/IMG_1234.MOV");
    expect(still).toBe("/photos/IMG_1234.xmp");
    expect(clip).toBe("/photos/IMG_1234.MOV.xmp");
    expect(still).not.toBe(clip); // no clobber
  });
});

describe("resolveThumbPathForAsset", () => {
  test("composes <lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.avif", () => {
    const result = resolveThumbPathForAsset(makeAsset({}), libs());
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        "vacation",
        "2024",
        ".maple",
        "thumbs",
        `${MAPLE_ID}.avif`,
      ),
    );
  });

  test('fileinfo[0].path === "" → <lib>/.maple/thumbs/<maple_id>.avif (file at library root)', () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ fileinfoPath: "" }),
      libs(),
    );
    expect(result).toBe(
      path.join(LIB_ROOT, ".maple", "thumbs", `${MAPLE_ID}.avif`),
    );
  });

  test('POSIX path split: "a/b/c" → segments joined via path.join (never raw "/" in result)', () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ fileinfoPath: "a/b/c" }),
      libs(),
    );
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        "a",
        "b",
        "c",
        ".maple",
        "thumbs",
        `${MAPLE_ID}.avif`,
      ),
    );
  });

  test("returns null when maple_id is missing", () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ maple_id: null }),
      libs(),
    );
    expect(result).toBeNull();
  });

  test("returns null when library_id is not in the libraries map", () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ library_id: new ObjectId("ffffffffffffffffffffffff") }),
      libs(),
    );
    expect(result).toBeNull();
  });

  test("returns null when fileinfo is empty or absent", () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ noFileinfo: true }),
      libs(),
    );
    expect(result).toBeNull();
    // Explicit empty-fileinfo case: `fileinfo[]` exists on the doc but is
    // an empty array (post-PR-6 invariant violation we still want to handle).
    // Typed via the same shape `makeAsset` returns so no cast is needed.
    const emptyFileinfo: {
      maple_id: string;
      fileinfo: { path: string; filename: string; library_id: ObjectId }[];
    } = { maple_id: MAPLE_ID, fileinfo: [] };
    const result2 = resolveThumbPathForAsset(emptyFileinfo, libs());
    expect(result2).toBeNull();
  });
});

describe("cachePathForAsset", () => {
  test("thumbs kind composes <lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.avif", () => {
    const result = cachePathForAsset(makeAsset({}), libs(), "thumbs");
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        "vacation",
        "2024",
        ".maple",
        "thumbs",
        `${MAPLE_ID}.avif`,
      ),
    );
  });

  test('previews with explicit suffix: kind="previews", suffix="1280.avif" → <filename>.1280.avif', () => {
    const result = cachePathForAsset(
      makeAsset({}),
      libs(),
      "previews",
      "1280.avif",
    );
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        "vacation",
        "2024",
        ".maple",
        "previews",
        "IMG_001.dng.1280.avif",
      ),
    );
  });

  test("previews without suffix arg → uses full.jpg suffix", () => {
    const result = cachePathForAsset(makeAsset({}), libs(), "previews");
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        "vacation",
        "2024",
        ".maple",
        "previews",
        "IMG_001.dng.full.jpg",
      ),
    );
  });

  test("previews at library root (empty fileinfo[0].path) → no extra segments", () => {
    const result = cachePathForAsset(
      makeAsset({ fileinfoPath: "" }),
      libs(),
      "previews",
      "1280.avif",
    );
    expect(result).toBe(
      path.join(LIB_ROOT, ".maple", "previews", "IMG_001.dng.1280.avif"),
    );
  });

  test("previews resolve without maple_id — path-keyed, not content-addressed", () => {
    const result = cachePathForAsset(
      makeAsset({ maple_id: null }),
      libs(),
      "previews",
      "1280.avif",
    );
    expect(result).toBe(
      path.join(
        LIB_ROOT,
        "vacation",
        "2024",
        ".maple",
        "previews",
        "IMG_001.dng.1280.avif",
      ),
    );
  });

  test("thumbs still return null when maple_id is missing (content-addressed)", () => {
    const result = cachePathForAsset(
      makeAsset({ maple_id: null }),
      libs(),
      "thumbs",
    );
    expect(result).toBeNull();
  });

  test("returns null when fileinfo is absent", () => {
    const result = cachePathForAsset(
      makeAsset({ noFileinfo: true }),
      libs(),
      "previews",
      "1280.avif",
    );
    expect(result).toBeNull();
  });

  test("returns null when library_id is not in the libraries map", () => {
    const result = cachePathForAsset(
      makeAsset({ library_id: new ObjectId("ffffffffffffffffffffffff") }),
      libs(),
      "previews",
      "1280.avif",
    );
    expect(result).toBeNull();
  });
});
