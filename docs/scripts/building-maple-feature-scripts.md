# Building Maple — Feature Scripts

Source material for the "Building Maple" script series. One section per feature.
Each section follows the same beat sheet so it's easy to read on camera:

1. **Why I wanted it** — the motivation / the problem it solves.
2. **What it does** — the user-facing behavior.
3. **How it's built** — the architecture and the key files.
4. **Code spec** — the types, signatures, and a representative snippet.

Everything below is grounded in the real codebase (file paths are clickable).
The two product pillars the whole thing hangs off of are in `docs/maple-prd.md`:
**professional color quality a working photographer will trust**, and
**performance that disappears** (a slider tick inside a single 60 Hz frame on a
100MP RAW). Keep coming back to those two — every feature either serves color
trust, serves speed, or serves the non-destructive promise that makes both safe
to use.

A note on shape: Maple is **three apps over one core**.

- **Maple (native)** — Swift + SwiftUI on Mac/iPad/iPhone. Deliberately *not* a
  DAM: no server, no face recognition, no auto-tagging. It browses, culls, and
  develops RAWs against local folders, Apple Photos, SMB shares, and a File
  Provider mount.
- **Maple Hosted / Local editor** — Angular in the browser, Rust core compiled
  to WASM, edits entirely client-side. No server needed to develop a file.
- **Maple Self Hosted** — a Bun/Elysia + MongoDB backend that serves the same
  Angular app and adds the *library intelligence*: the indexer, geocoding,
  descriptions, face clustering, and semantic search.

That split is why some features (geocode, describe, faces, search) live only in
Self Hosted, and why "non-destructive" and "fast" are invariants shared by all
three.

---

## 1. File Provider Access

**Why I wanted it.** A working photographer's library doesn't live in one app's
sandbox — it lives in folders, on a NAS, in the cloud. I wanted Maple's catalog
to show up *inside Finder and the iOS Files app* as a normal mounted volume, so
a server-hosted library feels like a local drive: browse it, Quick Look it, drag
files in, and have edits flow back. No "import" step, no second copy of the
truth.

**What it does.** Surfaces a Maple Self Hosted library as a virtual File
Provider mount on macOS and iOS. You can enumerate folders, download originals
on demand, drag new files in (upload), create folders, trash items, and the
`.maple/` cache folder (with pre-rendered thumbnails) shows up so Quick Look is
instant. A change feed keeps the mount live as the server changes underneath it.

**How it's built.** An `NSFileProviderReplicatedExtension`. The macOS and iOS
entry points are thin; the real logic is shared in MapleCore so both platforms
behave identically.

- `src/apple/MapleFileProvider/FileProviderExtension.swift` — macOS entry point
- `src/apple/MapleFileProviderIOS/FileProviderExtensionIOS.swift` — iOS entry point
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderExtensionCore.swift` — ~1700 lines of the actual logic
- `…/FileProvider/MapleItem.swift` — the `NSFileProviderItem` model
- `…/FileProvider/FileProviderIdentifier.swift` — the identifier scheme
- `…/FileProvider/FileProviderMetaStore.swift` — SQLite map of cached filename → asset ID

Design decisions worth a beat on camera:

- **Three-part identifier scheme.** `.asset(id)` for indexed images,
  `.file(folderID, relativePath)` for non-indexed files, `.folder(...)` for
  folders. Indexed photos and loose files coexist in one tree.
- **SSE change feed.** The extension subscribes to a server-sent-events stream
  and signals the enumerator to re-read when the server changes, so the mount
  isn't a stale snapshot.
- **Dormant mode.** With no config, the extension returns `notAuthenticated`;
  the host app writes config + tokens, then it wakes up. No ambush.
- **Synthetic `.maple/thumbs/`.** Pre-rendered JPEG thumbnails are exposed as
  real items so Quick Look never has to download the full RAW.

**Code spec.**

```swift
// FileProviderExtensionCore.swift — resolving any item by identifier
open func item(for identifier: NSFileProviderItemIdentifier,
               request: NSFileProviderRequest,
               completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    if dormant {                                   // no config yet
        completionHandler(nil, notAuthenticatedError()); return progress
    }
    Task {
        defer { progress.completedUnitCount = 1 }
        let parsed = try FileProviderIdentifier(rawValue: identifier.rawValue)
        switch parsed {
        case .asset(let id):
            guard let meta = try await catalog.getAsset(assetID: id) else {
                completionHandler(nil, noSuchItemError()); return
            }
            let parent = await Self.resolveAssetParent(meta: meta, rootCache: rootCache)
            completionHandler(MapleItem(assetMetadata: meta, parent: parent), nil)
        // .file(...) / .folder(...) cases follow
        }
    }
    return progress
}
```

---

## 2. PhotoKit Browser Access

**Why I wanted it.** On a Mac and especially on iPhone/iPad, most people's
photos *are* the Apple Photos library. If Maple couldn't browse and develop
straight out of Photos, it would be a non-starter on mobile. I wanted Photos to
be a first-class source alongside folders and shares — and I wanted it to stay
fast on a 100k-image library.

**What it does.** Browses the system Photos library — all photos, albums,
favorites — with lazy pagination, reads original RAW bytes (not Apple's
tone-mapped render), handles Live Photos, and stays in sync via change
observation.

**How it's built.** Apple's `Photos` framework, wrapped in a source adapter.

- `…/Sources/PhotoKitSource.swift` — the source adapter (bytes + metadata)
- `…/Sources/PhotoKitCatalog.swift` — a process-wide cache of asset IDs
- `…/Sources/PhotoKitLibrary.swift` — authorization + helpers
- `src/apple/Maple/Backup/PhotoKitAssetReader.swift` — bytes/metadata for backup
- `src/apple/Maple/Views/AppShell+PhotoKitActions.swift` — the UI flow

Key decisions:

- **Lazy `PHFetchResult`, never materialized to an array.** Stays O(1) to open a
  100k-image library; pages via `objects(at:)`.
- **Process-wide `PhotoKitCatalog` singleton** behind an `NSLock`, invalidated
  on every change-observer event.
- **`.unadjusted` original bytes** via `PHImageRequestOptions` / `PHAssetResource`
  so Maple's own pipeline sees the RAW, not Apple's render.
- **Live Photo detection** via `mediaSubtypes.contains(.photoLive)`; the paired
  video is fetched as a separate resource.
- **Deferred authorization** — a "Grant Access" button, not a dialog on launch.
- **PhotoKit sidecar caveat:** you can't write a sibling `.xmp` next to a
  PhotoKit asset, so its sidecar lives in the app-support directory (see §10).

**Code spec.**

```swift
// PhotoKitCatalog.swift — lazy enumeration, cached IDs
public func imageIdentifiers() -> [String] {
    if let cached = cachedImageIDs { return cached }            // hit
    let opts = PHFetchOptions()
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    let result = PHAsset.fetchAssets(with: .image, options: opts)
    var ids: [String] = []; ids.reserveCapacity(result.count)
    result.enumerateObjects { asset, _, _ in ids.append(asset.localIdentifier) }
    cachedImageIDs = ids
    return ids
}

// PhotoKitSource.swift — original RAW bytes, plus Live Photo twin
let resources = PHAssetResource.assetResources(for: asset)
let original  = resources.first { $0.type == .photo || $0.type == .video }
let isLive    = asset.mediaSubtypes.contains(.photoLive)
let liveVideo = isLive ? resources.first { $0.type == .pairedVideo } : nil
```

---

## 3. File Access (local folders + security-scoped bookmarks)

**Why I wanted it.** The simplest, most universal library is a folder of RAWs.
Photographers already organize on disk. I wanted "open this folder" to just work
— and to keep working across app launches without re-asking permission every
time, which on a sandboxed Mac/iOS app means security-scoped bookmarks.

**What it does.** Opens a local folder, enumerates RAWs (and their sibling
`.xmp` sidecars), and persists access so the same folder reopens silently on the
next launch. Handles the macOS sandbox scope lifecycle correctly so background
decode/thumbnail tasks don't lose file access mid-flight.

**How it's built.**

- `…/Sources/FilesystemSource.swift` — the source actor; holds a long-lived
  security scope for its lifetime
- `…/Sources/BookmarkStore.swift` — bookmark persistence in `UserDefaults`
- `…/Sources/SavedFolderStore.swift` / `FavoriteFolderStore.swift` — restore + favorites

Key decisions:

- **Platform-specific bookmark options.** macOS uses `.withSecurityScope`; iOS
  uses `.minimalBookmark` (File Provider URLs are implicitly scoped).
- **Long-lived scope claim.** The source holds `startAccessingSecurityScopedResource()`
  for its whole life and exposes a `scopedAncestor`, so FFI readers deep in the
  pipeline can bracket their reads. Detached render tasks survive the call that
  spawned them.
- **Stale bookmarks** are dropped on restore and trigger a re-pick prompt.

**Code spec.**

```swift
// FilesystemSource.swift — open a folder, claim scope, capture a bookmark
public func open(folderURL: URL) throws {
    stopAccess()
    let accessing = folderURL.startAccessingSecurityScopedResource()
    self.folderURL    = folderURL
    self.scopeClaimed = accessing
    self.bookmarkData = try folderURL.bookmarkData(
        options: Self.bookmarkCreationOptions,   // .withSecurityScope on macOS
        includingResourceValuesForKeys: nil, relativeTo: nil)
    try _index()
}
```

---

## 4. Geocoding (GPS → place name)

**Why I wanted it.** "Where was this?" is the second question after "who's in
it?" GPS coordinates in EXIF are useless to a human — nobody searches for
`37.81, -122.47`. I wanted photos to be findable and foldered by *place names*:
"Golden Gate," "Lisbon," "the lacrosse field" — without shipping a giant offline
geo database or hammering a public API on every photo.

**What it does.** Reverse-geocodes a photo's GPS coordinates into a place name
(POI → locality fallback), used both for search and for backup path layout
(`YYYY/LocationName/MM-DD/filename`). It's a Self Hosted enrichment worker — the
device just reads the resolved `place` off the asset.

**How it's built.** A slow-tier enrichment worker against a Nominatim instance,
fronted by a coordinate cache. Documented in `docs/indexer-enrichment.md` §4.

- `docs/indexer-enrichment.md` §4 — the full worker spec, cache, and `Place` schema
- `src/apple/Packages/MapleBackup/Sources/MapleBackup/GeocodeClient.swift` — the device-side HTTP client
- `…/MapleBackup/PathFormatter.swift` — the year/location/date path layout
- Server: `MAPLE_NOMINATIM_URL`, claim query `{ "geo.ready": true, "enrichment.geocode.doneAt": null }`

Key decisions:

- **Coordinate cache quantized to 4 decimals** (~11 m). Trip photos cluster, so
  this dedupes ~90% of lookups — one API call covers a whole afternoon at a spot.
- **Server-side, not CLGeocoder.** The device never geocodes; it reads
  `asset.place` from Mongo after the worker fills it. Keeps the API key and rate
  limits server-side and the result shared across devices.
- **Fallback chain:** first POI name → locality → `null`. No GPS ⇒ `place: null`.
- **Path sanitization** rejects `..`, leading dots, and escapes `/` → `_` to
  block directory traversal in backup paths.

**Code spec.**

```swift
// GeocodeClient.swift — the whole client is this small
public actor GeocodeClient {
  public func lookup(lat: Double, lon: Double) async throws -> String? {
    var comps = URLComponents(url: baseURL.appendingPathComponent("api/geocode/reverse"),
                              resolvingAgainstBaseURL: false)!
    comps.queryItems = [.init(name: "lat", value: "\(lat)"),
                        .init(name: "lon", value: "\(lon)"),
                        .init(name: "precision", value: "4")]   // ~11 m cache bucket
    let (data, resp) = try await session.data(from: comps.url!)
    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
    let place = try JSONDecoder().decode(Response.self, from: data).place
    return place.pois.first?.name ?? place.rollups.locality        // POI → locality
  }
}
```

---

## 5. Description (qwen2.5-vl vision → structured VisionDoc)

**Why I wanted it.** A caption isn't the goal — *findability* is. I wanted every
photo to carry a structured description I could search and facet on: subjects,
scene type, activity, mood, dominant colors, and any readable text. And I wanted
one local vision model to produce all of it (including OCR), so there's no API
bill and nothing leaves the box. The earlier design ran Tesseract separately for
text; that was removed in #158 because qwen reads text fine via `text_visible`.

**What it does.** Runs `qwen2.5-vl:7b` (via Ollama) over a 1280px preview JPEG
and returns a strict-validated `VisionDoc` JSON: caption, subjects, scene_type,
setting, activity, time_of_day, lighting, weather, mood, colors, composition,
text_visible (OCR), notable_objects, shot_type, is_screenshot. Stored in Mongo —
**never** in XMP, because it's *derived*, not user-authored.

**How it's built.** A Self Hosted enrichment stage depending on the `preview`
stage. Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`.

- `src/api/src/workers/stages/describe.ts` — the stage handler
- `src/api/src/enrichment/describe-providers/ollama.ts` — the model call
- `…/describe-providers/parse-vision-json.ts` (+ `-coerce`, `-enums`) — strict parse, tolerant enum coercion
- `src/api/src/db/schema.ts` — the `VisionDoc` / `VisionMeta` types

Key decisions:

- **Separate `preview` (1280px) stage** vs the 512px browse thumb: the model
  needs more pixels, the grid doesn't.
- **Strict JSON parser** with `format: VISION_DOC_JSON_SCHEMA` (Ollama enforces
  at decode time) — but a **tolerant enum coercion** layer (v4) maps "partly
  cloudy" → "cloudy" so soft drifts don't dead-letter the row.
- **`targetVersion` bump re-runs everyone.** Bumping the stage version forces a
  re-describe across the library — the worker idempotency story.
- **`pausedOnFirstBoot`** so the operator confirms Ollama is reachable before the
  queue drains into failures.

**Code spec.**

```typescript
// db/schema.ts — the structured output contract
export interface VisionDoc {
  caption: string;                 // 1–2 sentence, search-oriented
  subjects: string[];
  scene_type: 'indoor'|'outdoor'|'aerial'|'macro'|'studio'|'mixed';
  activity: string | null;
  mood: string;
  colors: string[];                // max 5
  text_visible: string | null;     // OCR — replaces the old Tesseract stage
  notable_objects: string[];       // max 8
  is_screenshot: boolean;
  // …time_of_day, lighting, weather, composition, shot_type, indoor_outdoor
}

// describe.ts — the patch written back (note: DB only, not XMP)
const patch = {
  description: vision.caption,                 // legacy free-text mirror
  vision,                                      // the full structured doc
  ocr_text: vision.text_visible ?? '',         // OCR mirrored from vision
  is_screenshot: vision.is_screenshot,
  vision_meta: { provider, model, prompt_version, generated_at: now },
};
```

---

## 6. Face Detection

**Why I wanted it.** "Show me photos of my kid" is the single most common library
query. Names beat folders. But I had two hard rules: it had to be a *Self Hosted*
capability (the native app is explicitly not a DAM and does no face recognition),
and it had to cluster on-box with no cloud face API.

**What it does.** On Self Hosted, detects faces in each thumbnail, embeds each
face, and clusters embeddings into "People" you can browse and name. Results live
in Mongo under `asset.faces[]` — again, never in XMP.

**How it's built.** Two slow-tier workers + an online clustering core.

- Detector: SCRFD/RetinaFace-mobilenet ONNX → bounding boxes
- Embedder: ArcFace / MobileFaceNet ONNX → L2-normalized vector per face
- `src/api/src/workers/stages/face-embed.ts` — detect + embed
- `src/api/src/people/cluster-embeddings.ts` — online cosine clustering
- Spec: `docs/indexer-enrichment.md` §6, `docs/spec/12-maple-apps-spec.md` §08

Key decisions:

- **Embeddings, not just boxes.** Apple's Vision gives boxes but no embeddings,
  so clustering is impossible on-device — that's *why* faces is server-only.
- **Online clustering** with a cosine-similarity threshold (~0.5): assign to the
  nearest centroid if above threshold (streaming-mean update), else start a new
  cluster. Deterministic given the same seed set and input order.
- **30-minute lease, 1–2 GPU workers.** It's the slowest stage; it gets the
  longest lease and the smallest pool.

**Code spec.**

```typescript
// cluster-embeddings.ts — assign-or-create against centroids
for (const raw of embeddings) {
  const face = l2Normalise(raw);
  let bestIdx = -1, bestScore = -Infinity;
  for (let k = 0; k < clusters.length; k++) {
    const score = dotProduct(face, clusters[k].centroid);   // cosine (both unit)
    if (score > bestScore) { bestScore = score; bestIdx = k; }
  }
  if (bestIdx >= 0 && bestScore >= threshold) {             // ~0.5
    clusters[bestIdx].centroid = updateCentroid(clusters[bestIdx].centroid, face,
                                                clusters[bestIdx].face_count++);
    assignments.push(bestIdx);
  } else {
    clusters.push({ centroid: face, face_count: 1 });        // new person
    assignments.push(clusters.length - 1);
  }
}
```

---

## 7. Semantic Search

**Why I wanted it.** Photographers don't remember filenames or dates — they
remember *what a photo was*. "The foggy morning at the coast," "kids playing
lacrosse," "that receipt." I wanted the search box to understand meaning, not
just match strings, while still working out of the box without any vector
infra configured.

**What it does.** Searches by meaning. A text query is embedded
(`nomic-embed-text`, 768-dim) and run as a Meilisearch **hybrid** query
(keyword + vector, weighted by `semanticRatio`). When Meili/embeddings aren't
configured it falls back to a Mongo `$text` index over a denormalized
`search_blob`. Plus faceted browse on vision fields and People.

**How it's built.**

- `src/api/src/routes/search/query.ts` — the search route + facet filters
- `src/api/src/enrichment/search-blob.ts` — the denormalized token bag
- `src/api/src/enrichment/meilisearch-client.ts` — hybrid client + embedder config
- `src/api/src/workers/stages/meili.ts` — indexes assets into Meili
- Spec: `docs/indexer-enrichment.md` §5

Key decisions:

- **Keyword is the default; semantic is opt-in.** `search_blob` (place + caption
  + OCR + subjects + setting + activity + notable_objects + people names,
  tokenized/deduped/sorted) feeds Mongo `$text`. Always works, no GPU.
- **Hybrid blend** when Meili + Ollama embedder are on:
  `score = (1-ratio)·keyword + ratio·vector`, default `semanticRatio = 0.5`.
- **Meili embeds documents *and* queries** via an Ollama HTTP embedder block, so
  there's one embedding source for both sides.
- **Facets are orthogonal to search:** `vision.scene_type` (exact),
  `vision.activity` (exact), `vision.subjects` (`$in`), `is_screenshot`, people.

**Code spec.**

```typescript
// search-blob.ts — everything searchable, collapsed into one sorted token bag
const tokens = new Set<string>();
const add = (s?: string|null) => s?.toLowerCase().split(/\s+/).forEach(t => t && tokens.add(t));
add(place?.search_blob); add(description); add(ocrText);
visionSubjects?.forEach(add); add(visionSetting); add(visionActivity);
visionNotableObjects?.forEach(add); people?.forEach(add);
return [...tokens].sort().join(' ');

// meilisearch-client.ts — hybrid search request (semantic path)
{ q: userQuery,
  hybrid: { semanticRatio: 0.5, embedder: 'caption' },   // 50% keyword / 50% vector
  filter: ['deletedAt IS NULL', `folderId = "${folderId}"`] }
```

---

## 8. Non-Destructive Editing

**Why I wanted it.** This is the trust contract. A photographer will not adopt an
editor that might touch their negatives. The rule is absolute: **the original
file is never modified.** Every edit is a recipe written to a sidecar; the pixels
you see are *derived* from RAW + recipe at render time. That also means edits are
portable (the `.xmp` round-trips to Lightroom) and infinitely revertible.

**What it does.** All 17 develop sliders plus culling metadata (rating, flag,
color label) and crop persist to an Adobe-compatible XMP sidecar (`crs:`
namespace + Maple's `papp:` namespace). Writes are debounced and atomic;
unknown attributes from other editors round-trip byte-for-byte. The sidecar is
the contract; the bitmap is a cache.

**How it's built.** One schema, generated into three languages, with a
byte-canonical serializer on every platform.

- `src/raw-pipeline/raw-core/src/types/adjustment/mod.rs` — `AdjustmentModel`, the source-of-truth schema
- `src/raw-pipeline/raw-core/src/xmp/mod.rs` — the reference parser
- `src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarStore.swift` — the Swift actor (debounce + atomic write)
- `src/web/projects/maple-common/src/lib/xmp/xmp-serializer.service.ts` — the TS serializer
- `docs/xmp-canonical-format.md` — the byte-exact format contract

Key decisions:

- **Codegen from Rust.** `AdjustmentModel` is defined once in Rust; Swift and TS
  versions are generated, so field names and defaults can't drift.
- **750 ms debounced, atomic temp→rename writes.** A slider drag is ~1800
  value-changes/sec; debounce collapses that to one write, and the temp-file swap
  means a crash can never leave a half-written sidecar.
- **Non-default-only emission** keeps sidecars ~1–2 KB.
- **Passthrough.** Unknown attributes and nested nodes survive verbatim, so
  Lightroom masks/history aren't clobbered.
- **Legacy-key precedence flags.** When both a new key
  (`papp:CaptureSharpeningSigma`) and a retired one
  (`papp:CaptureSharpeningRadius`) are present, the new one wins *regardless of
  document order* (same for `papp:Profile` vs legacy `papp:Look`).

**Code spec.**

```rust
// raw-core/src/types/adjustment/mod.rs — the schema (excerpt)
pub struct AdjustmentModel {
    pub exposure: f32,            // -4..+4 EV
    pub temperature: f32,         // 2000..12000 K
    pub highlights: f32, pub shadows: f32, pub whites: f32, pub blacks: f32,
    pub vibrance: f32, pub saturation: f32, pub clarity: f32, pub texture: f32, pub dehaze: f32,
    pub tone_curve_master: ToneCurve, /* …red/green/blue */
    pub crop: CropRect,
    pub rating: u32, pub flag: Flag, pub color_label: Option<ColorLabel>,
}
```

```swift
// XMPSidecarStore.swift — debounced, atomic, the contract holder
public actor XMPSidecarStore {
    static let debounceInterval: Duration = .milliseconds(750)
    public func update(model: AdjustmentModel, culling: CullingState) {
        pendingTask?.cancel()
        pendingTask = Task { try await Task.sleep(for: Self.debounceInterval); await self.writePending() }
    }
    public func flush() async { pendingTask?.cancel(); await writePending() }   // call before teardown
    private func writeAtomically(_ xml: String) throws {
        try data.write(to: tmpURL, options: .atomic)
        _ = try FileManager.default.replaceItemAt(sidecarURL, withItemAt: tmpURL)  // atomic swap
    }
}
```

The round-trip is a merge gate: Swift `serialize → parse` and TS
`serialize → parse` must agree, *and* Swift↔TS must produce byte-identical XMP.

---

## 9. Fast Performance

**Why I wanted it.** This is the other pillar, and the one people feel first. A
slider that lags is a tool you fight. The bar is brutal on purpose: a slider tick
renders a new preview **inside 16 ms** on supported hardware, on a 100MP RAW.
Performance isn't a polish pass here — it's a product feature with a budget, and
"if it breaks the budget it doesn't ship."

**What it does.** Slider drags update at 60–120 Hz. Heavy work (decode, full-res
render) is deferred and cached. Cold-opening an image with a warm cache shows
pixels in roughly one frame; uncached is 250–1500 ms with progress.

**How it's built.** Two-phase rendering + five caches + a lazy GPU filter graph
in scene-linear f32, with one view transform at the very end.

- `docs/spec/05-performance.md` — the budgets and the timing decomposition
- `…/MapleCore/RenderActor.swift` — the two-phase scheduler + decoded-image cache
- `…/MapleCore/EditSession+Render.swift` — fast/refine phase bodies
- `…/MapleCore/ImageEditPipeline.swift` — Metal-backed `CIContext`, f32 working space
- `…/MapleCore/Cache/RenderedPreviewCache.swift` — the JPEG preview cache
- `docs/caching.md` — the five caches

Key decisions:

- **Two-phase render.** A **fast** pass renders at *viewport* resolution
  immediately (a 25MP RAW at full res is 400 MB in f32 — infeasible per frame; a
  2K viewport is ~8–32 MB and renders in <20 ms). A **refine** pass, debounced
  150 ms, does full resolution only after the drag settles.
- **Generation counter + cancel-and-restart.** Each new slider value cancels the
  in-flight render and bumps a generation; stale renders self-discard. No queue,
  no batching.
- **Five caches** (see `docs/caching.md`): thumbnail-memory, thumbnail-disk,
  rendered-preview (keyed on
  `(url, mtime, sidecarMtime, screenSize, adjustmentVersion, viewTransformVersion)`),
  decoded-image (session-scoped), remote-source-bytes (SMB/network). The
  rendered-preview key includes `sidecarMtime` so an external edit cold-misses.
- **Lazy CIFilter / WebGL graph.** Parameter updates are microseconds; nothing
  computes until `startTask(toRender:)`. Default (no-op) stages cost nothing.
- **Scene-linear Rec.2020 D65 f32 throughout**, with the AgX view transform as
  the *only* display-domain op — so swapping looks is a shader parameter, and
  nothing before it clips.
- **Hard rule:** no feature may add allocation in the render loop, or a
  WASM-boundary round-trip per slider tick.

**Code spec.**

```swift
// RenderActor.swift — fast cancels both; refine debounces and does NOT bump gen
public actor RenderActor {
  static let refineDebounceMilliseconds: UInt64 = 150
  public func scheduleRender(phase: RenderPhase, work: @escaping @Sendable (UInt64) async -> Void) async {
    renderTask?.cancel(); refineTask?.cancel()
    renderGeneration &+= 1; let gen = renderGeneration
    renderTask = Task { await work(gen) }
  }
  public func scheduleRefine(work: @escaping @Sendable (UInt64) async -> Void) async {
    refineTask?.cancel()
    refineTask = Task {
      try? await Task.sleep(for: .milliseconds(150))
      guard !Task.isCancelled else { return }
      await work(currentGeneration())
    }
  }
}
```

```swift
// RenderedPreviewCache.swift — the cache key is the coherency story
private func cacheKey(for url: URL, screenWidth: Int) -> String {
  md5("\(urlHash(url.path))_\(sidecarMtimeString(for: url))_\(screenWidth)_v\(viewTransformVersion)")
}
```

Timing budget for one fast tick on a 25MP image (M3 Max): graph rebuild ~2 ms +
GPU render ~14 ms + present/redraw ~8 ms ≈ **~24–29 ms**, inside the 33 ms
two-frame budget at 60 Hz.

---

## 10. Web App — Self Hosted

**Why I wanted it.** Not everyone wants their library in someone else's cloud. I
wanted a single binary a photographer (or a small studio) can run on their own
box — a NAS, a mini PC — that serves the same web editor *and* adds the library
intelligence (indexing, geocode, descriptions, faces, search) using local
models, so nothing leaves the building.

**What it does.** A Bun + Elysia server with MongoDB that: authenticates via
WebAuthn/passkeys, registers filesystem roots and indexes them, runs the
two-tier enrichment pipeline, exposes REST APIs for assets/search/people, and
serves the prebuilt Angular bundle. It talks to Ollama (describe + embeddings),
Nominatim (geocode), and Meilisearch (search).

**How it's built.**

- `src/api/src/index.ts` — app composition, JWT bootstrap, COOP/COEP headers
- `src/api/src/auth/` — WebAuthn registration + access/refresh tokens
- `src/api/src/db/schema.ts` — the Mongo asset/enrichment schema
- `src/workers/` + `src/api/src/workers/stages/` — the stage registry and workers
- Native core via `bun:ffi` (`src/api/native/`), not WASM — see `docs/spec/12-maple-apps-spec.md` §07
- Spec: `docs/server-api.md`, `docs/spec/12-maple-apps-spec.md`

Key decisions:

- **JWT secret canonicalized in Mongo** (file fallback, in-memory last resort),
  with a SHA-256 fingerprint logged so mismatched instances are obvious — lets
  you run multiple stateless instances behind a load balancer.
- **Two-tier indexing.** A *fast tier* lands a skeleton asset row in ~200 ms
  (exif/hash/thumb) so browse is instant; *slow-tier* workers (describe,
  geocode, face, meili) patch asynchronously via a `findOneAndUpdate` claim
  query with leases + retries + dead-lettering.
- **COOP/COEP on every response** to enable `SharedArrayBuffer`, so the WASM
  editor in the browser can use the rayon thread pool.
- **`bun:ffi` not WASM on the server** — the server has a real dylib and no
  4 GiB wasm32 memory ceiling, so it links the core natively.
- **Derived data stays in Mongo, never XMP** — only user-authored metadata
  (rating/flag/label/description overrides) is written to sidecars.

**Code spec.**

```typescript
// index.ts — secret resolution prefers the DB so instances agree
async function resolveJwtSecret() {
  try { const { secret, created } = await getOrCreateJwtSecret();
        return { secret, source: created ? 'db-created' : 'db' }; }
  catch { return resolveJwtSecretFromFile(); }   // file, then in-memory
}

// index.ts — cross-origin isolation unlocks SharedArrayBuffer for the WASM editor
.onBeforeHandle(({ set }) => {
  set.headers['Cross-Origin-Opener-Policy']   = 'same-origin';
  set.headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
})

// the slow-tier claim pattern (every enrichment worker)
db.assets.findOneAndUpdate(
  { 'thumb.ready': true, 'enrichment.describe.doneAt': null, 'enrichment.describe.lease': { $lt: now } },
  { $set: { 'enrichment.describe.lease': now + leaseMs } });
```

---

## 11. Web — Local Editor

**Why I wanted it.** The fastest way to try a RAW editor should be: open a URL,
drop a file, see it develop. No install, no account, no upload. And the same
Rust color math that runs natively should run in the tab — one core, identical
pixels — so the browser isn't a toy version.

**What it does.** A fully client-side editor. Loads RAWs via the File System
Access API (Chromium) or a file input (Safari/Firefox), decodes them with the
Rust core compiled to WASM, develops them with the same scene-linear pipeline,
and writes XMP back to the local filesystem. No server connection required;
imported files persist in IndexedDB so a refresh re-hydrates.

**How it's built.**

- `…/maple-common/src/lib/raw-pipeline/raw-pipeline.service.ts` — Angular service over the worker
- `…/raw-pipeline/raw-pipeline.worker.ts` — off-main-thread WASM lifecycle + decode
- `…/folder-access/fs-access-backend.ts` + `folder-access.service.ts` — FS Access API + fallback
- `…/folder-access/file-cache.ts` — IndexedDB persistence
- `…/shells/editor-shell/editor-shell.component.ts` — 3-column shell + shortcuts
- Web pipeline: WebGL2 GLSL ES 3.0 mirroring the Metal kernels; canvas tagged `colorSpace: 'srgb'`

Key decisions:

- **WASM in a Web Worker.** Decode runs off the main thread so the UI never
  blocks; the worker reports threading capability (rayon if `SharedArrayBuffer`
  is available, single-threaded fallback on Safari).
- **Serialized decode queue.** Each decode holds ~500 MB of scratch and wasm32
  caps at 4 GiB, so decodes are chained one-at-a-time (`chain.then(run, run)`)
  to avoid OOM.
- **IndexedDB hydration.** A hard refresh on `/edit/<id>` re-reads the persisted
  file from IndexedDB and rebuilds the session — the editor survives reloads
  with no server.
- **`colorSpace: 'srgb'` on the WebGL drawing buffer** — without it, P3 Macs
  reinterpret output and warm tones shift pink. (Documented; don't remove it.)

**Code spec.**

```typescript
// raw-pipeline.service.ts — serialize decodes so wasm32 doesn't OOM
decode(bytes: Uint8Array, ext: string, xmp?: string): Promise<DecodedImage> {
  const run = () => this.decodeOnce(bytes, ext, xmp);
  const next = this.decodeChain.then(run, run);     // one at a time
  this.decodeChain = next.catch(() => undefined);   // keep the chain alive on failure
  return next;
}

// editor-shell.component.ts — survive a hard refresh from IndexedDB
private async hydrateFromCache(id: string) {
  const record = await getPersistedFile(id);
  if (!record) return void this.router.navigate(['/']);
  const bytes = new Uint8Array(await record.file.arrayBuffer());
  this.state.addImportedAsset(bytes, record.filename, id);
  this.state.selectAsset(id);
}
```

---

## Features you left off the list

These are real, shipped (or specced) parts of Maple that belong in the series —
they're load-bearing for the story even though they weren't in your bullet list:

- **Culling** — star ratings (0–5), pick/reject flags, color labels, all
  keyboard-driven (P/X/U/0–5), persisted to XMP. This is the "first hour with a
  shoot" workflow and pairs naturally with the non-destructive episode.
  (`CullingState.swift`, `docs/product-status.md` §Culling.)
- **SMB network shares** — a fourth source type alongside File Provider /
  PhotoKit / local folders, connecting directly to a NAS via AMSMB2, with
  sidecars written back to the share. Worth its own beat next to File Access.
- **RAW Develop / the adjustment sliders** — the actual editing: exposure, WB
  (temp/tint + presets + eyedropper), contrast, highlights/shadows, whites/blacks,
  vibrance/saturation, clarity/texture, dehaze, capture sharpening, NR. This is
  arguably *the* product; non-destructive and fast are how it's delivered.
- **The scene-referred color pipeline** — linear Rec.2020 D65 f32, exposure as a
  linear multiply, a single AgX view transform at the end, gated against the
  Rust reference with a CIEDE2000 parity harness. This is the "color a
  photographer trusts" pillar and deserves a flagship episode.
- **One Rust core, three pipelines** — `raw-core` compiled once as a static lib
  for Apple (C-FFI / xcframework) and once as WASM for the web, with a codegen
  step that keeps every constant identical across Rust/Swift/TS. The spine of
  the whole architecture.
- **The Indexer** — the two-tier fast/slow worker engine (`docs/indexer-enrichment.md`)
  that *powers* Description, Geocoding, Faces, and Search. You listed the leaves;
  this is the trunk, and it's a great "how it scales" episode (claim queries,
  leases, dead-letters, versioned re-runs).
- **The `.maple/` folder cache** — the cross-app interop contract
  (`docs/spec/12-maple-apps-spec.md` §03): a hidden folder of thumbnails/previews
  that lets native, web, and self-hosted share rendered artifacts.
- **Thumbnails & the 5-cache system / Zoom** — the supporting cast for "fast":
  3-layer thumbnail cache, retina-aware pixel-perfect 100% zoom, instant
  cold-open from the rendered-preview cache.
- **Export** — JPEG/HEIC/TIFF(16-bit)/PNG with long-edge resize. The "get it out
  of Maple" bookend to the develop episode.
- **Backup** (PhotoKit → Self Hosted) — the path-formatter + payload assembler
  that geocoding actually feeds, if you want to show where place names land.

If you want, I can turn any of these into the same beat-sheet format, or draft
actual spoken-word script drafts (intro hook → demo beat → code reveal → payoff)
for a specific episode.
