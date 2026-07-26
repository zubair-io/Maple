# Videos Are Never Screenshots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce that no video asset is ever classified as a screenshot, at every write site, and repair the videos already flagged.

**Architecture:** A video check inside the shared `indexer/screenshot.ts` predicate fixes the EXIF stage, the sidecar-index native path, and the ingest route in one edit. The describe stage separately clamps the vision-model verdict before it reaches its three consumers. A new Mongo-only migration clears already-flagged videos and re-arms `describe` and `meili`.

**Tech Stack:** Bun + Elysia + MongoDB (`src/api`), `bun test`, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-26-video-not-screenshot-design.md`

**Ticket:** #2325 — every commit references it; the PR body must carry `Closes #2325`.

## Global Constraints

- All work is in `src/api`. Do not touch `src/apple`, `src/web`, or `src/raw-pipeline` — they are read-only consumers of this flag.
- The product invariant, verbatim: `is_screenshot` is a stills-only concept. No video is ever a screenshot, enforced at every write site.
- Video classification comes from `isVideoFilename` in `src/api/src/indexer/media-types.ts`. Never hand-roll an extension list; `VIDEO_EXTS` is the single source of truth.
- Test runner is `bun test` from `src/api`. Integration tests need a reachable MongoDB and must skip cleanly when there is none — follow the `tryConnect` pattern in `src/api/src/workers/migration/rearm-video-posters.test.ts`.
- The repo has no lint or format gate for `src/api`; the CI gate is `bun test`. `tsc` is not clean on this repo, so the bar is "no NEW tsc errors."
- Never `git add -A`. Stage explicit paths only, and check `git status` before each commit.
- Commit messages use the repo's Conventional Commits style (`fix(api):`, `feat(api):`, `test(api):`).

---

### Task 1: Video-aware screenshot predicate

This is the load-bearing task. `isLikelyScreenshot` delegates to `isScreenshotFilename`, so guarding the latter fixes the EXIF stage (`stages/exif.ts:118`), the sidecar-index native path (`stages/sidecar-metadata-index.ts:146`), and the ingest route (`routes/backup-ingest.ts:135`) together.

**Files:**

- Modify: `src/api/src/indexer/screenshot.ts`
- Create: `src/api/src/indexer/screenshot.test.ts`

**Interfaces:**

- Consumes: `isVideoFilename(filename: string): boolean` from `src/api/src/indexer/media-types.ts`.
- Produces: unchanged signatures — `isScreenshotFilename(filename: string): boolean` and `isLikelyScreenshot(filename: string, cameraMake: string | null | undefined): boolean`. Both now return `false` for any video container.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/indexer/screenshot.test.ts`:

```ts
/**
 * `is_screenshot` is a stills-only concept (#2325). A video container is
 * never a screenshot, however it is named.
 *
 * The camera-make guard in `isLikelyScreenshot` never protected video:
 * every video extension is in `NO_EXIF_EXTS`, so exifr returns no make and
 * the "conservative" branch is dead code for them. The extension test is
 * the real guard, which is why these cases pin it directly.
 */
import { describe, it, expect } from 'bun:test';
import { isScreenshotFilename, isLikelyScreenshot } from './screenshot.ts';

describe('screenshot detection — video containers', () => {
  it('rejects screenshot-named video containers', () => {
    expect(isScreenshotFilename('Screenshot_20240601_102030.mp4')).toBe(false);
    expect(isScreenshotFilename('Screenshot 2026-05-19 at 10.04.32.mov')).toBe(false);
    expect(isScreenshotFilename('Screen Shot 2024-12-01 at 1.23.45 PM.m4v')).toBe(false);
    expect(isScreenshotFilename('Screenshot_2024-06-01.webm')).toBe(false);
  });

  it('is case-insensitive on the extension', () => {
    expect(isScreenshotFilename('Screenshot_20240601.MP4')).toBe(false);
    expect(isScreenshotFilename('Screenshot_20240601.MOV')).toBe(false);
  });

  it('rejects video paths, not just bare filenames', () => {
    expect(isScreenshotFilename('/lib/2024/Screenshot/Screenshot 2024-06-01.mov')).toBe(false);
  });

  it('rejects video through isLikelyScreenshot for every camera_make shape', () => {
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', null)).toBe(false);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', '')).toBe(false);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', undefined)).toBe(false);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.mp4', 'Apple')).toBe(false);
  });
});

describe('screenshot detection — stills are unchanged', () => {
  it('still accepts screenshot-named stills', () => {
    expect(isScreenshotFilename('Screenshot 2026-05-19 at 10.04.32.png')).toBe(true);
    expect(isScreenshotFilename('Screen Shot 2024-12-01 at 1.23.45 PM.png')).toBe(true);
    expect(isLikelyScreenshot('Screenshot_20240601_102030.png', null)).toBe(true);
  });

  it('still rejects non-screenshot stills and mid-name matches', () => {
    expect(isScreenshotFilename('IMG_0042.JPG')).toBe(false);
    expect(isScreenshotFilename('my-screenshot-of-X.png')).toBe(false);
    expect(isLikelyScreenshot('Screenshot 2024-01-01.png', 'Apple')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/api`:

```bash
bun test src/indexer/screenshot.test.ts
```

Expected: FAIL. The "video containers" cases return `true` because nothing tests the extension yet. The "stills are unchanged" cases already pass.

- [ ] **Step 3: Write minimal implementation**

In `src/api/src/indexer/screenshot.ts`, add the import beneath the existing `node:path` import:

```ts
import { isVideoFilename } from './media-types.ts';
```

Replace the body of `isScreenshotFilename` with:

```ts
export function isScreenshotFilename(filename: string): boolean {
  // `is_screenshot` is a stills-only concept (#2325) — a screen recording is
  // a video and belongs in the video bucket, not the Screenshots one. This
  // guard, not the camera-make check in `isLikelyScreenshot`, is what
  // actually protects video: every video container is in `NO_EXIF_EXTS`, so
  // exifr never returns a make and that branch is dead code for them.
  if (isVideoFilename(filename)) return false;
  return SCREENSHOT_FILENAME_RE.test(path.basename(filename));
}
```

Then update the module docstring and the `isLikelyScreenshot` docstring so neither still claims the camera-make check is what keeps video out. In the module docstring, add a line to the list of what this module guarantees:

```
 * Videos are excluded outright: no video container is ever a screenshot,
 * whatever it is named, and whatever the VLM later thinks of its poster
 * frame (see `workers/stages/describe.ts`).
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/indexer/screenshot.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Verify the three downstream call sites still pass**

```bash
bun test src/workers/stages/exif.test.ts
```

Expected: PASS. The existing `isLikelyScreenshot — heuristic` block in that file uses only still extensions, so it is unaffected. If anything fails here, stop — it means a caller depended on the old video behaviour and the design needs revisiting.

- [ ] **Step 6: Commit**

```bash
git add src/api/src/indexer/screenshot.ts src/api/src/indexer/screenshot.test.ts
git commit -m "fix(api): never classify a video container as a screenshot

The camera-make guard never protected video — video extensions are in
NO_EXIF_EXTS, so exifr returns no make and the branch is dead code for
them. Guard on the extension instead, inside the shared predicate, which
fixes the exif stage, the sidecar-index native path, and the ingest route
together.

Refs #2325"
```

---

### Task 2: Clamp the vision-model verdict in the describe stage

The dominant path. Videos get an ffmpeg poster preview, so their frame reaches qwen2.5-vl, which returns `is_screenshot: true` for any UI-looking frame. The verdict has three consumers and all three need clamping — missing the `vision` subdoc would let `sidecar-metadata-index` read the flag back on the next re-index, and missing the relocation guard would keep moving video files into `<year>/Screenshot` on disk.

**Files:**

- Modify: `src/api/src/workers/stages/describe.ts`
- Test: `src/api/src/workers/stages/describe.test.ts`

**Interfaces:**

- Consumes: `isVideoFilename` from `src/api/src/indexer/media-types.ts`; `assetPrimaryFileInfo(image)` from `src/api/src/indexer/images.repo.ts`, already imported and already called into the local `primary` binding near the top of the handler.
- Produces: no signature change. `describeHandler` still returns `{ patch, invalidates: ['meili'] }`; the patch's `is_screenshot` and `patch.vision.is_screenshot` are both `false` for video regardless of the provider response.

- [ ] **Step 1: Write the failing test**

Append to `src/api/src/workers/stages/describe.test.ts`. Add these two imports to the existing import block at the top of the file:

```ts
import { spyOn } from 'bun:test';
import * as refileBackups from '../migration/refile-backups.ts';
```

If `spyOn` is already imported from `bun:test` in that file, extend the existing import rather than adding a second one.

Then append this block at the end of the file:

```ts
describe('describeHandler — video is never a screenshot (#2325)', () => {
  /** A video's poster frame reads as a UI to the VLM — a screen recording
   * does every time. The verdict must not reach any of its three consumers. */
  const SCREENSHOT_VISION = { ...VALID_VISION, is_screenshot: true };

  it('writes is_screenshot false for a video even when the model says true', async () => {
    const doc = await stageDoc(join(tmpRoot, 'clip.mov'));
    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: Record<string, unknown>;
    };

    expect(res.patch.is_screenshot).toBe(false);
  });

  it('also clamps the stored vision subdoc, so a sidecar re-index cannot resurrect it', async () => {
    const doc = await stageDoc(join(tmpRoot, 'clip.mov'));
    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: { vision: { is_screenshot: boolean; caption: string } };
    };

    expect(res.patch.vision.is_screenshot).toBe(false);
    // The rest of the VisionDoc is passed through untouched.
    expect(res.patch.vision.caption).toBe(VALID_VISION.caption);
  });

  it('never relocates a video into <year>/Screenshot on disk', async () => {
    const doc = await stageDoc(join(tmpRoot, 'clip.mov'));
    // The relocation is gated on backup origin, so give the doc a phasset
    // link — otherwise this test would pass for the wrong reason.
    (doc as unknown as { phasset_links: string[] }).phasset_links = ['SS/L0/001'];
    const relocate = spyOn(refileBackups, 'relocateBackupScreenshot');

    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    await describeHandler(doc, fakeCtx);

    expect(relocate).not.toHaveBeenCalled();
    relocate.mockRestore();
  });

  it('still honours a true verdict for a still image', async () => {
    const doc = await stageDoc(join(tmpRoot, 'shot.png'));
    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: { is_screenshot: boolean; vision: { is_screenshot: boolean } };
    };

    expect(res.patch.is_screenshot).toBe(true);
    expect(res.patch.vision.is_screenshot).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/workers/stages/describe.test.ts
```

Expected: the three video cases FAIL (`is_screenshot` is `true`, and the relocate spy was called). The still case already passes.

- [ ] **Step 3: Write minimal implementation**

In `src/api/src/workers/stages/describe.ts`, extend the existing `media-types.ts` import:

```ts
import { isUndecodableFilename, isVideoFilename } from '../../indexer/media-types.ts';
```

Immediately after the existing `stub-file` guard (the `const primary = assetPrimaryFileInfo(image);` block), add:

```ts
// `is_screenshot` is a stills-only concept (#2325). A video's poster frame
// can read as a UI to the VLM — a screen recording does every time — but a
// video is never a screenshot, so the verdict is clamped before it reaches
// any of its three consumers below.
const isVideo = !!primary && isVideoFilename(primary.filename);
```

After `const vision = parseVisionJson(result.text);`, add:

```ts
const isScreenshot = isVideo ? false : vision.is_screenshot;
```

Then make three edits in the code that follows. In the patch object, replace the `vision` entry and the `is_screenshot` mirror:

```ts
    // Structured vision subdoc — the new canonical source. The screenshot
    // verdict is clamped for video here too, not only on the top-level
    // mirror: `sidecar-metadata-index` reads `vision.is_screenshot` back as
    // its first source of truth, so leaving it true would let the flag
    // reappear on the next sidecar re-index.
    vision: { ...vision, is_screenshot: isScreenshot },
```

```ts
    // Top-level mirror of the VLM's screenshot verdict, overwriting any
    // exif-stage heuristic. The describe stage has more signal than
    // filename + missing camera_make (it sees cropped screenshots and
    // photos-of-screens correctly), so its verdict wins — except for video,
    // which is never a screenshot whatever the model saw in the poster.
    is_screenshot: isScreenshot,
```

And change the relocation guard from `vision.is_screenshot` to the clamped value:

```ts
  if (isScreenshot && (image.phasset_links?.length ?? 0) > 0) {
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/workers/stages/describe.test.ts
```

Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/stages/describe.ts src/api/src/workers/stages/describe.test.ts
git commit -m "fix(api): clamp the vision screenshot verdict for video

Videos reach qwen2.5-vl through their ffmpeg poster frame, and the model
returns is_screenshot true for anything that looks like a UI. Clamp the
verdict at all three consumers: the top-level mirror, the stored vision
subdoc (which sidecar-metadata-index reads back), and the on-disk
relocation into <year>/Screenshot.

Refs #2325"
```

---

### Task 3: Clamp the projected flag in the sidecar-metadata-index stage

A user can set `papp:IsScreenshot` on any asset and the override wins over the computed value. The sidecar keeps whatever the user wrote — XMP is the contract and passthrough preserves unknown and user-authored fields — but the projected top-level field that search and the Photos/Screenshots filter read is clamped.

**Files:**

- Modify: `src/api/src/workers/stages/sidecar-metadata-index.ts`
- Test: `src/api/src/workers/stages/sidecar-metadata-index.test.ts`

**Interfaces:**

- Consumes: `isVideoFilename` from `src/api/src/indexer/media-types.ts`; `isLikelyScreenshot` from `src/api/src/indexer/screenshot.ts` (already imported).
- Produces: no signature change. The stage's patch key `is_screenshot` is `false` for any video asset regardless of override or stored vision verdict.

- [ ] **Step 1: Write the failing test**

Append to `src/api/src/workers/stages/sidecar-metadata-index.test.ts`. Match the fixture and invocation style already used in that file — read the existing cases first and reuse its document builder and stage-invocation helper rather than inventing new ones. The three behaviours to pin:

```ts
describe('sidecar-metadata-index — video is never a screenshot (#2325)', () => {
  it('clamps an explicit sidecar override of true on a video', async () => {
    // Build the asset with a live `.mov` fileinfo entry and a
    // metadata_override carrying is_screenshot: true, run the stage, and
    // assert the projected patch field is false.
    // The override itself is NOT asserted away — it stays in the sidecar.
    expect(patch.is_screenshot).toBe(false);
  });

  it('clamps a stored vision verdict of true on a video', async () => {
    // Same, but with vision: { is_screenshot: true } and no override.
    expect(patch.is_screenshot).toBe(false);
  });

  it('leaves a still image override of true intact', async () => {
    // Same shape with a `.png` fileinfo entry.
    expect(patch.is_screenshot).toBe(true);
  });
});
```

Replace each comment with the concrete fixture the file's existing helpers produce. If the file has no reusable builder, copy the nearest existing case's setup verbatim and change only the filename, the override, and the assertion.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/workers/stages/sidecar-metadata-index.test.ts
```

Expected: the two video cases FAIL with `true` where `false` is expected. The still case passes.

- [ ] **Step 3: Write minimal implementation**

In `src/api/src/workers/stages/sidecar-metadata-index.ts`, add to the imports:

```ts
import { isVideoFilename } from '../../indexer/media-types.ts';
```

Replace the `nativeIsScreenshot` block and the `patch['is_screenshot']` assignment with:

```ts
const primaryFile = image.fileinfo?.find((e) => !e.deleted_at);
const isVideo = !!primaryFile && isVideoFilename(primaryFile.filename);

const nativeIsScreenshot = (() => {
  if (image.vision?.is_screenshot !== undefined && image.vision?.is_screenshot !== null) {
    return image.vision.is_screenshot;
  }
  if (!primaryFile) return false;
  return isLikelyScreenshot(primaryFile.filename, image.exif?.camera_make ?? null);
})();

const effectiveIsScreenshot =
  override.is_screenshot !== undefined && override.is_screenshot !== null
    ? override.is_screenshot
    : nativeIsScreenshot;

// `is_screenshot` is a stills-only concept (#2325). An explicit override
// stays in the sidecar untouched — XMP is the contract and it is the
// user's data — but the projected field that search, the facet counts, and
// the Photos/Screenshots filter read is clamped, so the invariant holds
// everywhere it is observable without discarding anything the user wrote.
patch['is_screenshot'] = isVideo ? false : effectiveIsScreenshot;
```

Note this hoists the `primary` lookup out of the IIFE so both the video test and the native computation share one binding. Every value is a `const`, per the repo's functional-immutable convention.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/workers/stages/sidecar-metadata-index.test.ts
```

Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/workers/stages/sidecar-metadata-index.ts src/api/src/workers/stages/sidecar-metadata-index.test.ts
git commit -m "fix(api): clamp the projected screenshot flag for video assets

A sidecar override or a stored vision verdict could still project
is_screenshot true onto a video. The override stays in the sidecar — it is
the user's data — but the derived field search and the Photos/Screenshots
filter read now honours the stills-only invariant.

Refs #2325"
```

---

### Task 4: Migration to clear already-flagged videos

Tasks 1–3 only stop new flags. Videos already in the library keep theirs, because a stage does not re-run once its version is stamped. This migration is pure Mongo — no file I/O and no decode — so unlike `rearm-video-posters` it has no ffmpeg precondition.

**Files:**

- Create: `src/api/src/workers/migration/clear-video-screenshot-flags.ts`
- Create: `src/api/src/workers/migration/clear-video-screenshot-flags.test.ts`
- Modify: `src/api/src/workers/migration/index.ts`
- Modify: `src/api/src/db/schema.ts` (add the `video_screenshot_clear_version` marker field to `AssetDoc`)

**Interfaces:**

- Consumes: `liveVideoFileinfoMatch()` from `./video-selectors.ts`; `assetsCollection()` from `../../db/client.ts`; `child as childLogger` from `../../log.ts`; the `Migration` and `MigrationBatchResult` types from `./types.ts`.
- Produces: `export const clearVideoScreenshotFlags: Migration` with `id: 'clear-video-screenshot-flags'`, and `export const VIDEO_SCREENSHOT_CLEAR_VERSION: number` (starts at `1`) for the test to import.

- [ ] **Step 1: Add the done-marker field to the schema**

In `src/api/src/db/schema.ts`, add this to `AssetDoc` immediately after the `video_poster_rearm_version` field:

```ts
  /**
   * Video screenshot-flag clear generation
   * (`workers/migration/clear-video-screenshot-flags.ts`). Stamped once that
   * migration has cleared a video's `is_screenshot` / `vision.is_screenshot`
   * and re-armed its describe + meili stages (#2325); its `{ $ne: N }`
   * selector re-sweeps videos once per bump. Without this marker the
   * candidate set would refill as soon as a re-run re-flagged a row, and the
   * migration would never reach "done."
   */
  video_screenshot_clear_version?: number;
```

- [ ] **Step 2: Write the failing test**

Create `src/api/src/workers/migration/clear-video-screenshot-flags.test.ts`. Copy the MongoDB connection scaffold (`TEST_DB`, `MONGO_URI`, `tryConnect`, the `beforeAll`/`afterAll` pair, and the skip-when-unreachable guard) verbatim from `src/api/src/workers/migration/rearm-video-posters.test.ts`, changing only the `TEST_DB` name to `maple_test_clear_video_screenshot_${process.pid}`. Then the cases:

```ts
/**
 * Tests for the clear-video-screenshot-flags migration (#2325).
 *
 * Tasks 1-3 stop NEW videos being flagged; they do nothing for videos
 * already carrying the flag, because a stage does not re-run once its
 * version is stamped. The properties worth pinning down, and why each
 * would be a real bug:
 *  - videos are selected, stills are NOT (a still sweep would wrongly clear
 *    real screenshots and re-run describe across the whole library)
 *  - `vision.is_screenshot` is only touched on rows that HAVE a vision
 *    subdoc (a bare $set would fabricate `vision: { is_screenshot: false }`
 *    on heuristic-flagged rows, which is a malformed VisionDoc)
 *  - the full five-field stage reset, not just `version` (a dead-lettered
 *    row left at `dead: true` is never re-claimed)
 *  - the done-marker terminates the migration
 *  - soft-deleted / missing locations are excluded
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import {
  clearVideoScreenshotFlags,
  VIDEO_SCREENSHOT_CLEAR_VERSION,
} from './clear-video-screenshot-flags.ts';

// ... connection scaffold copied from rearm-video-posters.test.ts ...

function videoDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(),
    maple_id: 'clear-' + Math.random().toString(36).slice(2),
    fileinfo: [
      {
        path: '2024/Screenshot',
        filename: 'Screen Recording 2024-06-01.mov',
        library_id: new ObjectId(),
        deleted_at: null,
        missing_since: null,
      },
    ],
    is_screenshot: true,
    stages: {
      describe: { version: 4, attempts: 3, last_error: 'boom', dead: true },
    },
    ...overrides,
  };
}

function stillDoc(overrides: Record<string, unknown> = {}) {
  return {
    ...videoDoc(),
    fileinfo: [
      {
        path: '2024/Screenshot',
        filename: 'Screenshot 2024-06-01.png',
        library_id: new ObjectId(),
        deleted_at: null,
        missing_since: null,
      },
    ],
    ...overrides,
  };
}

describe('clear-video-screenshot-flags', () => {
  it('clears the flag on a flagged video and stamps the marker', async () => {
    const coll = db!.collection('assets');
    const doc = videoDoc();
    await coll.insertOne(doc as never);

    const res = await clearVideoScreenshotFlags.runBatch(100);
    expect(res.processed).toBeGreaterThanOrEqual(1);
    expect(res.errors).toBe(0);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.is_screenshot).toBe(false);
    expect(after!.video_screenshot_clear_version).toBe(VIDEO_SCREENSHOT_CLEAR_VERSION);
  });

  it('re-arms describe and meili with the full five-field reset', async () => {
    const coll = db!.collection('assets');
    const doc = videoDoc();
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    for (const stage of ['describe', 'meili']) {
      expect(after!.stages[stage].version).toBe(0);
      expect(after!.stages[stage].attempts).toBe(0);
      expect(after!.stages[stage].last_error).toBe(null);
      expect(after!.stages[stage].processed_at).toBe(null);
      expect(after!.stages[stage].dead).toBe(false);
    }
  });

  it('clears vision.is_screenshot when a vision subdoc exists', async () => {
    const coll = db!.collection('assets');
    const doc = videoDoc({
      vision: { caption: 'a UI', is_screenshot: true, subjects: [] },
    });
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.vision.is_screenshot).toBe(false);
    expect(after!.vision.caption).toBe('a UI');
  });

  it('does NOT fabricate a vision subdoc on a heuristic-flagged video', async () => {
    const coll = db!.collection('assets');
    const doc = videoDoc();
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.vision).toBeUndefined();
  });

  it('leaves still images alone', async () => {
    const coll = db!.collection('assets');
    const doc = stillDoc();
    await coll.insertOne(doc as never);

    await clearVideoScreenshotFlags.runBatch(100);

    const after = await coll.findOne({ _id: doc._id });
    expect(after!.is_screenshot).toBe(true);
    expect(after!.video_screenshot_clear_version).toBeUndefined();
  });

  it('excludes soft-deleted and missing locations', async () => {
    const coll = db!.collection('assets');
    const deleted = videoDoc();
    deleted.fileinfo[0].deleted_at = new Date().toISOString() as never;
    const missing = videoDoc();
    missing.fileinfo[0].missing_since = new Date().toISOString() as never;
    await coll.insertMany([deleted, missing] as never);

    await clearVideoScreenshotFlags.runBatch(100);

    expect((await coll.findOne({ _id: deleted._id }))!.is_screenshot).toBe(true);
    expect((await coll.findOne({ _id: missing._id }))!.is_screenshot).toBe(true);
  });

  it('reaches done and is idempotent on a second pass', async () => {
    const coll = db!.collection('assets');
    await coll.insertOne(videoDoc() as never);

    await clearVideoScreenshotFlags.runBatch(100);
    expect(await clearVideoScreenshotFlags.countRemaining()).toBe(0);

    const second = await clearVideoScreenshotFlags.runBatch(100);
    expect(second.processed).toBe(0);
    expect(second.errors).toBe(0);
  });
});
```

Clear the `assets` collection between cases so counts do not leak — add a `beforeEach` that calls `db!.collection('assets').deleteMany({})`, guarded by the same mongo-reachable check the other cases use.

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/workers/migration/clear-video-screenshot-flags.test.ts
```

Expected: FAIL at import — the module does not exist yet. If MongoDB is not running, start a throwaway instance first (`mongod --dbpath <tmp> --port 27077` with `MAPLE_MONGO_URI=mongodb://localhost:27077`); a skipped suite is not evidence the code works.

- [ ] **Step 4: Write the implementation**

Create `src/api/src/workers/migration/clear-video-screenshot-flags.ts`:

```ts
/**
 * Migration: "Clear video screenshot flags."
 *
 * `is_screenshot` is a stills-only concept (#2325), but videos could acquire
 * it three ways before the fix: the filename heuristic seeded it in the EXIF
 * stage, the VLM returned it for a poster frame that looked like a UI (a
 * screen recording does every time), and the sidecar re-index read that
 * verdict back. A flagged video drops out of the Photos bucket of the
 * Photos/Screenshots filter, and the prompt-v5 screenshot short-circuit also
 * nulled its whole scene description.
 *
 * The code fix only stops NEW flags. A stage does not re-run once its
 * version is stamped, so every video already carrying the flag keeps it
 * until this migration resets them.
 *
 * Why not bump the describe stage's targetVersion — the built-in "re-run
 * everything" mechanism? Because that re-queues the ENTIRE library through a
 * VLM inference per asset. Scoping to flagged video keeps the cost
 * proportional to the damage.
 *
 * Pure Mongo: no file I/O, no decode, and so — unlike `rearm-video-posters`
 * — no ffmpeg precondition. The describe re-run itself happens later, on the
 * stage worker's own schedule and under its own concurrency limits.
 *
 * Known limitation: re-running describe on a genuine screen recording will
 * probably null the scene fields again, because the short-circuit lives in
 * the prompt and the model still sees a UI. The FLAG stays correct either
 * way, and the re-run does recover videos that were only ever misclassified
 * by the filename heuristic. Ticket #2158 (multi-frame video-describe) is
 * the better home for the description-quality half.
 *
 * Done-marker is `video_screenshot_clear_version`, mirroring
 * `video_poster_rearm_version` in `rearm-video-posters.ts`. Bump
 * `VIDEO_SCREENSHOT_CLEAR_VERSION` to sweep again.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { child as childLogger } from '../../log.ts';
import { liveVideoFileinfoMatch } from './video-selectors.ts';

import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:video-screenshot');

const MIGRATION_ID = 'clear-video-screenshot-flags';

/** Bump to re-sweep every flagged video again. */
export const VIDEO_SCREENSHOT_CLEAR_VERSION = 1;

/**
 * Stages re-armed once the flag is cleared.
 *
 * `describe` because the v5 screenshot short-circuit nulled `scene_type`,
 * `setting`, `activity`, `time_of_day`, `lighting`, `weather`,
 * `composition`, and `shot_type` on every flagged row — a re-run is the only
 * way those come back. `meili` because the search index and its facet counts
 * hold the stale `true`, and the Photos/Screenshots filter reads them.
 *
 * NOT `thumb` / `preview` / `cf-thumb-sync`: the derivatives are correct and
 * unaffected, and resetting `cf-thumb-sync` would re-upload every one of
 * these thumbnails to R2 for no benefit.
 */
const REARMED_STAGES = ['describe', 'meili'] as const;

/** Videos with a live on-disk location still carrying the flag, either on
 * the top-level mirror or in the stored vision subdoc, that haven't been
 * cleared at the current version yet. */
function candidateFilter(): Filter<AssetDoc> {
  return {
    fileinfo: { $elemMatch: liveVideoFileinfoMatch() },
    video_screenshot_clear_version: { $ne: VIDEO_SCREENSHOT_CLEAR_VERSION },
    $or: [{ is_screenshot: true }, { 'vision.is_screenshot': true }],
  } as Filter<AssetDoc>;
}

/**
 * The `$set` that clears one asset: the top-level flag, the done-marker, and
 * every re-armed stage back to unprocessed.
 *
 * The full five-field stage reset (`version`/`attempts`/`last_error`/
 * `processed_at`/`dead`) matches `reArmCacheStages()` in
 * `workers/dedupe.helpers.ts` rather than resetting `version` alone. An asset
 * that previously dead-lettered would otherwise stay `dead: true` and never
 * be claimed, and a stale `last_error` would keep showing in
 * Settings → Workers for a stage that is about to be retried clean.
 *
 * `vision.is_screenshot` is deliberately NOT in here — see `runBatch`.
 */
function clearUpdate(): Record<string, unknown> {
  const set: Record<string, unknown> = {
    is_screenshot: false,
    video_screenshot_clear_version: VIDEO_SCREENSHOT_CLEAR_VERSION,
  };
  for (const name of REARMED_STAGES) {
    set[`stages.${name}.version`] = 0;
    set[`stages.${name}.attempts`] = 0;
    set[`stages.${name}.last_error`] = null;
    set[`stages.${name}.processed_at`] = null;
    set[`stages.${name}.dead`] = false;
  }
  return set;
}

export const clearVideoScreenshotFlags: Migration = {
  id: MIGRATION_ID,
  title: 'Clear video screenshot flags',
  description:
    'Clears is_screenshot on videos that were wrongly classified as screenshots, and re-queues ' +
    'them through describe and meili so their scene description and search entry are rebuilt. ' +
    'Videos could pick up the flag from the filename heuristic or from the vision model reading ' +
    'a poster frame as a UI, which dropped them out of the Photos filter. One-time; idempotent ' +
    'per video.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();

    // Pure Mongo — this migration only moves flags and stage bookkeeping, so
    // a whole batch is two `updateMany` calls rather than the per-document
    // loop the file-moving migrations need.
    const ids = await coll
      .find(candidateFilter(), { projection: { _id: 1 } })
      .limit(batchSize)
      .toArray();

    if (ids.length === 0) return { processed: 0, errors: 0 };

    const _id = { $in: ids.map((d) => d._id) };

    try {
      const res = await coll.updateMany({ _id } as Filter<AssetDoc>, {
        $set: clearUpdate(),
      });

      // Second, narrower write: clear the vision mirror ONLY on rows that
      // actually have one. Folding this into the $set above would make Mongo
      // fabricate `vision: { is_screenshot: false }` on every
      // heuristic-flagged row that never ran describe — a malformed VisionDoc
      // with no caption, and one that would then satisfy the "vision exists"
      // branch in `sidecar-metadata-index`.
      await coll.updateMany({ _id, 'vision.is_screenshot': true } as Filter<AssetDoc>, {
        $set: { 'vision.is_screenshot': false },
      });

      log.info(
        { matched: res.matchedCount, modified: res.modifiedCount },
        'cleared video screenshot flags',
      );
      return { processed: res.modifiedCount, errors: 0 };
    } catch (err) {
      // Left unstamped, so the next tick retries this same batch.
      log.error(
        { count: ids.length, err: err instanceof Error ? err.message : err },
        'clear batch failed — left for retry',
      );
      return { processed: 0, errors: ids.length };
    }
  },
};
```

- [ ] **Step 5: Register the migration**

In `src/api/src/workers/migration/index.ts`, add the import alongside the others:

```ts
import { clearVideoScreenshotFlags } from './clear-video-screenshot-flags.ts';
```

and add `clearVideoScreenshotFlags,` as the last entry of the `MIGRATIONS` array. The worker, routes, status surface, and the Settings → Workers toggle pick it up generically — no other wiring is needed.

- [ ] **Step 6: Run test to verify it passes**

```bash
bun test src/workers/migration/clear-video-screenshot-flags.test.ts
```

Expected: PASS on all cases, against a real MongoDB. A skipped run is not a pass — confirm the suite actually executed.

- [ ] **Step 7: Commit**

```bash
git add src/api/src/workers/migration/clear-video-screenshot-flags.ts \
        src/api/src/workers/migration/clear-video-screenshot-flags.test.ts \
        src/api/src/workers/migration/index.ts \
        src/api/src/db/schema.ts
git commit -m "feat(api): migration to clear screenshot flags off existing videos

The code fix only stops new flags — a stage does not re-run once its
version is stamped, so videos already flagged keep it. Clears the flag,
clears the vision mirror where one exists, and re-arms describe + meili so
the scene description and search entry are rebuilt. Toggle lands on
Settings -> Workers with the other migrations.

Refs #2325"
```

---

### Task 5: End-to-end ingest-route coverage

Task 1 fixed the ingest route's predicate. This proves it at the route, where the on-disk folder decision actually happens — the layer a user would notice.

**Files:**

- Modify: `src/api/tests/backup-ingest-screenshot.test.ts`

**Interfaces:**

- Consumes: the existing `ingest(bytes, headers)` request builder, the `authedHandle` helper, `assetsCollection()`, and the `tmpLib` / `deviceId` fixtures already defined at the top of that file.
- Produces: no exports; test-only.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('backup-ingest screenshot routing', ...)` block in `src/api/tests/backup-ingest-screenshot.test.ts`:

```ts
test('a Screenshot-named VIDEO is not routed to <year>/Screenshot (#2325)', async () => {
  const bytes = Buffer.alloc(64, 7);
  const res = await authedHandle(
    ingest(bytes, {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': 'SS/L0/003',
      'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
      // A screen recording carries a screenshot-shaped name on some
      // devices. It is still a video, so it belongs in the normal date
      // layout, not the Screenshot folder.
      'X-Maple-Filename': 'Screenshot_20240315_103000.mp4',
      'X-Maple-Total-Bytes': '64',
      'X-Maple-Maple-Id': 'screenshot-video-1',
      'Content-Range': 'bytes 0-63/64',
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.target_rel_path).toBe('2024/Misc/Screenshot_20240315_103000.mp4');

  const a = await assetsCollection();
  const doc = await a.findOne({ maple_id: 'screenshot-video-1' });
  expect(doc?.fileinfo?.[0].path).toBe('2024/Misc');
  expect(doc?.is_screenshot).toBe(false);

  // And the bytes really landed outside the Screenshot folder.
  expect(
    await fs.readFile(path.join(tmpLib, '2024/Misc/Screenshot_20240315_103000.mp4')),
  ).toHaveLength(64);
});
```

- [ ] **Step 2: Run test to verify it passes**

```bash
bun test tests/backup-ingest-screenshot.test.ts
```

Expected: PASS, because Task 1 already fixed the predicate this route calls. This is the one place in the plan where the test is written green on purpose — it is regression coverage for a fix landed earlier, not a driver for new code.

To confirm it is genuinely exercising the fix rather than passing vacuously, temporarily revert the `isVideoFilename` guard in `src/api/src/indexer/screenshot.ts`, re-run, and check the test FAILS with `2024/Screenshot/...`. Restore the guard afterwards.

- [ ] **Step 3: Run the full API suite**

```bash
bun test
```

Expected: no NEW failures relative to the branch point. Capture the before/after counts — this repo's `tsc` is not clean and some suites are environment-dependent, so compare against a baseline run rather than assuming zero failures.

- [ ] **Step 4: Commit**

```bash
git add src/api/tests/backup-ingest-screenshot.test.ts
git commit -m "test(api): pin that a Screenshot-named video skips the Screenshot folder

Regression coverage at the ingest route, where the on-disk folder decision
is made and where a user would actually notice it.

Refs #2325"
```

---

### Task 6: Open the pull request

**Files:** none — repository operation only.

- [ ] **Step 1: Rebase onto current main**

A branch is only mergeable if it is green on the base it will actually land on.

```bash
git fetch origin main && git rebase origin/main
```

Resolve any per-commit conflicts as they arise. Never `git merge origin/main` — this repo uses "Rebase and merge" and a branch containing merge commits cannot be rebased by the GitHub UI.

- [ ] **Step 2: Re-run the API suite on the rebased base**

```bash
bun test
```

Expected: no new failures. If `main` moved under the branch, this is what catches a semantic conflict that git merged silently.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feature/video-id-screenshot-prevention-3a6591
```

Open it ready for review, not as a draft — drafts do not trigger CI or code review. The body must include `Closes #2325` and should summarise the five write sites, the stills-only invariant, the migration and where its toggle appears, and the known limitation about screen recordings re-nulling their scene fields.

- [ ] **Step 4: Confirm CI is green**

Check the run against the current tip of `main`. A red or still-pending required check is not mergeable, including one that looks unrelated or is believed to be flaky. Do not merge — merging waits for explicit approval from the repository owner.

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task. The video-aware predicate is Task 1; clamping the model verdict at its three consumers is Task 2; the sidecar-override projection is Task 3; the migration, its schema marker, and its registry entry are Task 4. The spec's testing section named five areas — the predicate (Task 1), the describe stage (Task 2), the sidecar override (Task 3), the migration (Task 4), and the ingest route (Task 5) — and all five have concrete test code or, for Task 3, an explicit instruction to reuse the file's existing fixtures. The spec's "known limitation" is carried into the migration's module docstring rather than dropped. The spec's scope boundary (no Apple, Web, or raw-core changes) is in Global Constraints.

**Placeholder scan.** Task 3's test block is the one place with prose instead of literal fixtures, because that file's document builder has to be read before it can be reused and inventing a parallel one would be worse. It names the exact three behaviours, the exact assertion for each, and says to copy the nearest existing case — that is a bounded instruction, not a "write tests for the above." Task 4's test scaffold points at `rearm-video-posters.test.ts` for the connection boilerplate for the same reason. No TBDs, no "add appropriate error handling."

**Type consistency.** `VIDEO_SCREENSHOT_CLEAR_VERSION` and `clearVideoScreenshotFlags` are named identically in the module, the test import, and the registry entry. `video_screenshot_clear_version` matches between the schema field, the candidate filter, the `$set`, and the test assertion. `isVideoFilename` is the single classification entry point in all three production edits. `isScreenshot` in Task 2 is the one clamped binding feeding all three consumers, and `effectiveIsScreenshot` in Task 3 is distinct from it by design — different stages, different inputs.
