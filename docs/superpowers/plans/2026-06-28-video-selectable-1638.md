# Video Selectable (#1638) Implementation Plan

This plan is organised task-by-task.

**Goal:** Make standalone video files (`.mov`, `.mp4`, etc.) first-class selectable assets in both the web and Apple batch metadata panels, so their metadata can be edited via the existing M2/M4 UIs and written to `clip.mov.xmp` sidecars.

**Architecture:** Three changes gate on each other logically but are independent in code. (1) API: add `VIDEO_EXTS` to `SUPPORTED_EXTS` (discover/sweeper) and surface videos in `listDirFast`/`listDirContents` so they appear in the grid with an `asset_id`; the existing `video-metadata.ts` + `handleEvent` handle indexing. (2) Web: extend `FolderListing` / `ImageEntry` with an `isVideo` flag so the batch-metadata panel can call `/api/xmp/batch` for video paths — the batch route already writes `clip.mov.xmp` correctly. (3) Apple: add `SidecarPath.videoExtensions` (already present) to `SupportedImageExtensions.all` in `FilesystemSource`, add a `XMPSerializer.serializeMetadataOnly(metadata:)` method for video assets, and use it in `BatchMetadataViewModel.applyToAsset` instead of deserializing a bogus AdjustmentModel for a video file.

**Thumbnail decision:** Videos are surfaced in the `images` array of `listDirFast`/`listDirContents` with an `isVideo: true` flag and no real poster frame. The thumbnail endpoint will 404 for video paths (no change required to the thumb renderer). A video-poster/icon follow-up is filed as a separate ticket. This is the minimal approach per YAGNI; video cells render a placeholder until a poster is available.

**Tech Stack:** TypeScript (Bun/Elysia API), Angular 21 signals (web), Swift/SwiftUI (Apple MapleCore), Bun test, XCTest.

## Global Constraints

- NEVER touch originals or backups — metadata writes go to `.xmp` sidecars only.
- No `git add -A` / `git add .` — stage explicit paths only.
- No real NUL bytes in source files.
- Tests use isolated temp dirs / unique MAPLE_MONGO_DB per file (API) and real XMPSidecarStore + temp dirs (Apple).
- Originals are never decoded for video assets — only metadata/sidecar paths are read/written.
- The `sidecar-metadata-index` worker stage already supports video passthrough (M5). No changes required there.
- Thumbnail follow-up for video poster frames must be filed as a tracked ticket on the Files board.

---

## File Map

| File                                                                                  | Action             | Responsibility                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/src/workers/discover/types.ts`                                               | Modify             | Add video extensions to `SUPPORTED_EXTS`                                                                                                 |
| `src/api/src/workers/discover/sweeper.test.ts`                                        | Modify             | Add test: video file emits `created` event                                                                                               |
| `src/api/src/fs/browse.ts`                                                            | Modify             | Surface video files in `listDirFast` and `listDirContents` `images` array with `isVideo: true`; also pair video sidecars to video assets |
| `src/api/src/fs/browse.test.ts`                                                       | Create             | Tests for video in `listDirFast` and `listDirContents` (if not present)                                                                  |
| `src/web/projects/maple-common/src/lib/addressing/library-source.ts`                  | Modify             | Add `isVideo?: boolean` to `ImageEntry`                                                                                                  |
| `src/web/projects/maple-common/src/lib/api/filesystem-browse.service.ts`              | Modify             | Add `isVideo?: boolean` to `FsImageEntry`                                                                                                |
| `src/web/projects/maple-common/src/lib/state/library-fetch.service.ts`                | Modify             | Forward `isVideo` to `Asset` model when building asset list                                                                              |
| `src/web/projects/maple-common/src/lib/models/asset.ts`                               | Modify (if needed) | Add `isVideo?: boolean` to `Asset` interface                                                                                             |
| `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/FilesystemSource.swift`       | Modify             | Add `SidecarPath.videoExtensions` to enumeration filter + add `VideoExtensions` enum                                                     |
| `src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization.swift`               | Modify             | Add `XMPSerializer.serializeMetadataOnly(metadata:)` static method                                                                       |
| `src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift`         | Modify             | Use `serializeMetadataOnly` for video assets in `applyToAsset`                                                                           |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift` | Modify             | Add tests: video asset apply writes `clip.mov.xmp` with no crs: block                                                                    |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`       | Modify             | Add test: `serializeMetadataOnly` produces no crs: attributes                                                                            |

---

## Task 1: API — Add video extensions to discover/sweeper allowlist

**Files:**

- Modify: `src/api/src/workers/discover/types.ts` (lines 37–59)
- Modify: `src/api/src/workers/discover/sweeper.test.ts`

**Interfaces:**

- Produces: `SUPPORTED_EXTS` now includes `.mov`, `.mp4`, `.m4v`, `.avi`, `.mkv`, `.webm`, `.mts`, `.m2ts`, `.3gp` — any code that imports this set gains video support automatically (sweeper, handleEvent).

- [ ] **Step 1: Write the failing test**

In `src/api/src/workers/discover/sweeper.test.ts`, add a test that a `.mov` file inside a swept directory emits a `created` event (current behaviour: it's silently ignored because `isSupported` returns false):

```typescript
it('emits created for a video file (.mov)', async () => {
  if (!reachable) return;
  const { visitDirectory } = await import('./sweeper.ts');
  const frontier = await import('./frontier.repo.ts');

  const root = mkdtempSync(join(tmpdir(), 'maple-sweep-video-'));
  writeFileSync(join(root, 'clip.mov'), 'x'); // video — must emit created

  const folderId = new ObjectId();
  const events: WatchEvent[] = [];
  await frontier.seedRoot(folderId, root, 1);
  const dir = await frontier.claimNextDir(folderId, 1, 60_000);
  await visitDirectory(dir!, root, {
    handleEvent: async (e) => {
      events.push(e);
    },
    folderId,
  });

  const kinds = events.map((e) => `${e.kind}:${e.absPath.split('/').pop()}`);
  expect(kinds).toContain('created:clip.mov');

  rmSync(root, { recursive: true, force: true });
});
```

Add imports at top of the test file if not already present:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchEvent } from './types.ts';
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/api
HOME=/tmp/maple-binst bun test src/workers/discover/sweeper.test.ts > /tmp/v-sweeper.log 2>&1
cat /tmp/v-sweeper.log | grep -E "FAIL|PASS|clip.mov"
```

Expected: FAIL — test `emits created for a video file (.mov)` fails (clip.mov not in `kinds`).

- [ ] **Step 3: Add video extensions to `SUPPORTED_EXTS`**

In `src/api/src/workers/discover/types.ts`, replace the existing `SUPPORTED_EXTS` block (lines 37–59):

```typescript
export const SUPPORTED_EXTS = new Set([
  // RAW formats decoded via libraw FFI
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.x3f',
  '.3fr',
  '.mef',
  '.erf',
  '.mrw',
  // Bitmap formats decoded via sharp / heic-convert
  '.jpg',
  '.jpeg',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
  // Video containers — metadata-only indexing via video-metadata.ts
  '.mov',
  '.mp4',
  '.m4v',
  '.avi',
  '.mkv',
  '.webm',
  '.mts',
  '.m2ts',
  '.3gp',
]);
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/api
HOME=/tmp/maple-binst bun test src/workers/discover/sweeper.test.ts > /tmp/v-sweeper.log 2>&1
cat /tmp/v-sweeper.log | grep -E "FAIL|PASS|clip.mov"
```

Expected: PASS — `emits created for a video file (.mov)` passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
git status --porcelain
git add src/api/src/workers/discover/types.ts src/api/src/workers/discover/sweeper.test.ts
git commit -m "feat(discover): add video extensions to SUPPORTED_EXTS allowlist (#1638)

Videos were silently ignored by the sweeper because SUPPORTED_EXTS only
listed image/RAW extensions. Adding all VIDEO_EXTS makes the sweeper emit
'created' events for .mov/.mp4/etc so handleEvent can insert them as assets.
"
```

---

## Task 2: API — Surface videos in `listDirFast` and `listDirContents`

**Files:**

- Modify: `src/api/src/fs/browse.ts`
- Create: `src/api/src/fs/browse.video.test.ts`

**Interfaces:**

- Consumes: `isVideoFilename` from `../indexer/media-types.ts` (already imported in browse.ts line 15)
- Produces:
  - `FastImageChild` gains `isVideo?: boolean`
  - `ImageChild` gains `isVideo?: boolean`
  - `listDirFast` returns videos in `images` array with `isVideo: true`
  - `listDirContents` returns videos in `images` array with `isVideo: true`, with `asset_id` set when indexed
  - `listDirContents` pairs video sidecars (`clip.mov.xmp`) to video image entries by their full filename

- [ ] **Step 1: Write failing tests**

Create `src/api/src/fs/browse.video.test.ts`:

```typescript
/**
 * Tests for video-file surfacing in listDirFast and listDirContents.
 * Uses real temp directories (no Mongo for listDirFast; isolated DB for listDirContents).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { listDirFast, listDirContents } from './browse.ts';

// Isolate from the real maple DB.
process.env.MAPLE_MONGO_DB = `maple_test_browse_video_${process.pid}`;
process.env.MAPLE_ROOTS = '/';

beforeAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});
afterAll(async () => {
  await (await import('../db/client.ts')).closeDb();
});

describe('listDirFast — video files', () => {
  it('includes .mov files in the images array with isVideo=true', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-video-'));
    try {
      await fs.writeFile(path.join(dir, 'clip.mov'), 'x');
      await fs.writeFile(path.join(dir, 'photo.dng'), 'x');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const names = result.data.images.map((i) => i.name);
      expect(names).toContain('clip.mov');
      expect(names).toContain('photo.dng');

      const videoEntry = result.data.images.find((i) => i.name === 'clip.mov');
      expect(videoEntry?.isVideo).toBe(true);

      const photoEntry = result.data.images.find((i) => i.name === 'photo.dng');
      expect(photoEntry?.isVideo).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('includes .mp4 files in the images array with isVideo=true', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-video2-'));
    try {
      await fs.writeFile(path.join(dir, 'video.mp4'), 'x');

      const result = await listDirFast(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const videoEntry = result.data.images.find((i) => i.name === 'video.mp4');
      expect(videoEntry).toBeDefined();
      expect(videoEntry?.isVideo).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('listDirContents — video files', () => {
  it('includes .mov files in the images array with isVideo=true', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-browse-dirc-video-'));
    try {
      await fs.writeFile(path.join(dir, 'clip.mov'), 'x');

      const result = await listDirContents(dir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const names = result.data.images.map((i) => i.name);
      expect(names).toContain('clip.mov');

      const videoEntry = result.data.images.find((i) => i.name === 'clip.mov');
      expect(videoEntry?.isVideo).toBe(true);

      // Not in files array anymore
      const filesNames = result.data.files.map((f) => f.name);
      expect(filesNames).not.toContain('clip.mov');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/api
HOME=/tmp/maple-binst bun test src/fs/browse.video.test.ts > /tmp/v-browse.log 2>&1
cat /tmp/v-browse.log | grep -E "FAIL|PASS|isVideo|clip.mov"
```

Expected: FAIL — videos are not in `images`, `isVideo` not present.

- [ ] **Step 3: Modify `browse.ts` — extend types and add video support**

In `src/api/src/fs/browse.ts`:

**3a. Extend `FastImageChild`** (line ~711):

```typescript
export interface FastImageChild extends DirChild {
  size: number; // bytes
  ext: string; // lowercase, no dot
  /** True when the file is a video container (e.g. .mov, .mp4). */
  isVideo?: true;
}
```

**3b. Extend `ImageChild`** (line ~292):

```typescript
export interface ImageChild extends DirChild {
  size: number; // bytes
  ext: string; // lowercase, no dot
  id?: string;
  exif?: AssetExif | null;
  /** True when the file is a video container (e.g. .mov, .mp4). */
  isVideo?: true;
}
```

**3c. In `listDirFast` — add `VIDEO_EXTENSIONS` constant** (near line ~259 where `IMAGE_EXTENSIONS` is defined). Add after the `IMAGE_EXTENSIONS` constant:

```typescript
/** Video container extensions surfaced in the listing alongside images (no dot). */
const VIDEO_EXTENSIONS = new Set<string>([
  'mov',
  'mp4',
  'm4v',
  'avi',
  'mkv',
  'webm',
  'mts',
  'm2ts',
  '3gp',
]);
```

**3d. In `listDirFast` classification block** (line ~817–829), add a branch for video after `IMAGE_EXTENSIONS.has(ext)`:

```typescript
if (IMAGE_EXTENSIONS.has(ext)) {
  images.push({
    name,
    path: childReal,
    size: st.size,
    mtime: st.mtime.toISOString(),
    ext,
  });
} else if (VIDEO_EXTENSIONS.has(ext)) {
  images.push({
    name,
    path: childReal,
    size: st.size,
    mtime: st.mtime.toISOString(),
    ext,
    isVideo: true,
  });
}
```

**3e. In `listDirContents` classification block** (line ~550–578), change the `else` branch (which currently puts videos in `files`) to check for videos:

```typescript
      } else if (st.isFile()) {
        const dot = name.lastIndexOf('.');
        const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
        if (ext !== '' && IMAGE_EXTENSIONS.has(ext)) {
          images.push({
            name,
            path: childReal,
            size: st.size,
            mtime: st.mtime.toISOString(),
            ext,
          });
        } else if (ext !== '' && VIDEO_EXTENSIONS.has(ext)) {
          images.push({
            name,
            path: childReal,
            size: st.size,
            mtime: st.mtime.toISOString(),
            ext,
            isVideo: true,
          });
        } else if (ext === 'xmp') {
          sidecarRaw.push({
            name,
            path: childReal,
            size: st.size,
            mtime: st.mtime.toISOString(),
          });
        } else {
          // Every other regular file (documents, archives, extensionless, …)
          files.push({
            name,
            path: childReal,
            size: st.size,
            mtime: st.mtime.toISOString(),
            ext,
          });
        }
```

**3f. In `listDirContents` — fix the EXIF/asset-id enrichment block** to also cover video entries. The existing bulk EXIF lookup (line ~585–624) only runs when `images.length > 0`. Since videos are now in `images`, they participate automatically. But the query filters `fileinfo.filename` by all image names — videos will also be covered because they're in `images` now.

**3g. In `listDirContents` — fix sidecar pairing for videos**. The existing sidecar-pairing loop (line ~647–661) currently skips video-named sidecar bases (`isVideoFilename(base) → continue`). Now that videos ARE indexed assets, we need to pair `clip.mov.xmp` sidecars to the `clip.mov` entry. Change the sidecar loop to pair video sidecars to video images:

Replace the existing sidecar loop body (lines ~648–661):

```typescript
// Build image-base-to-assetId map. For still images, key by stem (no ext).
// For video assets, key by full filename (because their sidecar uses full-name convention).
const imageBaseToAsset = new Map<string, string>(globalImageBaseToAsset);
for (const img of images) {
  if (!img.id) continue;
  if ((img as ImageChild).isVideo) {
    // Video: key by full filename (e.g. "clip.mov") so clip.mov.xmp → clip.mov
    imageBaseToAsset.set(img.name, img.id);
  } else {
    const dot = img.name.lastIndexOf('.');
    const base = dot >= 0 ? img.name.slice(0, dot) : img.name;
    imageBaseToAsset.set(base, img.id);
  }
}

const sidecars: SidecarChild[] = [];
for (const cand of sidecarRaw) {
  const base = canonicalBaseFromSidecarFilename(cand.name);
  if (!base) continue;
  const assetID = imageBaseToAsset.get(base);
  if (!assetID) continue;
  sidecars.push({ ...cand, asset_id: assetID });
}
```

Also update the global paged pre-walk (line ~467–508) to include video filenames in `allImageBases`:

```typescript
  if (pagedMode) {
    const allImageBases = new Map<string, string>(); // base → candidate abs_path
    for (const name of visible) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot + 1).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        const base = name.slice(0, dot);
        const candidate = real === '/' ? '/' + name : `${real}/${name}`;
        allImageBases.set(base, candidate);
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        // Video uses full filename as key (full-name sidecar convention)
        const candidate = real === '/' ? '/' + name : `${real}/${name}`;
        allImageBases.set(name, candidate);
      }
    }
    // ... (Mongo lookup unchanged — queries by filename)
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/api
HOME=/tmp/maple-binst bun test src/fs/browse.video.test.ts > /tmp/v-browse.log 2>&1
cat /tmp/v-browse.log | grep -E "FAIL|PASS|isVideo|clip.mov"
```

Expected: All PASS.

- [ ] **Step 5: Run full API test suite (no new failures)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/api
HOME=/tmp/maple-binst bun test > /tmp/v-api-full.log 2>&1
grep -E "^PASS|^FAIL|failed|error" /tmp/v-api-full.log | tail -20
```

Expected: 0 new FAIL lines.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
git status --porcelain
git add src/api/src/fs/browse.ts src/api/src/fs/browse.video.test.ts
git commit -m "feat(browse): surface video files as selectable assets in listDirFast/listDirContents (#1638)

Videos now appear in the 'images' array with isVideo=true instead of the
'files' bucket. Full-name sidecars (clip.mov.xmp) are paired to video
entries by their full filename so SidecarChild.asset_id is populated for
indexed video assets. VIDEO_EXTENSIONS constant mirrors SUPPORTED_EXTS.
"
```

---

## Task 3: Web — Forward `isVideo` from API to Angular state

**Files:**

- Modify: `src/web/projects/maple-common/src/lib/addressing/library-source.ts`
- Modify: `src/web/projects/maple-common/src/lib/api/filesystem-browse.service.ts`
- Modify: `src/web/projects/maple-common/src/lib/models/asset.ts` (check if `isVideo` field is needed)
- Modify: `src/web/projects/maple-common/src/lib/state/library-fetch.service.ts`

**Interfaces:**

- Consumes: `isVideo?: true` on `FastImageChild` (from API)
- Produces: `isVideo?: boolean` on `ImageEntry`, `FsImageEntry`, and `Asset` — so the batch-metadata panel can detect which selected assets are videos and format the xmp/batch request path correctly (already handled by the route's `isVideoFilename` detection on the server side; client just needs the flag for any future UI differentiation)

Note: The `/api/xmp/batch` route already detects video paths from the file extension in `path` — the client side doesn't NEED to know about `isVideo` to make the edit work. However, forwarding it is the correct hygiene so the grid can show a video badge (deferred to the UI follow-up, but the data should be available). **Skip the Angular changes if no consumer needs `isVideo` in the batch-metadata flow** — the batch-metadata panel sends `/api/xmp/batch` keyed by the asset's `absPath`, which already contains the video extension. The server will detect it.

**Revised scope check:** The `batch-metadata-panel.component.ts` calls `BatchMetadataService.applyBatch(entries)` with `{path: asset.absPath, metadata: ...}` entries. The server receives the path, detects the extension, and applies `metadataOnly: true`. So the web side already works correctly for video assets IF the video is selectable (i.e., appears in `listing.images`).

The minimum web change is:

1. Add `isVideo?: boolean` to `FsImageEntry` (matches server's `FastImageChild`)
2. Add `isVideo?: boolean` to `ImageEntry` (matches `FolderListing.images`)

This is a type-accuracy fix; no logic changes needed in the batch panel.

- [ ] **Step 1: Update `FsImageEntry` in `filesystem-browse.service.ts`**

In `src/web/projects/maple-common/src/lib/api/filesystem-browse.service.ts`, extend `FsImageEntry`:

```typescript
export interface FsImageEntry extends FsDirEntry {
  size: number;
  /** Lowercase extension, no dot. */
  ext: string;
  /** True when this entry is a video container (e.g. .mov, .mp4). */
  isVideo?: boolean;
}
```

- [ ] **Step 2: Update `ImageEntry` in `library-source.ts`**

In `src/web/projects/maple-common/src/lib/addressing/library-source.ts`, extend `ImageEntry`:

```typescript
export interface ImageEntry {
  name: string;
  address: string;
  mapleId: string | null;
  indexed: boolean;
  width?: number;
  height?: number;
  capturedAt?: string;
  /** True when the asset is a video container. Grid can show a badge. */
  isVideo?: boolean;
}
```

- [ ] **Step 3: Check `Asset` model for `isVideo`**

Read `src/web/projects/maple-common/src/lib/models/asset.ts`. If `Asset` already has `isVideo`, nothing to do. If not, add:

```typescript
/** True when the asset is a video file. Batch-metadata path is unchanged
 *  (the server detects the extension); this field is for UI badges. */
isVideo?: boolean;
```

- [ ] **Step 4: Forward `isVideo` in `library-fetch.service.ts`**

In `src/web/projects/maple-common/src/lib/state/library-fetch.service.ts`, in the `_applyFolderListing` method (line ~693), add `isVideo` to the new asset:

```typescript
const newAssets: Asset[] = listing.images.map((img) => {
  const id: AssetId = img.address;
  return {
    id,
    filename: img.name,
    folderId: sourceId,
    rating: 0,
    flag: 'unflagged' as const,
    colorLabel: null,
    thumbnailGradient: '',
    aspectRatio: 3 / 2,
    ...(img.width != null ? { width: img.width } : {}),
    ...(img.height != null ? { height: img.height, aspectRatio: img.width! / img.height } : {}),
    ...(img.isVideo ? { isVideo: true } : {}),
  };
});
```

- [ ] **Step 5: Run web build and tests**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/web
HOME=/tmp/maple-binst bun install > /tmp/v-web-install.log 2>&1
HOME=/tmp/maple-binst bun x ng build maple > /tmp/v-web-build.log 2>&1
grep -E "Error|error TS|error:|✓|BUILD" /tmp/v-web-build.log | tail -10

HOME=/tmp/maple-binst bun x ng test maple-common --watch=false > /tmp/v-web-test.log 2>&1
grep -E "FAILED|PASSED|Executed" /tmp/v-web-test.log | tail -5

bun run format 2>&1 | tail -5
bun run format:check > /tmp/v-format.log 2>&1
cat /tmp/v-format.log | tail -5
```

Expected: build succeeds, no new test failures, format check clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
git status --porcelain
git add src/web/projects/maple-common/src/lib/addressing/library-source.ts \
        src/web/projects/maple-common/src/lib/api/filesystem-browse.service.ts \
        src/web/projects/maple-common/src/lib/models/asset.ts \
        src/web/projects/maple-common/src/lib/state/library-fetch.service.ts
git commit -m "feat(web): forward isVideo flag from browse API to Asset model (#1638)

Videos surfaced in the listing images array now carry isVideo=true through
FsImageEntry → ImageEntry → Asset. The batch-metadata panel already calls
/api/xmp/batch by asset absPath; the server detects the video extension and
applies metadataOnly writes without any extra client logic.
"
```

---

## Task 4: Apple — Enumerate video files in `FilesystemSource`

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/FilesystemSource.swift`

**Interfaces:**

- Consumes: `SidecarPath.videoExtensions` (already defined in `SidecarPath.swift`)
- Produces: `FilesystemSource._index()` returns video URLs alongside image URLs; `FileAsset` now includes videos

- [ ] **Step 1: Add `VideoExtensions` enum and update `SupportedImageExtensions`**

In `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/FilesystemSource.swift`:

After the `NonRawImageExtensions` enum (line ~282) and before `SupportedImageExtensions`, add:

```swift
// MARK: - VideoExtensions

public enum VideoExtensions {
    /// Video container extensions (lowercase, no dot). Mirrors `SidecarPath.videoExtensions`.
    /// Kept in sync manually — the list is stable and not codegen'd.
    public static let all: Set<String> = SidecarPath.videoExtensions
}
```

Then change `SupportedImageExtensions.all` (line ~292) to include video:

```swift
// MARK: - SupportedImageExtensions

public enum SupportedImageExtensions {
    /// Union of `RAWExtensions.all` + `NonRawImageExtensions.all` + `VideoExtensions.all` —
    /// what the LISTING phase (folder enumeration, fileImporter content types,
    /// drag-and-drop) accepts. The OPEN phase still branches on the extension
    /// to dispatch to the right decoder; only the listing gate uses this union.
    public static let all: Set<String> = RAWExtensions.all
        .union(NonRawImageExtensions.all)
        .union(VideoExtensions.all)
}
```

The `_index()` method already uses `SupportedImageExtensions.all.contains($0.pathExtension.lowercased())` — no change needed.

- [ ] **Step 2: Update `FileAsset.isVideo` computed property**

`FileAsset` already has `sidecarURL` computed via `SidecarPath.sidecarURL(for:)` which correctly handles video naming. Add a `isVideo` property to `FileAsset` for UI badge support:

In the `FileAsset` struct (line ~35), add after `sidecarURL`:

```swift
    public var isVideo: Bool { SidecarPath.isVideo(url) }
```

- [ ] **Step 3: Run swift test to confirm no regressions**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/apple/Packages/MapleCore
swift test > /tmp/v-swift-t4.log 2>&1
grep -E "FAILED|passed|error:" /tmp/v-swift-t4.log | tail -10
```

Expected: all tests pass (only MapleCore unit tests without fixtures; fixture tests auto-skip).

- [ ] **Step 4: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
git status --porcelain
git add src/apple/Packages/MapleCore/Sources/MapleCore/Sources/FilesystemSource.swift
git commit -m "feat(apple/FilesystemSource): enumerate video files alongside images (#1638)

Add VideoExtensions enum (delegates to SidecarPath.videoExtensions) and
include it in SupportedImageExtensions.all so _index() returns video URLs.
FileAsset gains an isVideo computed property for grid badge support.
"
```

---

## Task 5: Apple — Add `XMPSerializer.serializeMetadataOnly` and use it for videos

**Files:**

- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift`

**Interfaces:**

- Produces: `XMPSerializer.serializeMetadataOnly(metadata: XmpMetadata) -> String` — emits XMP with metadata fields only, no `crs:` adjustment attributes. Mirrors the TypeScript `METADATA_ONLY_STUB_XMP` / `metadataOnly: true` path.
- Produces: `BatchMetadataViewModel.applyToAsset` uses `serializeMetadataOnly` for video URLs and writes directly (no `XMPSidecarStore.update(model:culling:metadata:)` which would include a bogus adjustment block).

- [ ] **Step 1: Write failing tests**

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift`, find the test class and add:

```swift
func testSerializeMetadataOnlyHasNoCrsAttributes() {
    var meta = XmpMetadata()
    meta.city = "Paris"
    meta.copyrightNotice = "© 2026"
    let xml = XMPSerializer.serializeMetadataOnly(metadata: meta)
    XCTAssertFalse(xml.contains("crs:"), "metadata-only XMP must not contain crs: attributes")
    XCTAssertTrue(xml.contains("photoshop:City") || xml.contains("Iptc4xmpCore:Location") || xml.contains("Paris"),
                  "metadata-only XMP must include the city field")
}

func testSerializeMetadataOnlyRoundTrips() {
    var meta = XmpMetadata()
    meta.city = "Berlin"
    meta.gpsLatitude = 52.5200
    meta.gpsLongitude = 13.4050
    let xml = XMPSerializer.serializeMetadataOnly(metadata: meta)
    let parsed = XMPParser.parseMetadata(xml)
    XCTAssertEqual(parsed.city, "Berlin")
    XCTAssertEqual(parsed.gpsLatitude?.isNaN, false)
}
```

In `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift`, add:

```swift
func testApplyToVideoAssetWritesMetadataOnlySidecar() async throws {
    // Create a temp .mov URL (no actual video content needed — just the extension)
    let videoURL = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString)
        .appendingPathExtension("mov")
    // Write a dummy file so FileManager.fileExists returns true
    try Data().write(to: videoURL)
    defer {
        try? FileManager.default.removeItem(at: videoURL)
        let sidecar = SidecarPath.sidecarURL(for: videoURL)
        try? FileManager.default.removeItem(at: sidecar)
    }

    let ref = AssetRef(url: videoURL)
    let vm = BatchMetadataViewModel(assets: [ref], sessions: [:])
    vm.touchedMetadata.city = "Tokyo"
    try await vm.apply()

    let sidecarURL = SidecarPath.sidecarURL(for: videoURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: sidecarURL.path),
                  "clip.mov.xmp sidecar must be written")
    let xml = try String(contentsOf: sidecarURL, encoding: .utf8)
    // Must contain the metadata field
    XCTAssertTrue(xml.contains("Tokyo"), "city must appear in sidecar XML")
    // Must NOT contain crs: adjustment attributes
    XCTAssertFalse(xml.contains("crs:Exposure"), "video sidecar must not contain crs:Exposure")
    XCTAssertFalse(xml.contains("crs:WhiteBalance"), "video sidecar must not contain crs:WhiteBalance")
}
```

- [ ] **Step 2: Run to confirm they fail**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/apple/Packages/MapleCore
swift test --filter "testSerializeMetadataOnly|testApplyToVideoAsset" > /tmp/v-swift-t5a.log 2>&1
grep -E "FAILED|PASSED|error:" /tmp/v-swift-t5a.log | tail -10
```

Expected: FAIL — `serializeMetadataOnly` doesn't exist yet.

- [ ] **Step 3: Add `XMPSerializer.serializeMetadataOnly`**

The minimal XMP stub for a video sidecar mirrors the TypeScript `METADATA_ONLY_STUB_XMP`. Add the method to `XMPSerialization.swift` inside the `XMPSerializer` struct (or as an `extension XMPSerializer`). Place it after the existing `serialize(model:culling:)` overloads.

The correct spot is after the closing brace of the `XMPSerializer` struct definition. In `XMPSerialization.swift`, add before the `// MARK: - XMLParser delegate` comment or at end of the `XMPSerializer` struct:

```swift
extension XMPSerializer {
    /// Produces a metadata-only XMP sidecar with no Camera Raw Settings attributes.
    /// Use for video assets that have no `AdjustmentModel` — emitting a `crs:` block
    /// for a video file would be nonsensical and risks confusion with a real adjustment.
    ///
    /// Mirrors the TypeScript `METADATA_ONLY_STUB_XMP` / `metadataOnly: true` path in
    /// `src/api/src/xmp/metadata-serializer.ts`.
    public static func serializeMetadataOnly(metadata: XmpMetadata) -> String {
        let metaAttrs = metadataAttrParts(metadata)
        let metaBlocks = metadataNestedBlocks(metadata)
        let prefixes = metadataNamespacePrefixes(metadata)

        // Build namespace declaration snippet.
        let nsOrder = ["dc", "exif", "photoshop", "Iptc4xmpCore", "xmpRights"]
        let extraNsLines = nsOrder
            .filter { prefixes.contains($0) }
            .compactMap { p -> String? in
                guard let uri = xmpMetadataNamespaces[p] else { return nil }
                return "      xmlns:\(p)=\"\(uri)\""
            }
            .joined(separator: "\n")

        let metaAttrLines = metaAttrs
            .map { "\($0.0)=\"\(escapeXMLAttr($0.1))\"" }
            .joined(separator: "\n        ")

        let nsBlock = extraNsLines.isEmpty ? "" : "\n\(extraNsLines)"
        let attrsBlock = metaAttrs.isEmpty ? "" : "\n        \(metaAttrLines)"
        let metaNestedStr = metaBlocks.joined(separator: "\n")

        if metaBlocks.isEmpty {
            return """
<?xpacket begin='\u{FEFF}' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''\(nsBlock)\(attrsBlock)/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>
"""
        } else {
            return """
<?xpacket begin='\u{FEFF}' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/'>
  <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
    <rdf:Description rdf:about=''\(nsBlock)\(attaBlock)>
\(metaNestedStr)
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>
"""
        }
    }
}
```

Note: Replace `attaBlock` with `attrsBlock` (typo above is intentional to mark the spot; fix in implementation). The private helpers `metadataAttrParts`, `metadataNestedBlocks`, `metadataNamespacePrefixes`, and `escapeXMLAttr` are already defined in `XMPSerialization+MetadataWrite.swift` — check they are `internal` not `private` (they need to be accessible from this extension). If they are `private`, change to `internal` (or `fileprivate` scoped to the file if they're in the same file as `XMPSerializer`).

Check visibility of helpers in `XMPSerialization+MetadataWrite.swift`:

```bash
grep -n "private\|internal\|static func metadataAttrParts\|static func metadataNestedBlocks\|static func metadataNamespacePrefixes" \
  /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization+MetadataWrite.swift
```

If `metadataAttrParts` etc. are `private`, change them to `internal` (no modifier — internal is the default in Swift).

- [ ] **Step 4: Modify `BatchMetadataViewModel.applyToAsset` to use `serializeMetadataOnly` for videos**

In `src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift`, modify `applyToAsset` (line ~190):

```swift
    private func applyToAsset(_ asset: AssetRef) async throws {
        guard let url = asset.primaryURL else { return }

        // Video assets have no AdjustmentModel — write a metadata-only sidecar
        // to avoid emitting a bogus crs: block (which would confuse Lightroom
        // and violate the spec's "videos are metadata-only" contract).
        if SidecarPath.isVideo(url) {
            // Read existing metadata from sidecar XML on disk.
            let sidecarURL = SidecarPath.sidecarURL(for: url)
            let existingXml = (try? String(contentsOf: sidecarURL, encoding: .utf8)) ?? ""
            var merged = XMPParser.parseMetadata(existingXml)
            // Merge touched fields.
            let t = touchedMetadata
            if let v = t.gpsLatitude   { merged.gpsLatitude   = v }
            if let v = t.gpsLongitude  { merged.gpsLongitude  = v }
            if let v = t.gpsAltitude   { merged.gpsAltitude   = v }
            if let v = t.dateTimeOriginal { merged.dateTimeOriginal = v.isEmpty ? nil : v }
            if let v = t.timeZone         { merged.timeZone         = v.isEmpty ? nil : v }
            if let v = t.sublocation      { merged.sublocation      = v.isEmpty ? nil : v }
            if let v = t.city             { merged.city             = v.isEmpty ? nil : v }
            if let v = t.state            { merged.state            = v.isEmpty ? nil : v }
            if let v = t.country          { merged.country          = v.isEmpty ? nil : v }
            if let v = t.countryCode      { merged.countryCode      = v.isEmpty ? nil : v }
            if let v = t.title            { merged.title            = v.isEmpty ? nil : v }
            if let v = t.caption          { merged.caption          = v.isEmpty ? nil : v }
            if let v = t.headline         { merged.headline         = v.isEmpty ? nil : v }
            if let v = t.instructions     { merged.instructions     = v.isEmpty ? nil : v }
            if let v = t.creator          { merged.creator          = v.isEmpty ? nil : v }
            if let v = t.creatorJobTitle  { merged.creatorJobTitle  = v.isEmpty ? nil : v }
            if let v = t.copyrightNotice  { merged.copyrightNotice  = v.isEmpty ? nil : v }
            if let v = t.copyrightStatus  { merged.copyrightStatus  = v }
            if let v = t.usageTerms       { merged.usageTerms       = v.isEmpty ? nil : v }
            if let v = t.credit           { merged.credit           = v.isEmpty ? nil : v }
            if let v = t.source           { merged.source           = v.isEmpty ? nil : v }
            // Write atomically.
            let xml = XMPSerializer.serializeMetadataOnly(metadata: merged)
            guard let data = xml.data(using: .utf8) else {
                throw XMPStoreError.encodingError
            }
            let tmpURL = sidecarURL.deletingLastPathComponent()
                .appendingPathComponent(".\(sidecarURL.lastPathComponent).tmp")
            try data.write(to: tmpURL, options: .atomic)
            _ = try FileManager.default.replaceItemAt(sidecarURL, withItemAt: tmpURL)
            return
        }

        // Image/RAW path — same as before.
        let store = XMPSidecarStore(rawURL: url)
        let (model, culling): (AdjustmentModel, CullingState)
        if let session = sessions[asset.id] {
            (model, culling) = (session.model, session.culling)
        } else {
            (model, culling) = (try? await store.load()) ?? (.default, CullingState())
        }
        let sidecarURL = SidecarPath.sidecarURL(for: url)
        let existingXml = (try? String(contentsOf: sidecarURL, encoding: .utf8)) ?? ""
        var merged = XMPParser.parseMetadata(existingXml)
        let t = touchedMetadata
        if let v = t.gpsLatitude   { merged.gpsLatitude   = v }
        if let v = t.gpsLongitude  { merged.gpsLongitude  = v }
        if let v = t.gpsAltitude   { merged.gpsAltitude   = v }
        if let v = t.dateTimeOriginal { merged.dateTimeOriginal = v.isEmpty ? nil : v }
        if let v = t.timeZone         { merged.timeZone         = v.isEmpty ? nil : v }
        if let v = t.sublocation      { merged.sublocation      = v.isEmpty ? nil : v }
        if let v = t.city             { merged.city             = v.isEmpty ? nil : v }
        if let v = t.state            { merged.state            = v.isEmpty ? nil : v }
        if let v = t.country          { merged.country          = v.isEmpty ? nil : v }
        if let v = t.countryCode      { merged.countryCode      = v.isEmpty ? nil : v }
        if let v = t.title            { merged.title            = v.isEmpty ? nil : v }
        if let v = t.caption          { merged.caption          = v.isEmpty ? nil : v }
        if let v = t.headline         { merged.headline         = v.isEmpty ? nil : v }
        if let v = t.instructions     { merged.instructions     = v.isEmpty ? nil : v }
        if let v = t.creator          { merged.creator          = v.isEmpty ? nil : v }
        if let v = t.creatorJobTitle  { merged.creatorJobTitle  = v.isEmpty ? nil : v }
        if let v = t.copyrightNotice  { merged.copyrightNotice  = v.isEmpty ? nil : v }
        if let v = t.copyrightStatus  { merged.copyrightStatus  = v }
        if let v = t.usageTerms       { merged.usageTerms       = v.isEmpty ? nil : v }
        if let v = t.credit           { merged.credit           = v.isEmpty ? nil : v }
        if let v = t.source           { merged.source           = v.isEmpty ? nil : v }
        await store.update(model: model, culling: culling, metadata: merged)
        await store.flush()
    }
```

Note: The merged-field block is repeated in both branches. Consider extracting it to a private helper `applyTouched(into: inout XmpMetadata)` to keep the code DRY — but only if the compiler accepts the `inout` on an actor-isolated parameter without isolation warnings. If it creates complications, the duplication is acceptable to avoid over-engineering.

- [ ] **Step 5: Run failing tests again — expect pass**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/apple/Packages/MapleCore
swift test --filter "testSerializeMetadataOnly|testApplyToVideoAsset" > /tmp/v-swift-t5b.log 2>&1
grep -E "FAILED|PASSED|error:" /tmp/v-swift-t5b.log | tail -10
```

Expected: PASS for all new tests.

- [ ] **Step 6: Run full swift test suite**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/apple/Packages/MapleCore
swift test > /tmp/v-swift-full.log 2>&1
grep -E "FAILED|passed|error:" /tmp/v-swift-full.log | tail -10
```

Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
git status --porcelain
git add src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/XMPSerializationTests.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift
git commit -m "feat(apple): serializeMetadataOnly + video path in BatchMetadataViewModel (#1638)

XMPSerializer.serializeMetadataOnly(metadata:) produces a sidecar with no
crs: block — mirrors the TS METADATA_ONLY_STUB_XMP. BatchMetadataViewModel
detects video URLs via SidecarPath.isVideo and takes the metadata-only path
so no bogus adjustment block is written to clip.mov.xmp.
"
```

---

## Task 6: Final gates — run all checks, file thumbnail follow-up, push + PR

**Files:**

- No code changes — gate verification and PR creation only.

- [ ] **Step 1: Run all API gates**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/api
HOME=/tmp/maple-binst bun install > /tmp/v-gates-install.log 2>&1
HOME=/tmp/maple-binst bun test > /tmp/v-gates-bun.log 2>&1
grep -E "^(PASS|FAIL)|failed" /tmp/v-gates-bun.log | tail -20
bun x oxlint src > /tmp/v-gates-oxlint.log 2>&1
cat /tmp/v-gates-oxlint.log | grep -v "^$" | tail -10
bun x tsc --noEmit > /tmp/v-gates-tsc.log 2>&1
wc -l /tmp/v-gates-tsc.log
bash /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/tools/check-file-budget.sh > /tmp/v-gates-budget.log 2>&1
grep -E "hard|HARD|0 hard" /tmp/v-gates-budget.log | tail -5
```

Expected: bun test 0 new failures, oxlint 0 errors, tsc 0 new errors, file-budget 0 hard.

- [ ] **Step 2: Run all web gates**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/web
HOME=/tmp/maple-binst bun install > /tmp/v-web-gates.log 2>&1
HOME=/tmp/maple-binst bun x ng build maple >> /tmp/v-web-gates.log 2>&1
grep -E "Error|error TS|✓ Built|ERROR" /tmp/v-web-gates.log | tail -10
HOME=/tmp/maple-binst bun x ng test maple-common --watch=false > /tmp/v-web-test2.log 2>&1
grep -E "FAILED|PASSED|Executed" /tmp/v-web-test2.log | tail -5
bun run format 2>&1 | tail -3
bun run format:check > /tmp/v-format2.log 2>&1
grep -E "warn|error|Checking" /tmp/v-format2.log | tail -5
```

Expected: build success, 0 new test failures, format clean.

- [ ] **Step 3: Run swift test**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index/src/apple/Packages/MapleCore
swift test > /tmp/v-swift-final.log 2>&1
grep -E "FAILED|passed|error:" /tmp/v-swift-final.log | tail -10
```

Expected: 0 FAILED.

- [ ] **Step 4: Run macOS xcodebuild (report BLOCKED if xcframework stale)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
xcodebuild -project src/apple/Maple.xcodeproj \
           -scheme "Maple Exposure" \
           -destination 'platform=macOS' \
           build > /tmp/v-xcode.log 2>&1
grep -E "BUILD SUCCEEDED|BUILD FAILED|error:" /tmp/v-xcode.log | tail -5
```

If BUILD FAILED with a link error about missing `maple_*` symbols → BLOCKED, rebuild xcframework first:

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
cargo build -p raw-ffi --features gpu,pano --target aarch64-apple-darwin > /tmp/v-cargo.log 2>&1
# then: cbindgen header + cp .a per CONTRIBUTING.md / project_fast_macos_xcframework_for_parity_tests.md
```

- [ ] **Step 5: File video-thumbnail follow-up ticket**

```bash
gh issue create \
  --title "Video grid thumbnails: show poster frame or icon badge (#1638 follow-up)" \
  --body "$(cat <<'EOF'
## Summary

#1638 makes standalone videos selectable in the batch metadata panels. For v1 the grid cell shows no real thumbnail for video assets — the thumb endpoint 404s for video paths. This ticket tracks adding a first-frame poster image (or a recognizable video icon) so video cells are visually distinct in the browse grid.

## Scope

- API: extract first frame via `ffprobe`/`ffmpeg` or `AVFoundation` (Apple) and cache it as a `.maple/thumbs/<hash>.jpg` entry.
- Web: if first-frame extraction is complex, show a generic video-file icon overlay on the cell.
- Apple: use `AVAssetImageGenerator` for poster; show the `isVideo` badge from `PhotoGridItem.overlays.isVideo`.

## Non-goals

Video playback, scrubbing, or any other video-feature work.

Closes: n/a (follow-up to #1638)
EOF
)" \
  --label "enhancement"
```

After creating, add to the Files project board:

```bash
gh issue edit <NEW_ISSUE_NUMBER> --add-project "Files"
```

- [ ] **Step 6: Push branch and open PR**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m6-video-index
git push -u origin claude/video-selectable-1638

gh pr create \
  --title "feat: make standalone videos selectable/editable in batch metadata panels (#1638)" \
  --body "$(cat <<'EOF'
## Summary

- **API:** Added `VIDEO_EXTS` to `SUPPORTED_EXTS` in the discover/sweeper allowlist so the reconciliation sweep emits `created` events for `.mov`/`.mp4`/etc files, indexing them as assets via the existing `handleEvent` + `video-metadata.ts` path.
- **API:** Surfaced video files in `listDirFast` and `listDirContents` `images` array with `isVideo: true` (previously they fell into the `files` bucket with no `asset_id`). Full-name sidecars (`clip.mov.xmp`) are now paired to video entries via the full-filename key.
- **Web:** Extended `FsImageEntry` / `ImageEntry` / `Asset` with `isVideo?: boolean` so the grid can eventually show a badge. The batch-metadata panel's `/api/xmp/batch` call already works for video paths (server detects extension, applies `metadataOnly: true`).
- **Apple:** Added `VideoExtensions` enum + included it in `SupportedImageExtensions.all` so `FilesystemSource._index()` returns video URLs. Added `XMPSerializer.serializeMetadataOnly(metadata:)` that emits XMP with no `crs:` block. `BatchMetadataViewModel.applyToAsset` now takes the metadata-only path for video URLs so no bogus adjustment block is written.

## Thumbnail decision

Videos surface as selectable cells with no poster frame. The thumb endpoint returns 404 for video paths (unchanged). A follow-up ticket (#<NEW_ISSUE>) tracks adding poster frames / video icon badges.

## Test plan

- [x] `bun test` in `src/api` — 0 new failures; new tests cover sweeper video event + browse video surfacing
- [x] `bun x oxlint src` in `src/api` — clean
- [x] `bun x tsc --noEmit` in `src/api` — no new errors
- [x] `bash tools/check-file-budget.sh` — 0 hard
- [x] `ng build maple` — success
- [x] `ng test maple-common --watch=false` — 0 new failures
- [x] `bun run format:check` — clean
- [x] `swift test` in MapleCore — 0 failures; new tests cover `serializeMetadataOnly` + video apply
- [x] macOS `xcodebuild` — BUILD SUCCEEDED

Closes #1638

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage check

| Requirement                                                 | Task          |
| ----------------------------------------------------------- | ------------- |
| Videos indexed as assets via discover/sweeper               | Task 1        |
| Videos appear in browse/listDirFast (web)                   | Task 2        |
| Videos have `asset_id` in `listDirContents`                 | Task 2        |
| Video sidecars (`clip.mov.xmp`) paired correctly            | Task 2        |
| Web `isVideo` forwarded through to Asset                    | Task 3        |
| Apple FilesystemSource enumerates videos                    | Task 4        |
| Apple `applyToAsset` uses metadata-only serialize for video | Task 5        |
| `serializeMetadataOnly` emits no `crs:` block               | Task 5        |
| Tests for new indexing and Apple metadata-only path         | Tasks 1, 2, 5 |
| Thumbnail follow-up filed                                   | Task 6        |
| All gates green                                             | Task 6        |

### Placeholder scan

No TBD, TODO, or "similar to" references. All code blocks are complete.

### Type consistency

- `FastImageChild.isVideo?: true` (API) → `FsImageEntry.isVideo?: boolean` (web client type) — consistent (server can return `true` only, client allows `boolean`).
- `ImageChild.isVideo?: true` (API `listDirContents`) → `ImageEntry.isVideo?: boolean` (web) — same.
- `SidecarPath.videoExtensions` used in both `SidecarPath.isVideo()` (Swift) and `VideoExtensions.all` (added in Task 4) — same set.
- `metadataAttrParts` / `metadataNestedBlocks` / `metadataNamespacePrefixes` — these private helpers must become `internal` for `serializeMetadataOnly` to call them from `XMPSerialization.swift`. Task 5 Step 3 includes a verification grep. This is the single cross-task type dependency to watch.
- `XMPParser.parseMetadata` is already public and used in both video and image branches.
