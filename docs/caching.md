# Caching Architecture

Maple has five distinct cache layers, each serving a different access pattern. Together they ensure that browsing is instant, editing is responsive, and reopening a previously-edited image shows pixels in ~0ms.

---

## Cache Layers at a Glance

| #   | Cache                  | Location                                | Format         | Lifetime                         | Purpose                                       |
| --- | ---------------------- | --------------------------------------- | -------------- | -------------------------------- | --------------------------------------------- |
| 1   | In-memory thumbnails   | `ThumbnailLoader.memoryCache`           | `CGImage`      | App session                      | Instant grid cell rendering                   |
| 2   | On-disk thumbnails     | `.maple/thumbs/` next to photos         | JPEG q=0.8     | Travels with photos              | Survives app restarts, external drive moves   |
| 3   | Rendered preview cache | `~/Library/Caches/MapleMaple/previews/` | JPEG q=0.85    | Until OS purge or 500MB eviction | Instant cold-open of previously-edited images |
| 4   | Decoded CIImage        | `EditSession.decodedImage`              | CIImage (lazy) | Single editing session           | Avoids re-decoding RAW on every slider change |
| 5   | SMB file data          | `EditSession.cachedFileData`            | Raw `Data`     | Single editing session           | Avoids re-downloading ~35MB over network      |

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
~/Library/Caches/MapleMaple/previews/
  ├── a1b2c3d4e5f6g7h8.9i0j1k2l3m4n5o6.jpg
  ├── p7q8r9s0t1u2v3w4.x5y6z7a8b9c0d1e2.jpg
  └── ...
```

**Key:** `{SHA256(assetID)[0:16]}.{SHA256(adjustments_json)[0:16]}.jpg`

The adjustment hash uses `JSONEncoder` with `.sortedKeys` so field order doesn't perturb the hash. Any slider change produces a different hash — stale entries are never served.

**Format:** JPEG, quality 0.85, encoded via `CIContext.jpegRepresentation` (always opaque — avoids the ImageIO "AlphaPremulLast" warning that fires when writing CGImages with alpha to JPEG).

**Size:** Always cached at **viewport resolution** (the fast preview target), not the refined zoom resolution. This keeps files small (~hundreds of KB) and matches what the user sees on cold-open (fit mode).

**Read path:** `EditSession.beginEditing` → `previewCache.read(assetID:adjustments:)`. On a hit, `previewImage` is set immediately and the function returns — the user sees pixels in ~0ms. The RAW decode runs in the background via `scheduleBackgroundDecode()`.

**Write path:** `persistCurrentPreviewToCache()` fires after the refine pass completes (or after the fast pass when no refine is needed). The encode + write runs on a detached utility-priority task to avoid blocking the main thread.

**Eviction:** 500MB byte budget. On each write, the cache scans the directory and deletes oldest-modification-date entries until under budget.

**Cache coherency:** Because the key includes the full adjustment hash, there is no explicit invalidation. Editing the image produces a new hash → new entry. Old entries are orphaned and eventually evicted by the byte-budget sweep.

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
