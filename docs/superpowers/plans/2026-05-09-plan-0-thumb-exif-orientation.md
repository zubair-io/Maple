# Plan 0 — Thumb EXIF Orientation Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RAW-derived thumbnails physically upright by honoring the embedded preview JPEG's EXIF orientation tag. Today, RAW thumbs come straight out of the libraw FFI as JPEG bytes whose pixels carry the camera's original sensor orientation, while their EXIF orientation tag asks the viewer to rotate. The bitmap path already calls `sharp().rotate()` (`src/api/src/thumbs/render.ts:62`) and produces upright thumbs; the RAW path must match.

**Architecture:** Add a small `applyExifOrientationInPlace(jpegPath)` helper next to the existing thumb-rendering modules. It reads the JPEG's metadata, returns early if orientation is missing or `1` (no rotation needed), otherwise re-encodes via sharp's `.rotate()` (which physically rotates pixels and strips the tag) and atomically replaces the file. Wire it into both RAW callers — the indexer's `renderRawThumbToFile` and the live `/api/fs/thumb` route — so on-disk thumbs are byte-identical regardless of which subsystem produced them first. The `batch-jpeg-export` handler is intentionally untouched: it's an export pipeline, not a thumb cache, and its callers handle orientation downstream.

**Tech Stack:** Bun, TypeScript, sharp (libvips), bun:test.

**Spec:** [`docs/superpowers/specs/2026-05-09-stage-controllers-design.md`](../specs/2026-05-09-stage-controllers-design.md) — Architecture → Dependency graph (the `thumb → [hash, exif]` edge motivates this fix; lands as a standalone commit before the full redesign).

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/api/src/thumbs/apply-orientation.ts` | Create | Pure helper. Reads metadata, returns early on no-op orientations, otherwise rotates + atomically writes back. |
| `src/api/src/thumbs/apply-orientation.test.ts` | Create | Unit tests using synthetic JPEGs (sharp generates them with a chosen orientation tag). No fixture files needed. |
| `src/api/src/indexer/thumbnailer.ts` | Modify | After successful `renderRawThumbToFile`, call the helper on the written thumb. |
| `src/api/src/routes/fs-thumbs.ts` | Modify | After successful FFI write in the RAW branch, call the helper on the written thumb. |

Three files touched, one helper module created, no public API changes.

---

## Task 1: Create the orientation helper with a failing test

**Files:**
- Create: `src/api/src/thumbs/apply-orientation.test.ts`
- Create: `src/api/src/thumbs/apply-orientation.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/src/thumbs/apply-orientation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/api && bun test src/thumbs/apply-orientation.test.ts`

Expected: FAIL with a module-not-found error for `./apply-orientation.ts` (file does not exist yet).

- [ ] **Step 3: Implement the helper**

Create `src/api/src/thumbs/apply-orientation.ts`:

```ts
/**
 * In-place JPEG orientation normalization. Reads the EXIF orientation tag;
 * if missing or `1`, returns without touching the file. Otherwise re-encodes
 * via sharp's `.rotate()` — which physically rotates the pixels and strips
 * the orientation tag — then atomically replaces the file.
 *
 * Used after the libraw FFI extracts an embedded preview JPEG: the FFI
 * preserves the source's orientation tag rather than baking the rotation
 * into pixels, so without this step a portrait shot ends up sideways on
 * disk while the bitmap path (which routes through sharp's `.rotate()` at
 * decode time) renders upright. This helper closes that gap so both paths
 * produce byte-equivalent thumbs in `.maple/thumbs/`.
 */

import { rename, writeFile } from "node:fs/promises";
import sharp from "sharp";

export async function applyExifOrientationInPlace(
  jpegPath: string,
): Promise<void> {
  const meta = await sharp(jpegPath).metadata();
  if (!meta.orientation || meta.orientation === 1) return;

  const buf = await sharp(jpegPath)
    .rotate()
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  const tmp = `${jpegPath}.${process.pid}.rot.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, jpegPath);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/thumbs/apply-orientation.test.ts`

Expected: 4 tests pass — orientation 6 rotates, orientation 1 is byte-identical, missing-tag is byte-identical, orientation 8 rotates.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/thumbs/apply-orientation.ts src/api/src/thumbs/apply-orientation.test.ts
git commit -m "feat(api): applyExifOrientationInPlace helper for JPEG thumbs"
```

---

## Task 2: Wire the helper into the indexer's RAW thumb path

**Files:**
- Modify: `src/api/src/indexer/thumbnailer.ts`

The indexer's `renderRawThumbToFile` writes the FFI's embedded-preview output directly to the thumb cache path. Today its return value is propagated up to `generateThumb` which marks the thumb done. Insert the orientation step between those two — only on the success path, only after the file has been written.

- [ ] **Step 1: Add an indexer-level test**

Append to `src/api/src/thumbs/apply-orientation.test.ts` (same file — it's the only place this helper is called from a test):

```ts
import { generateThumb } from "../indexer/thumbnailer.ts";
import { ffiPool } from "../ffi/ffi-pool.ts";

describe("indexer thumbnailer + orientation", () => {
  // Skip when raw-ffi is unavailable (CI without libraw_ffi.dylib built).
  const pool = ffiPool();
  const maybe = pool.available() ? it : it.skip;

  maybe(
    "produces an upright thumb for an oriented RAW",
    async () => {
      // We don't ship a small RAW with non-default orientation as a fixture;
      // this test is gated on `test-fixtures/raws/test_0017.dng` (the existing
      // reference) but only asserts that the produced thumb has orientation=1
      // or absent — i.e. whatever the source orientation is, the on-disk thumb
      // is physically upright.
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cwd = process.cwd();
      const raw = path.resolve(cwd, "../../test-fixtures/raws/test_0017.dng");
      try {
        await fs.stat(raw);
      } catch {
        return; // fixture missing, soft pass
      }
      await generateThumb(raw);
      const thumbPath = path.join(
        path.dirname(raw),
        ".maple/thumbs",
        // resolveThumbPath uses sha256(absPath).slice(0,16) — recompute to assert.
      );
      // Easier: walk the .maple/thumbs dir and find the one .jpg we just made.
      const entries = await fs.readdir(path.join(path.dirname(raw), ".maple/thumbs"));
      const jpg = entries.find((e) => e.endsWith(".jpg"));
      expect(jpg).toBeDefined();
      const meta = await sharp(
        path.join(path.dirname(raw), ".maple/thumbs", jpg!),
      ).metadata();
      expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails (or skips on CI)**

Run: `cd src/api && bun test src/thumbs/apply-orientation.test.ts`

Expected: with the RAW fixture present, the new test FAILs because `meta.orientation` is non-1. Without fixtures (CI), it skip-passes.

- [ ] **Step 3: Wire the helper into `renderRawThumbToFile`**

Edit `src/api/src/indexer/thumbnailer.ts`. Add an import at the top with the other thumb imports:

```ts
import { applyExifOrientationInPlace } from "../thumbs/apply-orientation.ts";
```

Replace the body of `renderRawThumbToFile` (currently lines 122–147) with:

```ts
async function renderRawThumbToFile(
  rawPath: string,
  thumbPath: string,
): Promise<boolean> {
  const pool = ffiPool();
  if (!pool.available()) {
    log.warn(
      "raw-ffi not available — RAW thumb generation deferred. Build libraw_ffi.dylib with scripts/build-raw-ffi.sh.",
    );
    return false;
  }
  let ok = false;
  try {
    ok = await pool.renderThumbnailJpegToFile(
      rawPath,
      thumbPath,
      THUMB_LONG_EDGE_PX,
      82,
    );
  } catch (e) {
    log.warn(
      { rawPath, err: e instanceof Error ? e.message : e },
      "FFI call threw",
    );
    return false;
  }
  if (!ok) return false;
  try {
    await applyExifOrientationInPlace(thumbPath);
  } catch (e) {
    log.warn(
      { rawPath, err: e instanceof Error ? e.message : e },
      "orientation post-process failed; thumb left unrotated",
    );
    // The FFI output is still on disk — mark success rather than failing the stage.
  }
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/api && bun test src/thumbs/apply-orientation.test.ts`

Expected: with the RAW fixture present, all 5 tests pass. Without it, the indexer test skips and the other 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/indexer/thumbnailer.ts src/api/src/thumbs/apply-orientation.test.ts
git commit -m "fix(api): indexer RAW thumbs honor EXIF orientation"
```

---

## Task 3: Wire the helper into the live `/api/fs/thumb` route

The live thumb route writes to the same `.maple/thumbs/` cache. If it doesn't apply the same orientation step, the indexer and the live route will fight over the file: whichever runs first wins, and the other re-overwrites with a different orientation on the next request.

**Files:**
- Modify: `src/api/src/routes/fs-thumbs.ts`

- [ ] **Step 1: Add the import**

Edit `src/api/src/routes/fs-thumbs.ts`. Find the existing imports near the top of the file and add:

```ts
import { applyExifOrientationInPlace } from "../thumbs/apply-orientation.ts";
```

- [ ] **Step 2: Insert the orientation step in the RAW branch**

In `src/api/src/routes/fs-thumbs.ts`, locate the RAW branch (around lines 169–192). Replace this block:

```ts
      let ok = false;
      try {
        ok = await pool.renderThumbnailJpegToFile(real, thumbPath, sizePx, 82);
      } catch (err) {
        set.status = 500;
        return {
          error: `FFI worker error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!ok) {
        set.status = 500;
        return { error: "Thumbnail render failed (see server log)" };
      }
```

With:

```ts
      let ok = false;
      try {
        ok = await pool.renderThumbnailJpegToFile(real, thumbPath, sizePx, 82);
      } catch (err) {
        set.status = 500;
        return {
          error: `FFI worker error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!ok) {
        set.status = 500;
        return { error: "Thumbnail render failed (see server log)" };
      }
      try {
        await applyExifOrientationInPlace(thumbPath);
      } catch {
        // Non-fatal: the FFI output is still a valid JPEG, just possibly
        // un-rotated. Better to serve a sideways image than 500 the request.
      }
```

- [ ] **Step 3: Verify the existing fs-thumbs tests still pass**

Run: `cd src/api && bun test src/routes/fs-thumbs.test.ts`

Expected: existing test suite passes unchanged. Orientation is a behavior addition, not a contract change — no existing test should regress.

- [ ] **Step 4: Manually verify the route**

There is no existing `fs-thumbs.test.ts`; the helper-level coverage in Task 1 plus the indexer integration test in Task 2 exercise the same code path. To smoke-test the live route, with a RAW fixture present and the dev API running:

```bash
# Find the dev server port from src/api/src/index.ts (default 3000).
# Pick any RAW under your test library; URL-encode the absolute path.
RAW_PATH=$(realpath test-fixtures/raws/test_0017.dng | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip()))')
curl -s "http://localhost:3000/api/fs/thumb?path=$RAW_PATH&size=512" -o /tmp/thumb.jpg
# Inspect the response orientation:
bun -e "import('sharp').then(async ({default: sharp}) => { const m = await sharp('/tmp/thumb.jpg').metadata(); console.log({ orientation: m.orientation, width: m.width, height: m.height }); })"
```

Expected: `orientation` is `undefined` or `1`, and width/height match the upright aspect ratio of the source.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/fs-thumbs.ts
git commit -m "fix(api): /api/fs/thumb RAW path honors EXIF orientation"
```

---

## Self-review checklist for the executor

Before declaring this plan complete:

- [ ] All four bitmap tests pass: orientation 6 rotates, orientation 1 byte-identical, no-tag byte-identical, orientation 8 rotates.
- [ ] `cd src/api && bun test` shows no regressions in `src/indexer/`, `src/routes/fs-thumbs.test.ts`, or `src/thumbs/`.
- [ ] Manually verified on a real RAW with non-default orientation (if a fixture is available locally): open the produced thumb in Preview and confirm it's upright.
- [ ] No new lint warnings: `cd src/api && bun run lint` (if configured).
- [ ] Three commits land in order: helper → indexer wire-up → route wire-up. Each commit's tests pass independently — bisecting any one of them yields a working tree.
