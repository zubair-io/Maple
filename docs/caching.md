# Caching Architecture

Maple has five distinct cache layers, each serving a different access pattern. Together they ensure that browsing is instant, editing is responsive, and reopening a previously-edited image shows pixels in ~0ms.

Every cache that stores a _rendered_ artifact shares one invalidation signal: `PIPELINE_OUTPUT_VERSION`, a single monotonic version of the develop pipeline's output that is single-sourced in raw-core and mirrored into Swift and TypeScript by codegen. Each rendered-output cache folds it into its key, so that one bump in raw-core invalidates stale entries across every platform at once. Two caches key on it today — the Web Hosted thumbnail cache (#1927, via `THUMB_PIPELINE_VERSION`) and Apple's rendered-preview cache (#1928, §3 below) — replacing the hand-maintained per-cache version integers those used to carry. See `docs/pipeline-output-version.md` for the bump policy and how it relates to `wb_scale_version`.

---

## Cache Layers at a Glance

| #   | Cache                  | Location                          | Format         | Lifetime                                   | Purpose                                       |
| --- | ---------------------- | --------------------------------- | -------------- | ------------------------------------------ | --------------------------------------------- |
| 1   | In-memory thumbnails   | `ThumbnailLoader.memoryCache`     | `CGImage`      | App session                                | Instant grid cell rendering                   |
| 2   | On-disk thumbnails     | `.maple/thumbs/` next to photos   | JPEG q=0.8     | Travels with photos                        | Survives app restarts, external drive moves   |
| 3   | Rendered preview cache | `.maple/previews/` next to photos | JPEG q=0.90    | Travels with photos; 20-entry memory front | Instant cold-open of previously-edited images |
| 4   | Decoded CIImage        | `EditSession.decodedImage`        | CIImage (lazy) | Single editing session                     | Avoids re-decoding RAW on every slider change |
| 5   | SMB file data          | `EditSession.cachedFileData`      | Raw `Data`     | Single editing session                     | Avoids re-downloading ~35MB over network      |

---

## 1. In-Memory Thumbnail Cache

```
ThumbnailLoader (actor)
  └── memoryCache: LRUCache<String, CGImage>
        capacity: 500 entries
        key: "{assetID}_{maxDimension}"   e.g. "file:///Photos/IMG_001.CR3_280"
        eviction: timestamp-based LRU on insert over capacity
```

**Read path:** Grid cells call `viewModel.thumbnail(for:size:source:)` → `ThumbnailLoader.thumbnail(...)` → LRU lookup. O(1), no disk I/O.

**Write path:** After a source thumbnail load completes, the result is stored via `cacheInMemory(key:image:)`. After an edit saves, `ThumbnailLoader.prime(assetID:size:image:)` injects the regenerated thumbnail directly.

**Invalidation:** `invalidate(assetID:)` removes all size variants for an asset. Called when a thumbnail is regenerated after editing.

**Memory pressure:** `handleMemoryPressure()` shrinks to 25% of capacity by evicting oldest entries.

---

## 2. On-Disk Thumbnail Cache

```
/Volumes/Photos/France/
  ├── IMG_001.CR3
  ├── IMG_002.DNG
  └── .maple/
      └── thumbs/
          ├── IMG_001.CR3.jpg    (JPEG, ~50-100KB)
          └── IMG_002.DNG.jpg
```

**Location:** `{photo_directory}/.maple/thumbs/{original_filename}.jpg`

**Read path:** `FilesystemSource.thumbnail(for:size:)` checks disk cache before extracting from the RAW file. Stale check: if the original file's modification date is newer than the cached thumbnail, the cache is treated as a miss.

**Write path:**

- First extraction: `ThumbnailDiskCache.write(for:image:)` after source extraction
- After editing: `EditSession.regenerateThumbnail(for:)` writes the processed thumbnail to disk so edits are reflected in the grid

**Why **`**.maple/**`**?** The thumbnails travel with the photos. Copy the folder to another Mac or external drive and thumbnails come along — no re-extraction needed.

**SMB/PhotoKit:** Disk thumbnail cache is only used for local filesystem sources. SMB and PhotoKit sources generate thumbnails on demand.

---

## 3. Rendered Preview Disk Cache

```
<photos>/.maple/previews/
  ├── a1b2c3d4e5f6a7b8.jpg
  ├── c9d0e1f2a3b4c5d6.jpg
  └── ...
```

Implemented by `RenderedPreviewCache` (`src/apple/.../Cache/RenderedPreviewCache.swift`). Stored **next to the photos** in the same `.maple/` folder as the thumbnail cache (§2) — not the OS cache directory — so a developed preview travels with the images when the folder is copied to another Mac or drive. The folder is set per open folder via `configure(folderURL:)`.

**Key:** `"{urlHash}_{variantHash}.jpg"`, where `urlHash = SHA256(primary_url)`'s first 16 hex chars and `variantHash = SHA256( "{primary_mtime_ms}_{sidecar_mtime_ms}_{screen_width}_v{view_transform_version}_pv{pipeline_output_version}" )`'s first 16 bytes (32 hex chars). The `urlHash` is kept as a literal prefix (not folded into `variantHash`) so `invalidate(assetURL:)` can match every screen-width variant of an asset by prefix. The six components:

- `primary_url` hash — identifies the asset.
- `primary_mtime_ms` — the primary RAW's own modification time. The JPEG is rendered from those pixels, so a bytes change that leaves the sidecar untouched (re-import, external sync, filesystem restore) must miss (#1928).
- `sidecar_mtime_ms` — the `.xmp` sidecar's modification time; `"0"` when absent. This is the **adjustment-version proxy** — any slider change rewrites the sidecar, bumping its mtime and thus the key, so a stale-adjustment entry is never served. There is no separate adjustment-JSON hash.
- `screen_width` — the size bucket. Previews are cached at **viewport resolution** (the fast-preview / fit target), not refined zoom resolution, so files stay small (~hundreds of KB) and match what cold-open shows.
- `view_transform_version` — the local Apple bump lineage: a per-instance constant whose value and bump history are documented inline in `RenderedPreviewCache.swift`.
- `pipeline_output_version` — the single, codegen-sourced `PIPELINE_OUTPUT_VERSION` (#1926), mirrored into Swift as `AdjustmentModel.pipelineOutputVersion` and into TypeScript for the Web thumb cache. This is the canonical bump point going forward: a raw-core pipeline-output change bumps this one constant and invalidates this cache and the Web thumb cache together (`_pv{version}` in the token).

**Format:** JPEG, quality 0.90, sRGB, encoded via `CIContext.jpegRepresentation` (always opaque — avoids the ImageIO "AlphaPremulLast" warning that fires when writing CGImages with alpha to JPEG).

**Read path:** `EditSession` cold-open hydration → `RenderedPreviewCache.preview(for:screenWidth:)`. A hit (memory front, then disk) returns a `CIImage` that seeds the canvas immediately — the user sees pixels without waiting on the RAW decode, which runs in the background. On the GPU-live path the equivalent seed is written back by `persistGpuFrameToPreviewCache()` (#1665).

**Write path:** `storePreview(_:for:screenWidth:)` via `persistCurrentPreviewToCache()` (CPU path) or the one-shot GPU-frame readback (GPU-live path), after the refine render lands. The encode + write runs on a detached utility-priority task to avoid blocking the main thread.

**Memory front:** an in-process dictionary of up to 20 most-recent `(CIImage, storedAt)` entries sits in front of the disk store; it evicts the oldest once full. The on-disk `.jpg` files are **not** swept on a byte budget — they are invalidated by key change (below), and the `.maple/` folder is managed alongside the thumbnail cache.

**Cache coherency:** no explicit content invalidation on edit — a slider change bumps `sidecar_mtime` (and a bytes change bumps `primary_mtime`), so the next lookup computes a new key and misses, landing on a fresh render. `invalidate(assetURL:)` exists for the explicit case (e.g. immediately after a sidecar write, before its mtime is observable) and removes every screen-width variant for the asset from both the memory front and disk.

---

## 4. Decoded CIImage (In-Memory)

```
EditSession
  └── decodedImage: CIImage?
        format: lazy CIImage backed by CIRAWFilter graph (not a bitmap)
        lifetime: one editing session
        cost to produce: ~300ms for 100MP RAW
```

The decoded CIImage is the most expensive artifact to produce and the most valuable to retain. It's decoded once per asset (always at neutral WB/exposure) and reused for every slider change. The CIImage itself is lazy — it represents a filter graph, not a materialized bitmap. Pixels are only computed when `CIContext.createCGImage()` is called during render.

**Cleared on:** `endEditing()`, asset switch, or app termination.

---

## 5. SMB File Data Cache

```
EditSession
  └── cachedFileData: Data?
        format: raw file bytes (the entire DNG/CR3/etc.)
        lifetime: one editing session
        typical size: 20-50MB for RAW
```

For SMB sources where there's no local file URL, the full file is downloaded once via `source.fullImageData(for: asset)` and cached in memory. Without this, every slider change that triggers a re-decode would re-download ~35MB over the network.

**Cleared on:** `endEditing()` or asset switch.

---

## Cache Flow Diagram

```
User opens image (cold — first time)
  │
  ├─ RenderedPreviewCache.read() → MISS
  │   └─ Decode RAW (~300ms, off main actor)
  │   └─ Render at viewport size → show preview
  │   └─ Refine (if zoomed) → persist to preview cache
  │
  ▼
User opens image (warm — previously edited)
  │
  ├─ RenderedPreviewCache.read() → HIT
  │   └─ Show cached JPEG instantly (~0ms)
  │   └─ Decode RAW in background (for slider readiness)
  │
  ▼
User drags slider
  │
  ├─ decodedImage is cached → skip decode
  ├─ pipeline.process() + renderPreview() → fast preview (~30ms)
  │
  ▼
User stops editing (idle 300ms)
  │
  ├─ Refine render (if zoomed) → higher-res preview
  ├─ persistCurrentPreviewToCache() → JPEG to ~/Library/Caches/
  │
  ▼
User closes image (endEditing)
  │
  ├─ Sidecar flushed → IMG_001.xmp
  ├─ regenerateThumbnail() → 560px CGImage
  │   ├─ ThumbnailDiskCache.write() → .maple/thumbs/IMG_001.CR3.jpg
  │   └─ onThumbnailRegenerated → ThumbnailLoader.prime() → in-memory update
  ├─ persistCurrentPreviewToCache() → disk preview cache
  └─ Clear decodedImage, cachedFileData, previewImage
  │
  ▼
User returns to grid
  │
  ├─ ThumbnailCell.onAppear detects stale tick → re-fetches from
  │   ThumbnailLoader → hits primed in-memory cache → shows edited thumbnail
```

---

## Clearing Caches

| Cache                | How to Clear                                                    | Effect                                           |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| In-memory thumbnails | `ThumbnailLoader.clearAll()` / memory pressure                  | Grid cells re-extract from source on next appear |
| On-disk thumbnails   | Delete `.maple/thumbs/` in photo directory                      | Thumbnails re-extracted on next browse           |
| Rendered previews    | `RenderedPreviewCache.clear()` or OS purges `~/Library/Caches/` | Cold-open of images takes ~300ms again           |
| Decoded CIImage      | Automatic on `endEditing()`                                     | Next edit session re-decodes                     |
| SMB file data        | Automatic on `endEditing()`                                     | Next edit session re-downloads                   |

---

## Web — Service Worker (Angular)

The Apple caches above have browser counterparts (in-memory blob URLs +
IndexedDB; see `LibraryCache`). On top of those, both web builds — Hosted
(`projects/maple-syrup`) and Self-Hosted (`projects/maple`) — register the
Angular service worker (`ngsw-config.json`, wired via `provideServiceWorker`).
It adds an HTTP-layer cache that the application code never has to manage.

### What the SW caches

| Group        | Type       | Strategy                 | Contents                                                                     |
| ------------ | ---------- | ------------------------ | ---------------------------------------------------------------------------- |
| `app`        | assetGroup | prefetch                 | App shell: `index.html`, `manifest.webmanifest`, all `*.js`/`*.css`, favicon |
| `raw-wasm`   | assetGroup | lazy + prefetch-upd      | `raw_wasm_bg.wasm`, `raw_wasm.js`                                            |
| `fonts`      | assetGroup | lazy + prefetch-upd      | Bundled webfonts                                                             |
| `images`     | assetGroup | lazy                     | Static bundle images (`/assets/**`, root `svg/png/webp/…`)                   |
| `thumbnails` | dataGroup  | performance (1500 / 30d) | Thumbnail **HTTP** responses: `/api/fs/thumb`, `/api/assets/*/thumb`         |

The `thumbnails` dataGroup is the SW-owned thumbnail cache. It only matches
HTTP thumbnail endpoints, which today means the **Self-Hosted** Bun API
(`/api/fs/thumb?path=…`, `/api/assets/:id/thumb?size=…`). On Hosted, thumbnails
are produced from File System Access reads / WASM decodes — those are not HTTP
requests, so a SW cannot intercept them; they keep the in-memory blob-URL +
`.maple/thumbs/` disk cache described above. `performance` = cache-first: a
cached thumbnail is served without touching the network, with an LRU cap of
1500 entries and a 30-day max age.

Library **data** APIs (`/api/fs/raw`, `/api/assets/:id/raw`, folder/asset
listings, auth) are deliberately _not_ cached — they always hit the server, so
MongoDB stays authoritative. `navigationUrls` also excludes `/api/**` so the SW
never serves the app shell in place of an API response.

### Background app updates

`AppUpdateService` (`maple-common/src/lib/sw/`) owns the update lifecycle:

1. The SW lazily downloads a freshly-deployed build in the background.
2. On `VERSION_READY`, `AppUpdateService` arms the update and shows the in-app
   install toast (`UpdateToastComponent`, rendered once by `RootShellComponent`).
3. "Install" → `activateUpdate()` + reload. Otherwise the update stays armed and
   the **next route change** triggers a hard `location.assign(target)` — a fresh
   client boots on the new version and still lands on the intended page.
4. A 30-min poll (`checkForUpdate`) catches deploys on long-lived tabs.

### Clearing the SW caches

| Cache              | How to Clear                                                  | Effect                             |
| ------------------ | ------------------------------------------------------------- | ---------------------------------- |
| SW thumbnails/data | DevTools → Application → Cache Storage (or unregister the SW) | Thumbnails re-fetched from the API |
| App shell / assets | Deploy a new build (update flow) or unregister the SW         | Next load fetches the new bundle   |

---

## Web Hosted — unedited-preview cache (`.maple/previews/`, #2010)

The "unedited preview" is the higher-resolution still the Preview screen swaps
in over the grid thumbnail (the camera-embedded JPEG a RAW already carries, at
1280 px long edge — **not** a re-render of the sensor data through the develop
pipeline). In **Hosted** (File System Access) mode this is produced client-side
and cached on disk next to the photos, following the canonical cross-platform
contract shared with the server and Apple app.

**Location:** `{photo_directory}/.maple/previews/{original_filename}.{ext}` plus
`{original_filename}.preview.json`. The `.maple/` folder sits in the asset's
**own** directory and the filename keeps its original extension
(`IMG_1234.CR2` → `IMG_1234.CR2.jpg` + `IMG_1234.CR2.preview.json`). The
descriptor records schema version, actual format/MIME, source identity, and
the artifact mtime used for cross-platform freshness reconciliation.
Keyed off **directory + filename**, not a content hash — a preview written by
Hosted lands in one predictable slot. The fixed `<filename>.avif` artifact
remains the cross-platform API/Apple contract; browser-native alternatives are
Hosted-private local cache files and do not travel over the wire.

**Derivation:** `EmbeddedPreviewService` (a dedicated Web Worker, separate from
the decode/live-render worker so it never contends with that worker's
single-in-flight-decode gate) calls the shared Rust core
`raw_core::preview::extract_embedded_preview` via the `raw-wasm`
`extract_embedded_preview` binding — the exact same extraction (rawler
preview/full/thumbnail-slot hunt + resize + baked EXIF orientation) the native
server/Apple preview tier uses, so the pixels match across platforms.

**Format decision — store what the browser actually produced.** The unedited
tier stores its already-sized extracted JPEG directly, avoiding a redundant
canvas transcode. Developed previews use genuine browser AVIF when available
and the existing high-quality JPEG encoder otherwise. The closed descriptor
registry also recognizes WebP and PNG for safe forward-compatible reads.
Extension, declared MIME, and byte signature must agree; arbitrary descriptor
paths and MIME types are rejected. This avoids a WASM AV1 encoder and never
writes JPEG or PNG bytes under an `.avif` name.

The display path is always the extracted JPEG (fast, universal); persistence is
a fire-and-forget side effect gated on a write-capable folder.

Implemented by `HostedPreviewResolver` (`lib/state/hosted-preview-resolver.service.ts`),
routed through `LibraryCache.subscribePreviewUrl`. Read/write-through helpers:
`MapleCacheService.readPreview` / `writePreview`. No `PIPELINE_OUTPUT_VERSION`
marker (contrast the thumb tier): a preview is a pure re-encode of the camera's
own embedded JPEG, never touching the develop pipeline, so a raw-core/AgX bump
can't stale it.

**Validation, invalidation, and migration:** writes publish the verified image
artifact first and its descriptor last. Reads require the descriptor's format,
MIME, signature, and exact RAW `size` + `lastModified` identity to agree. A
present corrupt/stale descriptor fails closed. When the descriptor is absent,
Hosted still reads legacy `<filename>.avif` plus its `.source.json` identity;
older API/Apple AVIF entries without that companion use the derivative-mtime
freshness rule. This preserves existing caches without allowing a corrupt new
entry to fall through to unrelated stale bytes. A canonical AVIF written by
Apple/API after a Hosted-native artifact supersedes its descriptor, so a
local JPEG cannot permanently shadow a newer cross-platform develop. Cache
generation also verifies RAW size/mtime before and after extraction or decode;
a same-named file replaced while work is in flight is displayed for that
request but never published under the replacement file's identity.

| Cache                   | How to Clear                                     | Effect                            |
| ----------------------- | ------------------------------------------------ | --------------------------------- |
| Hosted unedited preview | Delete `.maple/previews/` in the photo directory | Preview re-extracted on next open |

---

## Web editor — edit-time developed-preview persist (#2018)

The "developed preview" is the OTHER half of the same `.maple/previews/<filename>`
cache file (#2010 produces the unedited/camera-embedded tier above): on a
pixel-affecting edit, the web editor (`EditorShellComponent`, `/edit/:slug/**`
— the sole live editor since the S5 editor's retirement, epic #1807) re-renders
the DEVELOPED image (RAW + current XMP) at the canonical 1280px-long-edge
preview size and overwrites the same file. Both tiers share one cache slot —
whichever a client rendered most recently wins, matching the "pure cache,
overwritten in place" contract epic #1993 established.

**Write policy — idle debounce + exit, NOT per slider tick:** the live
on-screen render (`ImageCanvasComponent`'s two-phase fast/refine passes) is
completely separate from this persist. `LibraryStateService.updateAdjustment`
(every pixel-affecting edit — NOT the culling mutators, which don't touch
pixels) arms a 2-second idle debounce on `EditPreviewPersistService`; only
once the user stops editing does the service run ONE decode + encode + write.
`EditorShellComponent` also flushes any pending persist immediately on
`beforeunload` and `ngOnDestroy` (navigate-away / close / editor-teardown),
mirroring `LibraryFetch.flushPendingXmpWrites`'s role for the sidecar
debounce. This is a bounded, occasional cost — never a per-tick allocation or
WASM round-trip (CLAUDE.md's performance invariants) — and shares the
existing `RawPipelineService` single-in-flight decode queue, so it simply
queues behind (never alongside) a live render.

**AVIF-encode reality (#2018, following #2010's measurement that no shipping
browser's canvas can genuinely encode AVIF today — see above):**

- **Server-backed (Self-Hosted):** encodes AVIF client-side when this browser
  genuinely can (`canEncodeAvif`); otherwise falls back to a HIGH-quality JPEG
  (`encodeDevelopedRenderToJpeg`, quality 0.92 — an intermediate, not the
  final artifact) and `PUT`s that instead. The server's `/api/preview` route
  (`routes/preview.ts`) accepts EITHER format: an AVIF body is staged as-is;
  a JPEG body is transcoded to AVIF server-side via
  `renderImageThumbToFileViaPool` — the SAME isolated-child-process sharp
  pipeline the index-time preview stage already uses for bitmap sources, so a
  malformed/hostile upload can only crash that isolated child, never the HTTP
  process. Either input format is then validated with a real decode
  (`validateAvifOutput`, #2014) before the atomic publish. Net effect: the
  server-backed path persists a genuine developed AVIF on every browser
  today, not just AVIF-capable ones.
- **Hosted (File System Access folder handle):** encodes genuine AVIF when
  available, otherwise writes the high-quality JPEG under `.jpg`. The local
  descriptor records the actual format and source identity. No server
  transcode is needed, and the cache remains local implementation detail.

Implemented by `EditPreviewPersistService`
(`lib/state/edit-preview-persist.service.ts`), which owns the debounce timers
and the Hosted-vs-server-backed branch; the encode helpers
(`encodeDevelopedRenderToAvif` / `encodeDevelopedRenderToJpeg`) live in
`raw-pipeline/image-utils.ts`, reusing the same `canEncodeAvif()` capability
probe as the thumbnail tier. The Hosted write path reuses
`MapleCacheService.writePreview`; the
server-backed path uses `BunApiBackendService.putPreview` and retains its fixed
AVIF final-artifact contract.

Non-RAW assets (JPEG/PNG/HEIC sources) are out of scope for this tier:
`RawPipelineService.decode`'s non-RAW branch decodes browser-natively and
does not apply the XMP adjustment at all, so there is no "developed" render
to persist through this code path — the unedited tier (#2010) already keeps
that asset's preview current, and persisting an unedited render under the
edited contract would be actively wrong, not just incomplete.

| Cache                          | How to Clear                                     | Effect                                                 |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------ |
| Web developed preview (either) | Delete `.maple/previews/` in the photo directory | Re-derives on next open (unedited) or edit (developed) |
