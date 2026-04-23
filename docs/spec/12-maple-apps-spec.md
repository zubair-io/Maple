# Maple · Apps Architecture Specification

**A shared-core photo library and non-destructive editor across web, self-host, workers, and native**

|                |                                                       |
| -------------- | ----------------------------------------------------- |
| owner          | Eng                                                   |
| audience       | Eng, Design                                           |
| status         | for review                                            |
| companion spec | _Maple · Interaction Specification_ (the UI contract) |

---

## TL;DR

Maple is one photo app shipped as three user-facing products over one Rust core.

- **Maple Hosted** — src/web browser-only. Drop a RAW, or pick a folder via the File System Access API. If the folder already has a `.maple/` cache (because another Maple instance has seen it), thumbnails load instantly and no re-decode is needed. No server, no account, no database.
- **Maple Self Hosted** src/web — Maple Hosted plus a Bun backend, an Indexer, and MongoDB. Same browser UI. The backend provides real filesystem access, writes XMPs and `.maple/` thumbs back to disk, runs the Indexer for background thumbnailing / EXIF extraction / face detection, and serves metadata + search out of MongoDB.
- **Maple (native)** src/app — iOS/Mac/iPad Swift app. Reads PhotoKit, local folders, SMB shares, or a Maple Self Hosted instance over LAN. Uses the same `.maple/` thumbnail cache as the other two — so a Mac that indexed an SMB share makes thumbs an iPad can reuse.

The three products interoperate through three fixed sources of truth, each with one job: **MongoDB** (metadata and search — Self Hosted only), **XMP sidecars** (per-image user edits, durable, travel with the file), and the **`.maple/` folder cache** (thumb and preview binaries, keyed by source filename). The Rust core is shared — WASM in browsers, native staticlib on server and native app.

---

## 01 · Topology

```
                          ┌─────────────────────────────────┐
                          │        Maple Core (Rust)        │
                          │   RAW decode · develop · XMP    │
                          │   scopes · thumb renderer       │
                          └─────────────────────────────────┘
                            │              │              │
                      wasm32-unknown   staticlib+FFI   staticlib+FFI
                            │              │              │
                ┌───────────┘              │              └───────────┐
                │                          │                          │
        ┌───────▼────────┐   ┌─────────────▼─────────────────┐   ┌────▼────────────┐
        │  Maple Hosted  │   │     Maple Self Hosted          │   │  Maple (native) │
        │  browser only  │   │   ┌─────────────────────┐      │   │  Swift          │
        │                │   │   │ browser UI (WASM)   │      │   │  iOS/Mac/iPad   │
        │  File API      │   │   └─────────────────────┘      │   │                 │
        │  drop a RAW    │   │   ┌──────────┐  ┌──────────┐  │   │  PhotoKit       │
        │  pick a folder │   │   │   Bun    │  │ MongoDB  │  │   │  SMB, local     │
        │  reuses .maple/│   │   │ backend  │  │  (meta,  │  │   │                 │
        │  if present    │   │   │          │──│  search) │  │   │  reuses .maple/ │
        │                │   │   └────┬─────┘  └──────────┘  │   │                 │
        └────────────────┘   │        │                       │   └─────▲───────────┘
                             │   ┌────▼─────┐                 │         │
                             │   │ Indexer  │                 │         │
                             │   │ (Rust)   │─── writes ──────┼─────────┤
                             │   └──────────┘    .maple/      │   reads/writes
                             │                   XMP          │   shared .maple/
                             └────────────────────────────────┘
```

Key relationship: **Maple Self Hosted contains Maple Hosted.** Same browser UI, same WASM core, same File API code path — Self Hosted just adds a Bun backend, an Indexer subsystem, and MongoDB behind it. A user who outgrows Hosted installs Self Hosted and nothing about the UI changes.

### Three sources of truth

| Source                     | Scope                                                                                                                        | Written by                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **XMP sidecar**            | Per-image user state — rating, flag, color label, IPTC, keywords, the `adj` struct, `maple:id`. Travels with the image file. | Any product. Canonical for per-image state.                           |
| **`.maple/` folder cache** | Per-folder binary cache — thumb and preview JPEGs, keyed by source filename.                                                 | Any product that does a decode. Shared byte-for-byte across products. |
| **MongoDB**                | Cross-folder metadata — all EXIF, GPS, face embeddings, AI tags, keyword index, album queries. Indexed for search.           | Self Hosted only. Not required by Hosted or offline native.           |

---

## 02 · Maple Core

Rust crate, no UI, no I/O above a narrow trait boundary. Same source compiles to three targets.

### Public API surface

```rust
// Decode + metadata
pub fn decode_raw(bytes: &[u8]) -> Result<Image>;     // RAW → linear float buffer
pub fn read_exif(bytes: &[u8]) -> Exif;               // EXIF + GPS + capture date

// Develop
pub fn apply(image: &Image, adj: &Adj) -> Rendered;   // adj struct from spec §07
pub fn histogram(rendered: &Rendered) -> Histogram;
pub fn waveform(rendered: &Rendered) -> Waveform;

// Thumbnails / previews
pub fn thumbnail(image: &Image, max_px: u32) -> Rgba;
pub fn preview(image: &Image, max_px: u32, adj: &Adj) -> Rgba;

// XMP
pub fn xmp_read(bytes: &[u8]) -> Sidecar;             // parses to typed struct
pub fn xmp_write(sidecar: &Sidecar) -> Vec<u8>;       // serializes back

// Export
pub fn encode(rendered: &Rendered, fmt: OutFmt, opts: EncodeOpts) -> Vec<u8>;
// OutFmt: Jpeg | Png | Webp | Heic | Tiff
```

### Target-specific concerns

| Target                    | Concern               | Approach                                                                                                                                           |
| ------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wasm32-unknown-unknown`  | No threads by default | Use `wasm-bindgen-rayon` behind `SharedArrayBuffer`; fall back to single-thread on sites without cross-origin isolation headers                    |
| `wasm32-unknown-unknown`  | libraw is C++         | Build libraw as wasm static lib via emcc, link with wasm-bindgen; keep the CR3/NEF/ARW decoder list in a cargo feature so the binary is splittable |
| native (server/iOS/macOS) | CPU + SIMD            | Enable `portable-simd`; on Apple, also gate a path that calls into vImage/Accelerate behind a feature flag if the perf gap is large                |
| iOS/macOS                 | Swift FFI             | Generate bindings with `uniffi-rs`; expose the API above as a single `MapleCore` Swift package                                                     |

The core is side-effect-free. It never reads or writes a file — shells own I/O. That rule is what lets the same code run in the browser sandbox and on disk.

---

## 03 · The `.maple/` folder cache (interop contract)

`.maple/` is a binary cache. Its entire purpose is storing thumbnails and previews that are too expensive to render on the fly and too wasteful to push into MongoDB as blobs. Metadata does not live here. Search does not live here. Ids do not live here. Any folder that has been opened by any Maple shell grows a `.maple/` directory next to the images; every shell reads it when present and writes to it when it produces new derivatives.

### Layout

```
France-trip/
├── .maple/
│   ├── thumbs/
│   │   ├── IMG_0001@1x.jpg     ← 256px long-edge, sRGB, q=82
│   │   └── IMG_0001@2x.jpg     ← 512px long-edge, retina
│   └── previews/
│       └── IMG_0001.jpg        ← 1600px long-edge, q=90, for Full mode
├── IMG_0001.CR3
├── IMG_0001.xmp                ← user state (ratings, flags, adj) + maple:id
├── IMG_0002.CR3
└── IMG_0002.xmp
```

**Thumbs are named by source filename, not by id.** Shell opens the folder, sees `IMG_0001.CR3`, looks for `thumbs/IMG_0001@1x.jpg`, done. No mapping file, no manifest, no lookup. On rename, the old thumb orphans and regenerates under the new name — orphans are small (~30 KB) and get cleaned up by a periodic GC pass that deletes thumbs whose source file is gone.

**What's deliberately not here:** no `index.json`, no `manifest.tsv`, no `cache.sqlite`, no face embeddings, no EXIF duplication. All of those live in MongoDB (§07) or in XMP sidecars (§05).

### Rules

1. **Never write to source files.** Derivatives live in `.maple/`; user state lives in `.xmp`.
2. **Freshness is `(size, mtime)`** from `stat()` compared against the thumb's `mtime`. If the source is newer than the thumb, re-render.
3. **Thumbs are identical across shells.** Same dimensions, same codec, same quality. A thumb written by the Mac app must be byte-usable by the web app. The encoding parameters are pinned in the core's `thumbnail()` function so all shells produce the same bytes.
4. **Orphan GC is lazy.** Shells don't have to clean up on rename. A background pass in the Indexer removes thumbs with no matching source file. On read-only mounts, orphans are ignored.
5. **Concurrent writers are safe.** Thumb writes use write-to-temp + rename. Same input ⇒ same output up to codec determinism, so overwrites are idempotent.
6. **Git-ignoreable.** `.maple/` belongs in `.gitignore`, Time Machine excludes, Dropbox ignore patterns. Deleting it loses only CPU time.

### Why this is enough

The three things a shell needs at browse time are: (a) a way to list images in a folder — `readdir()`, (b) a way to get a thumb fast — the filename tells you where it is, (c) a way to get user state like rating and flag — XMP sidecar. MongoDB is not on the critical path for browsing a folder that's already indexed. It's only hit for search and cross-folder views.

---

## 04 · Identity

Every image has a stable `id` that survives rename, path change, and round-trips through any shell.

```
id = BLAKE3( sha1Head(first 64 KB)  ||  CaptureDateTimeOriginal  ||  camera_serial  ||  shutter_count )[..16]
```

Truncated to 16 bytes, hex-encoded. Rationale:

- `sha1Head` catches accidental duplication and is cheap (first 64 KB, not full file).
- `CaptureDateTimeOriginal` is present in every modern RAW and stable under rename.
- `camera_serial + shutter_count` disambiguates burst-mode shots where capture time collides to the second.

Fallback when fields are missing (phone snapshots, older cameras): `id = BLAKE3(sha1_full || filesize)[..16]`. The ID type carries a tag byte so the two kinds don't alias.

XMP sidecars store `maple:id` so the id survives rename (Mongo updates `file`/`absPath` on the next indexer pass and keeps the same `_id`) and survives Mongo loss (user state in sidecars re-imports cleanly). The `.maple/` thumbnail cache does not key off id — it keys off source filename — so renames do cost a thumb regeneration. That's an acceptable trade for not needing any id-mapping file on disk.

---

## 05 · XMP sidecar contract

Non-destructive edits, ratings, flags, and color labels all live in an XMP file next to the source. The file is standards-shaped so other tools (Lightroom, darktable, Capture One) can read at least the Adobe-standard fields.

| Namespace | Purpose                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xmp:`    | `Rating` (0–5), `Label` (color, as the Adobe color word)                                                                                                                                                         |
| `dc:`     | IPTC — `title`, `description`, `subject` (keywords), `rights`, `creator`                                                                                                                                         |
| `crs:`    | Adobe Camera Raw compatibility: `Exposure2012`, `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012`, `Temperature`, `Tint`, `Vibrance`, `Saturation`, `Clarity2012`, `Texture`, `Dehaze` |
| `maple:`  | Native fields that don't map cleanly — `flag` (pick/reject/none), `id`, edit history snapshots, sharpening + NR parameters, before/after divider state                                                           |

Write policy:

- **Debounce 500 ms** after the last slider motion (per the interaction spec §07 persistence rule).
- **Atomic:** write to `IMG_0001.xmp.tmp`, fsync, rename to `IMG_0001.xmp`.
- **Merge on read:** load `crs:*` first, then overlay `maple:*`. When a field exists in both, `maple:` wins (it is the canonical native representation).
- **Write both:** every adjustment that has a `crs:` equivalent is written to both namespaces so Lightroom users see the edits.

---

## 06 · Maple Hosted (hosted, browser-only)

A single URL, no account, no server, no persistence across sessions beyond what lives in the browser. The same WASM bundle that ships inside Maple Self Hosted — this is literally that frontend without a backend behind it. Working name: `maple.justmaple.app`.

### Core flow

1. User lands on a landing page with two CTAs: "Open a photo" and "Open a folder."
2. "Open a photo" uses `<input type="file" accept="image/*,.cr3,.nef,.arw,.dng">`. The file streams into WASM, gets decoded, and the app jumps into Full mode.
3. "Open a folder" uses the File System Access API (`showDirectoryPicker`) where available — Chromium-family browsers. This grants read access to the directory; the app walks it, discovers RAWs, reads any existing `.xmp` sidecars, and reuses any `.maple/thumbs/` and `.maple/previews/` that are present. If the API is missing (Safari, Firefox), the feature is hidden and the app stays in single-file mode.
4. Edits persist to an **in-memory session** backed by IndexedDB so that a refresh doesn't lose state for the open folder. This is a cache, not a library; closing the tab loses nothing that wasn't exported.
5. **Export** produces:
   - A rendered image as a downloaded blob (JPEG, PNG, WebP, or HEIC where supported).
   - The updated `.xmp` file as a separate download, or — if the user granted write access to the directory — written in place alongside the source.

### Constraints

- No folder tree beyond the one the user explicitly opened. The spec's left-panel tree (§03) collapses to a single-source view.
- No MongoDB, no server-side AI, no keyword search beyond what's in the open folder.
- RAW decode performance is the main risk. On Chromium with `crossOriginIsolated=true`, rayon + SharedArrayBuffer gets us to within ~1.5x of native for most sensors. On Safari without cross-origin isolation, decode is ~3–4x slower; the UI renders a preview-first (embedded JPEG from the RAW) while the full decode runs.

### Headers required

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Served from Cloudflare Workers + static assets on R2. No backend code.

---

## 07 · Maple Self Hosted (self-host, Bun)

**Maple Hosted + a Bun backend + an Indexer + MongoDB.** Runs on a user's own machine, or a homelab LXC. The browser UI is the same WASM bundle that Maple Hosted serves; the difference is that the Bun backend behind it provides real filesystem access, writes XMPs and `.maple/` caches to disk, runs the Indexer subsystem (§08) for background work, and serves metadata + search out of MongoDB.

### Components

```
maple-self-hosted/
├── web/                ← Angular SPA, same shell as Maple Hosted
├── api/                ← Elysia routes: /images, /folders, /search, /export
├── indexer/            ← background worker, §08
├── core-native/        ← Rust core as a Bun FFI module (bun:ffi)
└── mongo-migrations/
```

### Why Bun + FFI rather than WASM on the server

The Node/Bun ecosystem has `bun:ffi` which calls into a staticlib with no IPC overhead. Running the native `libmaple_core.dylib`/`.so` gives ~2x the decode throughput of the WASM build, which matters for an indexer chewing through 10k-image imports. The browser still gets WASM; the server gets native. Same Rust source.

### API surface (Elysia)

```
GET  /api/folders                       → tree of indexed folders
GET  /api/folders/:id/images            → image list, supports ?filter, ?sort, ?limit, ?offset
GET  /api/images/:id                    → image metadata (exif, adj, flags, rating, faces)
GET  /api/images/:id/thumb[@2x]         → JPEG bytes (served from .maple/thumbs/)
GET  /api/images/:id/preview            → JPEG bytes (served from .maple/previews/)
GET  /api/images/:id/raw                → streamed source bytes (range requests)
PUT  /api/images/:id/adj                → merge into adj, debounce-save XMP
PUT  /api/images/:id/rating             → write XMP + update Mongo
PUT  /api/images/:id/flag               → write XMP + update Mongo
POST /api/images/:id/export             → render + stream back
GET  /api/search?q=…&filter=…&near=…    → Mongo-backed search
WS   /api/events                        → indexer progress, external file change notifications
```

Editing is end-to-end non-destructive: `PUT /adj` writes the `.xmp` and updates the Mongo doc; the source file is never touched.

### MongoDB schema

```js
// images
{
  _id: "7a3fbe2c...",              // same as Maple core id
  folderId: ObjectId(...),
  file: "IMG_0001.CR3",
  absPath: "/Volumes/Photos/2026/France-trip/IMG_0001.CR3",
  size: 32417112,
  mtime: ISODate(...),
  sha1Head: "e4c1...",
  w: 6000, h: 4000, ar: 1.5,
  capturedAt: ISODate(...),
  exif: { camera, lens, iso, shutter, aperture, focal, flash, ... },
  gps:  { type: "Point", coordinates: [lon, lat] },   // 2dsphere-indexed
  place: { city, region, country },                    // reverse-geocoded
  flag: "pick" | "reject" | null,
  rating: 0..5,
  color: "red"|"orange"|"yellow"|"green"|"blue"|null,
  keywords: ["france", "paris"],
  faces: [{ box:[x,y,w,h], personId, embedding }],
  aiTags: [{ tag: "architecture", conf: 0.91 }],
  adj: { ... spec §07 ... },
  xmpWrittenAt: ISODate(...),
  indexedAt: ISODate(...)
}

// folders
{ _id, path, label, parentId, watchedAt, imageCount }

// persons
{ _id, name, embedding, coverImageId }

// albums (user-defined, cross-folder)
{ _id, name, query: { ... }, pinned: bool }
```

Indexes: `{capturedAt:-1}`, `{folderId:1, capturedAt:-1}`, `{rating:1}`, `{flag:1}`, `{gps:"2dsphere"}`, `{keywords:1}`, `{"faces.personId":1}`, text index on `{keywords, place.city, place.country, exif.camera, exif.lens}`.

### Deploy

Single Bun binary (`bun build --compile`) + MongoDB. Fits in an LXC with ~1 GB RAM for the Bun side; Mongo sizing depends on library size but 30k images ≈ 200 MB. Optional GPU passthrough to the indexer container for ONNX face detection.

---

## 08 · The Indexer (Self Hosted subsystem)

A background worker that lives inside Maple Self Hosted. Written in Rust, links Maple Core directly (no FFI hop). It's what does the heavy lifting: walking folders, writing `.maple/` thumbs and previews, extracting EXIF, running face detection, and upserting to MongoDB. Ships in-process with the Bun backend by default; can be split onto a separate host for very large libraries, controlled over a small command channel.

Neither Maple Hosted nor Maple native runs an Indexer — they just _consume_ what the Indexer produces (thumbs in `.maple/`, metadata in Mongo) when it's available. The indexer should reports it status to mongodb, there also should be setting in the the web to control the indexer, like how many workers can run at a time, and in the status we can see like how want images are in the q, also thing the error and dead letter q

### Pipeline

```
[ fs watch ]──▶ [ discover ]──▶ [ hash/stat ]──▶ [ exif ]──▶ [ thumb+preview ]──▶ [ ai ]──▶ [ mongo upsert ]
                                    │                                                          │
                                    └─── .maple/thumbs + previews write, Mongo upsert ──────┘
```

Stages are decoupled via bounded channels (`crossbeam`), which matches his existing pattern in the HA anomaly detector. Each stage has its own worker pool sized independently:

| Stage           | Work kind                      | Pool size       |
| --------------- | ------------------------------ | --------------- |
| Discover        | Directory walk (IO-bound)      | 4               |
| Hash/stat       | 64 KB read + BLAKE3            | num_cpus / 2    |
| EXIF            | Pure CPU, cheap                | num_cpus        |
| Thumb + preview | RAW decode + resize (hot path) | num_cpus − 2    |
| AI              | ONNX / CoreML face + tag       | 1–2 (GPU-bound) |
| Mongo upsert    | IO-bound                       | 8               |

### Face detection + clustering

- Detector: a small ONNX model (RetinaFace-mobilenet, ~2 MB) running on CPU or GPU via `ort`.
- Embeddings: ArcFace (mobilefacenet variant, ~5 MB).
- Clustering: HDBSCAN over embeddings; new face → nearest existing `person` within cosine < 0.35 → else new person.
- Re-cluster incrementally every N new faces; full re-cluster is a manual admin action.

### Watch semantics

Uses `notify` (Rust) with debounced batching. Events:

- `Created` → enqueue discover.
- `Modified` → if `mtime` or `sha1Head` changed, re-index that id.
- `Renamed` → preserve id (ids are content-derived, not path-derived); update `file`/`absPath` fields.
- `Removed` → mark `deletedAt`; retain the Mongo doc for 30 days so undo is easy, then GC thumbs+preview.

### Incremental resume

Indexer keeps a `checkpoint` doc per folder: `{ lastWalkedAt, inflightIds }`. On restart, it re-enqueues anything that was in flight and walks folders whose `mtime` is newer than `lastWalkedAt`.

---

## 09 · Maple (iOS/Mac/iPad)

Existing Swift app. This section covers the source model, how Native talks to Self Hosted, and how the shared `.maple/` cache fits in.

### Photo location types

There are four kinds of photo location in the Maple ecosystem. Each product — Hosted, Self Hosted, Native — exposes a subset, and Native exposes all four:

| Photo location                | What it is                                                                                                                                                                                  | Hosted | Self Hosted | Native iOS | Native iPad | Native Mac |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----: | :---------: | :--------: | :---------: | :--------: |
| **iPhoto Library** (PhotoKit) | System Photos + iCloud via `PHPhotoLibrary`                                                                                                                                                 |   —    |      —      |     ✓      |      ✓      |     ✓      |
| **Local Folder**              | A directory the app has read access to. On Mac this includes OS-mounted SMB shares, which appear as ordinary folders. In Hosted this is a File System Access API directory handle.          |   ✓    |      —      |     ✓      |      ✓      |     ✓      |
| **Swift SMB mount**           | SMB2/3 connection owned by the Maple app itself, via an embedded Swift SMB library. Needed on iOS/iPadOS because the OS's SMB support (Files.app bookmarks) is too restrictive to build on. |   —    |      —      |     ✓      |      ✓      |     —      |
| **Bun API**                   | HTTP/WS client against a Maple Self Hosted instance. The only source in Self Hosted's own browser UI.                                                                                       |   —    |      ✓      |     ✓      |      ✓      |     ✓      |

Why Mac doesn't need the Swift SMB library: macOS mounts SMB shares as `/Volumes/...` and they behave as ordinary folders — the app treats them as Local Folders and gets kernel-level SMB caching. iOS and iPadOS have SMB support in Files.app, but third-party apps accessing those shares via security-scoped bookmarks get per-file access only: no persistent handles, no atomic rename for XMP writes. An embedded SMB client in the app bypasses that limitation.

### Swift SMB library

Leading candidates:

- **[SMBClient](https://github.com/kishikawakatsumi/SMBClient)** — pure Swift, actively maintained, SMB2/3. Good fit for a Swift-first codebase; no C FFI. Still relatively young.
- **[AMSMB2](https://github.com/amosavian/AMSMB2)** — Swift wrapper around `libsmb2`. More battle-tested (powers several iOS file manager apps). Better protocol coverage, but carries a C library.

Recommend starting with SMBClient for the pure-Swift build story and the predictable memory profile. Keep AMSMB2 as a fallback if we hit compatibility gaps with specific NAS vendors (Synology's SMB in particular has quirks).

Credentials stored in Keychain per-share. Connection lifecycle — sleep/wake, background transitions, reconnect on network change — is a real chunk of work; budget two weeks.

### ImageSource protocol

Four concrete implementations, one protocol:

```swift
protocol ImageSource {
    func images() async -> [ImageRef]
    func thumb(for: ImageRef) async -> Data
    func preview(for: ImageRef) async -> Data
    func rawBytes(for: ImageRef) async -> Data
    func writeXMP(_ sidecar: Sidecar, for: ImageRef) async throws
    func search(_ q: SearchQuery) async -> [ImageRef]?     // nil = source can't search
}

struct PhotoKitSource: ImageSource { ... }      // PHPhotoLibrary, app-local adj storage
struct LocalFolderSource: ImageSource { ... }   // FileManager over a bookmark URL
struct SMBSource: ImageSource { ... }           // SMBClient/AMSMB2, manages its own connection
struct SelfHostedSource: ImageSource { ... }    // URLSession against Bun API
```

The UI sits above this protocol and doesn't know which concrete type it's holding.

### Native ↔ Self Hosted: API as the primary transport

When Native is paired with a Self Hosted instance, **the Bun API is the default transport for everything**: image lists, thumbs, previews, RAW bytes, XMP writes, search. Reasons:

- API works on any network — LAN, Tailscale, Cloudflare Tunnel. SMB needs a VPN to leave the LAN.
- API carries Mongo-backed features — search, face clusters, keyword queries, cross-folder albums — that no filesystem source can provide.
- Pairing is a QR scan. No credentials to manage per-share.

API is strictly more capable than any filesystem source; SMB's only advantage is raw byte throughput on the LAN.

### SMB as an optional fast path (composed source)

When Native is paired with a Self Hosted **and** the same folder is also reachable as SMB — OS-mounted on Mac, or via the Swift library on iPad/iOS — Native composes the two sources:

```swift
let source = ComposedSource(
    metadata: SelfHostedSource(server: pairedServer),
    bytes: SMBSource(share: smbShare) ?? LocalFolderSource(url: macMount),
    coverage: .same(folder: "France-trip")
)
```

Routing rules:

| Operation               | Composed source                                    | API-only source                               |
| ----------------------- | -------------------------------------------------- | --------------------------------------------- |
| Thumb, preview          | Self Hosted API (pre-rendered, cached server-side) | Self Hosted API                               |
| Full RAW bytes          | SMB (kernel cache on Mac, Swift lib on iPad/iOS)   | Self Hosted API, streamed from disk           |
| XMP write               | SMB (atomic rename; library handles tmp+rename)    | Self Hosted API `PUT /adj`; server writes XMP |
| Search, faces, keywords | Self Hosted API                                    | Self Hosted API                               |
| EXIF, GPS               | Self Hosted API (from Mongo)                       | Self Hosted API                               |

The XMP write loop converges regardless of path: SMB write → Indexer fs watcher → Mongo. API write → Server writes XMP → Indexer fs watcher → Mongo. Same file, same `mtime`, same row. The Indexer is the reconciliation point — the transport doesn't leak into the data model.

### Device defaults

| Device         | Default                                              | Fast path when available                                                            |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mac on LAN     | Self Hosted API                                      | SMB via OS mount (Local Folder), auto-detected when share path overlaps server path |
| Mac off LAN    | Self Hosted API (via Cloudflare Tunnel or Tailscale) | —                                                                                   |
| iPad on LAN    | Self Hosted API                                      | Swift SMB for RAW + XMP when paired and same share configured                       |
| iPad off LAN   | Self Hosted API                                      | —                                                                                   |
| iPhone on LAN  | Self Hosted API                                      | Swift SMB, same code path as iPad                                                   |
| iPhone off LAN | Self Hosted API                                      | —                                                                                   |

### PhotoKit caveat

PhotoKit doesn't give direct file access to originals and doesn't support XMP sidecars. For PhotoKit-backed images, Maple stores state inside its own local database (per-image `adj` keyed by `PHAsset.localIdentifier`) and exports adjustments baked into the output. It does **not** write back into the Photos library. Non-PhotoKit sources (Local Folder, Swift SMB, Bun API) behave identically — XMP is canonical.

### Shared-cache behavior (filesystem-like sources)

When Maple opens a source whose images live in a folder-like structure — Local Folder, Swift SMB, or (indirectly) the file tree behind a Bun API connection — it:

1. Looks for `.maple/thumbs/` and `.maple/previews/` and uses them if present.
2. If present and the files pass the `(size, mtime)` freshness check, uses them directly. Zero decode cost on first browse.
3. If absent, renders thumbs and previews as the user scrolls, writes them to `.maple/` in the background (respecting read-only mounts — falls back to an app-container cache keyed by the source's bookmark when it can't write).

For a Bun API source, the Indexer has already populated `.maple/` on the server, and the API serves those files directly over HTTP — so Native doesn't need filesystem access to benefit from them.

This is the payoff of the shared cache: a Self Hosted that indexed a share produces `.maple/` files that a Mac mount, an iPad Swift-SMB connection, and a direct Bun API client all reuse without re-rendering.

### Offline behavior

| Source                                 | Offline story                                                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhoto Library                         | Fully offline. State is local.                                                                                                                                                                              |
| Local Folder (local or OS-mounted SMB) | Fully offline for local; SMB depends on OS cache (macOS: good).                                                                                                                                             |
| Swift SMB                              | Works only when the share is reachable. No offline cache initially.                                                                                                                                         |
| Bun API                                | Offline when the server is unreachable. Optional sync of Mongo subset + recent thumbs to an app-container sqlite for offline browse (read-only); pending XMP writes queue and flush on reconnect. Deferred. |

### Core integration

`libmaple_core.a` built for `arm64-apple-ios`, `arm64-apple-ios-sim`, and `arm64-apple-darwin`, wrapped with UniFFI into a `MapleCore` Swift package. All RAW decoding, develop, and XMP serialization happen in the same Rust that Hosted and Self Hosted use.

---

## 10 · Cross-product behavior matrix

| Concern                 |           Hosted            |         Self Hosted          |                    Native                     |
| ----------------------- | :-------------------------: | :--------------------------: | :-------------------------------------------: |
| RAW decode              |            WASM             | WASM (UI) + native (Indexer) |                 native (FFI)                  |
| Writes XMP              | opt-in (File System Access) |             yes              |              yes (non-PhotoKit)               |
| Reads `.maple/` thumbs  |             yes             |             yes              |                      yes                      |
| Writes `.maple/` thumbs |           opt-in            |      yes (via Indexer)       |                      yes                      |
| MongoDB                 |              —              |             yes              |         read-only via Self Hosted API         |
| Face detection          |              —              |        yes (Indexer)         |        yes (Vision framework, offline)        |
| Cross-folder search     |              —              |             yes              | only when a Self Hosted instance is reachable |
| Export                  |          download           |   download or save-to-disk   |          save-to-disk or share sheet          |
| Folder watch            |              —              |        yes (Indexer)         |               FSEvents on macOS               |

---

## 11 · Open questions

1. **Web + libraw size.** libraw compiled to WASM is ~4 MB gzipped. Feature-gate decoders by vendor and lazy-load the right one per file? Or ship everything? Defaulting to lazy.
2. **Multi-user for Self Hosted.** Starts single-user. Does it eventually need per-user ratings/flags, or is the library model strictly one-person-per-install? Cheap answer: add a `userId` field now, default it to `"self"`, defer the UI.
3. **Sidecar ownership when Maple Self Hosted and Maple both write.** Two devices editing the same image while offline will diverge. Proposed: last-write-wins with a visible conflict banner in the inspector, plus a keep-both action that forks the XMP.
4. **PhotoKit assets in the shared cache.** A PhotoKit asset has no folder to put `.maple/` in. Proposal: a user-level cache `~/Library/Caches/Maple/photokit/<localIdentifier>/`. Not shared across devices, but iCloud's own thumbnails already fill that role.
5. **AI model distribution.** Shipping ONNX weights inside the Self Hosted binary vs. downloading on first run. Preference: bundle the small face model, download the tagger.
6. **GPU on Indexer.** ONNX Runtime supports CoreML, CUDA, DirectML. On his Proxmox RTX 2070, CUDA works; on Mac, CoreML. Abstract the backend selection behind an env var.
7. **Signing/auth for LAN access to Self Hosted.** Tailnet-only by default? Or ship a built-in bearer-token flow with a QR code for native pairing?
8. **Conflict between the spec's single-folder "source" model and Mongo-backed virtual albums.** The interaction spec (§01, §10) keys off a single `source`. Cross-folder albums imply the "source" is a query, not a folder. Resolved trivially by widening the source type from `FolderId | SmartAlbum` to `FolderId | SmartAlbum | AlbumId | Query`; flagging for Design confirmation.
9. **Swift SMB library choice.** SMBClient (pure Swift, young) vs AMSMB2 (Swift-over-libsmb2, mature). Initial preference is SMBClient; a spike against Synology, TrueNAS, and raw Samba will confirm. Escape hatch is to wrap both behind an internal `SMBClient` protocol so we can swap without touching callsites.
