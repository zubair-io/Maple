# Batch Metadata M5 — Video Support

This plan is organised task-by-task. Each task has a clear scope, the files it touches, and a test requirement. Tasks are designed to be committed atomically.

## Background & decision log

### Sidecar naming: FULL-NAME for videos (`clip.mov.xmp`), stem-swap for images (`clip.xmp`)

> **Revised after review.** An earlier draft of this plan chose same-stem
> (`clip.mov → clip.xmp`). That is unsafe: it silently misattributes a video's
> metadata to a co-named photo. The COMMON trigger is Apple Live Photos —
> `IMG_1234.HEIC` + `IMG_1234.MOV` are two independent same-stem assets (Maple
> has no companion-pairing in the schema for them). Under stem-swap both resolve
> to `IMG_1234.xmp` and fight over one file; the browse layer pairs that `.xmp`
> to the image only, so editing the video's metadata can never work whenever a
> same-stem image exists. The fix is the industry-standard full-name convention.

- **Images** keep stem-swap: `IMG_1.ARW → IMG_1.xmp` (unchanged; existing photo
  sidecars are NOT migrated).
- **Videos** keep their extension: `clip.mov → clip.mov.xmp`.

Because the two conventions produce different bases (`clip` vs `clip.mov`), a
Live Photo's still and motion clip get their own separate sidecars and can never
clobber each other.

### Single source of truth

`xmpSidecarPath()` in `src/api/src/fs/xmp.ts` branches on `isVideoFilename()`
(from `src/api/src/indexer/media-types.ts`) — videos return `rawAbsPath + '.xmp'`,
everything else keeps the stem-swap. Most call sites (the `sidecar-metadata-index`
stage, the `xmp-batch` route, conflict-copy helpers) inherit the fix automatically.
`canonicalBaseFromSidecarFilename()` in `browse.ts` is the inverse: it strips only
the trailing `.xmp`, so `clip.mov.xmp → clip.mov` (pairs to the video by full name)
and `IMG_1.xmp → IMG_1` (pairs to the image by stem).

### What currently breaks for videos (pre-M5)

`src/api/src/imports/scan.ts` `pair()` only indexed **images**, so a video
sidecar was orphaned on every import. And under stem-swap a video sidecar named
`clip.xmp` would be attached to a same-stem photo — the misattribution above.

### The M5 pairing fix

`pair()` (scan.ts) and `groupFiles()` (worker.ts) index every primary by the key
its sidecar resolves to: images by stem, videos by full filename. With distinct
keys there is no collision and no two-pass image-wins handling is needed. The
browse pairing skips a sidecar whose base is itself a video name (it has no
indexed standalone asset to surface an `asset_id` for).

### Apple

Seven Swift sidecar-derivation sites all did
`deletingPathExtension().appendingPathExtension("xmp")` (stem-swap for any type).
They are now routed through one shared helper `SidecarPath.sidecarURL(for:)` in
MapleCore, which mirrors `xmpSidecarPath()` — full-name for videos, stem-swap
otherwise — so a clip edited on Web and on Apple targets the SAME `.xmp` file.

### Selectability (out of scope for #1635 — follow-up filed)

Standalone videos are NOT indexed as assets today (`SUPPORTED_EXTS` in
`workers/discover/types.ts` excludes video extensions; the Apple
`FilesystemSource._index()` filters to `SupportedImageExtensions`). So a
standalone video cannot yet be SELECTED in either the web M2 panel or the Apple
M4 panel — both operate on indexed assets. This round delivers the
naming/pairing infrastructure (Live-Photo-safe, parity across API + Apple) and
the path-based batch-write route already writes video sidecars correctly. Making
standalone videos selectable requires indexing them as assets — a larger change
tracked as follow-up #1638.

---

## Tasks

### Task 1 — Scanner: pair sidecars to movies (API)

**File:** `src/api/src/imports/scan.ts`

Remove the `if (it.kind !== 'image') continue;` guard in `pair()`, replacing it with logic that indexes ALL primaries (images and movies) by stem. A collision (rare) where `clip.jpg` and `clip.mov` coexist: the image wins because images appear first in the sorted `items` array (classified as `image` before `movie` in `classify()`). This is acceptable and mirrors the existing behaviour for images.

**Changes:**

- In `pair()`, remove the `kind !== 'image'` guard. Index every primary by stem.
- Add a comment explaining the movie-sidecar pairing rationale.

**Tests (scan.test.ts):**

- Add a `clip.mov.xmp` (`clip.xmp`) sidecar in the existing temp dir and assert it pairs to `clip.mov`, not as orphan. `sidecarCount` should increase; `orphans` should not include it.
- Add a regression test: when both `clip.jpg` and `clip.mov` coexist with a `clip.xmp`, the sidecar attaches to `clip.jpg` (image wins — first indexed).

### Task 2 — Import worker: pair sidecars to movies (API)

**File:** `src/api/src/imports/worker.ts` — `groupFiles()` function

The same pairing deficiency exists in the import worker. `groupFiles()` maps primaries by `${dir} ${stem}` but the comment says it pairs by "image". Verify if movies are excluded; if so, remove the guard.

**File:** `src/api/src/imports/worker.test.ts`

Add test: sidecar attaches to a movie in `groupFiles()`.

### Task 3 — Sidecar-metadata-index: video passthrough (API)

**File:** `src/api/src/workers/stages/sidecar-metadata-index.ts`

The stage uses `xmpSidecarPath(absPath)` which works for any file. It is **already media-agnostic**. No code change needed — but add a test proving a video asset with a metadata-only sidecar produces a valid `metadata_override`.

**File:** `src/api/src/workers/stages/sidecar-metadata-index.test.ts` (new)

Test cases:

1. Video asset (`.mov` extension) with metadata-only sidecar → returns `{ patch: { metadata_override: {...} } }`.
2. Video asset with no sidecar → returns `{ skip: 'no-sidecar' }`.
3. Video asset with adjustment-only sidecar (no metadata) → returns `{ skip: 'no-metadata' }`.

### Task 4 — Metadata-only XMP: TS writer emits valid sidecar for empty adjustment block (API/Web)

**File:** `src/api/src/xmp/metadata-serializer.ts` — `mergeMetadataIntoXmp()`

When called with an empty `existingXml` and only metadata fields (no adjustment block), the function must produce a valid XMP sidecar that:

- Has the standard `x:xmpmeta`, `rdf:RDF`, `rdf:Description` structure.
- Contains the metadata namespace declarations.
- Contains NO `papp:` adjustment attributes.
- Round-trips through `parseXmpMetadata()` correctly.

Verify existing behavior with a unit test — if `mergeMetadataIntoXmp('')` currently embeds a stub adjustment block (the `papp:` namespace + zero-value attributes), we need to understand whether that's acceptable or if it creates noise for video assets. If it creates adjustment noise, we need a `mergeMetadataOnly()` variant or a `metadata-only` flag.

After investigation: `mergeMetadataIntoXmp` delegates to `XMPSerializer.serialize()` for the base, which always includes the full adjustment block. For videos we should NOT emit adjustment attributes. Solution: check if `existingXml` already has a recognisable adjustment block; if not AND if the call is explicitly metadata-only, use the metadata-only path.

The simplest approach: add an optional `metadataOnly: boolean` option to `mergeMetadataIntoXmp`. When true, the base XMP is built from a minimal template (no adjustment attrs). When false (default), existing behaviour is preserved.

**File:** `src/api/src/xmp/metadata-serializer.test.ts`

Add tests:

1. `mergeMetadataIntoXmp('', { gpsLatitude: 37.7 }, { metadataOnly: true })` → output has no `papp:` namespace, contains `exif:GPSLatitude`.
2. Round-trip: `parseXmpMetadata(mergeMetadataIntoXmp('', meta, { metadataOnly: true }))` returns the original fields.

**File:** `src/api/src/routes/xmp-batch.ts`

The batch route calls `mergeMetadataIntoXmp(existingXml, entry.metadata)`. For video assets, `existingXml` will be empty (or a metadata-only sidecar). The route needs to detect video paths and pass `metadataOnly: true` when:

- `existingXml` is empty (new sidecar for any asset) AND the asset is a video file.
- `existingXml` is a metadata-only sidecar (no `papp:` block).

Detection: check the asset file extension using `VIDEO_EXTS` from `indexer/media-types.ts`.

### Task 5 — Web UI: include video assets in batch metadata panel

**File:** `src/web/projects/maple-common/src/lib/shells/browse-shell/browse-shell.component.ts`

`onEditMetadata()` currently calls `assets.flatMap(a => ...)` with a path guard. This already includes all assets in the selection — no filtering by kind. However, the `AssetMetadataSnapshot.metadata` only populates `gpsLatitude`, `gpsLongitude`, `city`, `country`, `title`, `keywords` from the asset model. For video assets these come from the server's `effectiveMetadata` resolver (which reads `metadata_override ?? exif`). No web UI change needed for video inclusion — videos are already selectable in the grid and will flow through `onEditMetadata()` if selected.

**Verification:** Confirm the `assetsInSelectedFolder()` includes video assets (check `library-state.service.ts` / `library-store.service.ts`). If videos are filtered out of the folder listing at the state layer, add them. Otherwise no change needed.

### Task 6 — Web batch panel: snapshot video metadata from server (Web)

When snapshots are populated in `onEditMetadata()`, the current code only reads from the client-side asset model (`a.gps?.lat`, `a.city`, etc.). For video assets, the existing XMP metadata (dateTimeOriginal, timeZone, all IPTC fields) is not in the client asset model. Since M2 snapshots are a display hint only (the actual per-asset value is read from the sidecar on write), this is acceptable for v1 — the panel will show blank fields for video assets with existing metadata, but the write will correctly MERGE rather than overwrite. Add a code comment noting this limitation and file a follow-up ticket.

### Task 7 — API tests: full suite passes (API)

Run `cd src/api && HOME=/tmp/maple-binst bun install && HOME=/tmp/maple-binst bun test`.

### Task 8 — Web build + tests pass (Web)

Run `cd src/web && HOME=/tmp/maple-binst bun install && bun x ng build maple && bun x ng test Maple-common --watch=false`.

### Task 9 — Apple (no code changes needed — verify)

`BatchMetadataViewModel.applyToAsset()` derives `sidecarURL` from `primaryURL` using `deletingPathExtension().appendingPathExtension("xmp")` — works for `.mov` already. The `XMPSidecarStore` and `XMPSerializer.serialize(model:culling:metadata:)` work for any URL. No Swift code changes needed.

Run `cd src/apple/Packages/MapleCore && swift test`.

---

## File change summary

| File                                                           | Change                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/api/src/imports/scan.ts`                                  | Remove image-only guard in `pair()` — index all primaries by stem               |
| `src/api/src/imports/scan.test.ts`                             | Add video sidecar pairing tests                                                 |
| `src/api/src/imports/worker.ts`                                | Remove image-only guard in `groupFiles()` if present                            |
| `src/api/src/imports/worker.test.ts`                           | Add video sidecar pairing test in `groupFiles()`                                |
| `src/api/src/workers/stages/sidecar-metadata-index.test.ts`    | New — video passthrough tests                                                   |
| `src/api/src/xmp/metadata-serializer.ts`                       | Add `metadataOnly` option to `mergeMetadataIntoXmp`                             |
| `src/api/src/xmp/metadata-serializer.test.ts`                  | Add metadata-only sidecar emission tests                                        |
| `src/api/src/routes/xmp-batch.ts`                              | Pass `metadataOnly: true` when path is a video and no existing adjustment block |
| `docs/superpowers/plans/2026-06-28-batch-metadata-m5-video.md` | This plan                                                                       |

Apple and web files: no changes required (verified by assessment above).

---

## Gate checklist

- [ ] `cd src/api && HOME=/tmp/maple-binst bun test` — 0 new failures
- [ ] `bun x oxlint src` — clean
- [ ] `bun x tsc --noEmit` — no new errors
- [ ] `bash tools/check-file-budget.sh` — 0 hard
- [ ] `cd src/web && bun x ng build maple` — clean
- [ ] `bun x ng test Maple-common --watch=false` — 0 new failures
- [ ] `bun run format:check` — clean
- [ ] `cd src/apple/Packages/MapleCore && swift test` — 0 new failures
