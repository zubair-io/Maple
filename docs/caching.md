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
