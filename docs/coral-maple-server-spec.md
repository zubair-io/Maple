# Maple — Server spec

Version: v0.1 · Status: draft · Owner: Zubair
Targets: self-hosted first (NAS, home server, personal VPS). Hosted SaaS is
out of scope for this document.

## 1. What this spec is

There is already a `server/` package in this repo — Bun + Elysia + chokidar +
sharp, with folder-scan, thumbnail/preview cache, sidecar read/write, and an
SSE stream. The native apps already write thumbnails to the same
`.maple/thumbs/` layout. This spec formalizes what's there and fills the
four goal-shaped gaps the product needs next:

1. Native apps can connect to a server-hosted library as a first-class source.
2. The app cache (`.maple/`) is shared bit-for-bit between server and native.
3. The browser UI mirrors the native three-column shell (sources / grid /
   inspector).
4. A persistent metadata DB powers dedup, full-text search, tags, a map, and
   people matching.

It is scoped as an _extension_ of the existing Bun/Elysia server — not a
rewrite.

## 2. Goals

- **G1. Library-as-source.** A library is a _collection of folders_ a user
  has added (`/Volume/Photos/France`, `~/Pictures/2025`, an external SSD
  mount, …). The library is addressable from Mac, iPad, iPhone, and the
  browser as one unified source. Edits made on any client roam via XMP
  sidecars and stay consistent.
- **G2. Shared cache.** Server-generated thumbnails and previews live in
  `.maple/` next to the originals _in each source folder_. Native clients
  on the LAN read the same files directly via SMB/filesystem; remote
  clients read via the server API. No duplication, no divergence.
- **G3. Parity UI.** Browser UI reuses the three-column shell from the native
  app: sources tree / grid / detail inspector in browse mode; filmstrip /
  image / inspector in full-image mode. Same Just Maple dark theme tokens.
- **G4. Metadata index.** A central MongoDB instance (running as a sibling
  container to the server, with its own data volume — not per-folder)
  tracks the configured folders, their contents, and derived signals —
  EXIF + XMP + perceptual hash + text index + geocode + face embeddings —
  so the UI can dedup, search, tag, pin to a map, and match faces without
  walking the filesystem on every query.

### 2.1 Vocabulary (used consistently below)

- **Library.** The user-facing collection. Has a name, a DB, a set of
  source folders. Most installs have exactly one library.
- **Source folder** (or just "folder" in context). A disk path the user
  has added to a library. Library ⊇ many source folders. Source folders
  may live on local disk, an SMB mount, an external drive — anything the
  OS presents as a path.
- **Library root.** Obsolete term — replaced by "source folder". Early
  drafts of this spec assumed a single root. That model is gone.
- **Server state dir.** A separate directory (set via `CORAL_STATE_DIR`
  env, default `~/.maple-maple/` on macOS or `/var/lib/maple-maple/` in a
  container) where the server keeps the DB, config, and logs. Distinct
  from any user photo folder.

## 3. Non-goals

- Hosted/multi-tenant SaaS (deferred; auth today is single-household).
- Editing on the server (render pipeline remains client-side — Swift Metal +
  Rust FFI on native, WASM + WebGL2 in the browser).
- Replacing the native `FilesystemSource` or `PhotoKitSource`. Those stay;
  the server is a third source alongside them.
- Conflict-free multi-writer sync. Sidecar last-writer-wins with a version
  counter is the v1 model (see § 8.3).

## 4. Architecture at a glance

Deployed as a docker-compose stack — three long-running containers plus
the user-content volumes they mount.

```
┌────────────────────────────────────────────────────────────────────┐
│ docker-compose stack                                               │
│                                                                    │
│   ┌────────────────────┐        ┌────────────────────┐             │
│   │  maple-server      │◀──────▶│  maple-mongo       │             │
│   │  Bun + Elysia      │  mongo │  mongo:7           │             │
│   │  sharp + raw-core  │  :27017│                    │             │
│   │  chokidar watchers │        │  volume:           │             │
│   │  worker pool       │        │   maple-mongo-data │             │
│   │  (index/thumb/     │        │    /data/db        │             │
│   │   hash/geocode/    │        └────────────────────┘             │
│   │   face/caption/    │                                           │
│   │   ocr/embed)       │        ┌────────────────────┐             │
│   │                    │◀──────▶│  maple-proxy       │             │
│   │  :3000 (API + SPA) │  http  │  Caddy / Nginx     │             │
│   └─────────┬──────────┘        │  :80 / :443 + TLS  │             │
│             │                    └──────────┬─────────┘             │
│   mounts:                                   │                      │
│   - $CORAL_STATE_DIR → /state               │                      │
│   - each source folder → /mnt/sources/<N>   │                      │
└─────────────────────────────────────────────┼──────────────────────┘
                                              │
                                              ▼
  ┌────────────────┐                    ┌────────────────────┐
  │ macOS / iPad   │  SMB/FS direct     │ Remote clients     │
  │ (native)       │◀───────────────────│ (browser, or       │
  │                │                    │  native off-LAN)   │
  │ FilesystemSrc  │          HTTP/SSE  │                    │
  │ SMBSource      │◀──────────────────▶│ ServerSource       │
  │ ServerSource   │                    │                    │
  └────────────────┘                    └────────────────────┘

Disk layout:

  $CORAL_STATE_DIR/              (host-mounted → /state in container)
    config.json                  mongo URI, bearer token, model paths
    models/*.onnx                face / caption / embed weights
    logs/

  <any source folder>/           e.g. /Volume/Photos/France
    IMG_001.DNG, IMG_001.xmp, …
    .maple/
      source.json                folder UUID + library back-ref
      thumbs/…, previews/…, faces/…

  (maple-mongo-data volume)      mongo's own dbPath; no user files here
```

**Canonicality rule.** The filesystem is the source of truth for _user
content_ — originals, sidecars, and each source folder's `.maple/` cache
are authoritative. MongoDB is a rebuildable index — `docker volume rm
maple-mongo-data && restart` must always converge back to correct state
by re-walking the source folders listed in `config.json`.

**Three separate stores, three separate rebuild stories:**

- **Source folders** (user photos). Lost → unrecoverable. Back up these.
- **`.maple/` caches** inside each source folder. Lost → regenerated by
  `thumb-warm` / `preview-warm` workers on next visit.
- **MongoDB volume**. Lost → re-indexed from scratch across all source
  folders. The source-folder list itself is duplicated into each folder's
  `.maple/source.json` so a transplanted drive can re-advertise itself to
  a rebuilt server with no operator intervention.

**Progressive-indexing rule:** the server is usable from the first second
after startup. Indexing a 100k-asset library takes minutes to tens of
minutes; the UI cannot block on that. Every endpoint must have a
"filesystem-only fallback" path that works before the DB knows about a
given asset, and every worker runs in the background with progress
published over SSE. See § 4.5 for the specific strategy.

## 4.5 Indexing strategy (progressive, priority-queued)

Scanning everything upfront doesn't scale — 100k assets × EXIF read ≈ 5–20
min on a NAS, and the user wants to browse _now_. The server solves this
with three principles.

### 4.5.1 Always a filesystem fallback

Tree browse, folder listings, thumbnails, previews, and sidecar read/write
all work against the filesystem directly. They _prefer_ the DB when it has
the data (faster, richer), but never require it.

Concretely: `GET /api/libraries/:id/folders?source=<uuid>&path=<rel>` uses
`listDirectory` against the resolved source-folder root (one `readdir` +
one `readdir` per child folder for counts — O(children), not O(library)).
It returns a useful tree before the indexer has touched a single doc. The
top level of the tree — the user's set of source folders — comes from
the `source_folders` collection, which is authoritative and cheap (a
dozen docs, not a walk).

The DB layer is an _enrichment_: EXIF, pHash, `$text`-indexed tokens,
geocoded place names, face embeddings. Features that depend on the DB
(search, map, duplicates, people) show a "still indexing — N% done"
state until enough of the library is covered to be useful.

### 4.5.2 Priority queue — user-visible first

The `index` worker does not walk the tree depth-first in alphabetical
order. It runs a priority queue, highest to lowest:

1. **Foreground.** The folder the user is currently viewing in the UI.
   When a client hits `GET /api/folders?path=X` or
   `GET /api/images?folder=X`, the server enqueues an `index` job for `X`
   at the highest priority. By the time the grid finishes painting
   thumbnails, the DB rows for that folder are in.
2. **Recently browsed.** Folders the user opened in the last session.
   Kept in a small LRU on disk (`<root>/.maple/browse-history.json`).
3. **Pinned / favorited.** Any folder the user has starred in the left nav.
4. **Recent by mtime.** Walk the tree ordered by folder mtime descending,
   so 2026 photos get indexed before 2008 photos. Most users care about
   recent work.
5. **Long tail.** Everything else, alphabetical.

The UI never waits on anything below priority 1. Priorities 2–5 run
opportunistically in the background at reduced I/O priority (see § 4.5.4).

### 4.5.3 Incremental, resumable, idempotent

- **Incremental.** Indexer processes in batches of 100 assets per
  `bulkWrite` op (ordered: false) against the `assets` collection. A batch
  round-trip of a few hundred ms doesn't block the event loop for other
  requests (the Node Mongo driver does I/O off-thread).
- **Resumable.** Crash, SIGKILL, machine reboot mid-index — on restart
  the indexer finds assets where `assets.mtime` < file mtime (or no doc
  exists) and re-enqueues only those. Already-indexed assets are skipped.
- **Idempotent.** Re-running `index` on an already-indexed folder is a
  no-op: each asset doc is upserted by `(source_folder_id, rel_path)` with
  an mtime guard in the update filter. Lets the chokidar watcher naively
  enqueue `index` on every FS event without correctness concerns.

### 4.5.4 Resource budgeting

A background indexer that saturates the NAS ruins the foreground
experience (editor preview loads lag, thumbs stall). Budgeting:

- **Concurrency caps per worker kind.** `index` = 4 in-flight; `thumb` = 2;
  `hash` = 2; `face` = 1 (GPU-bound). Configurable; defaults tuned for an
  8-core NAS.
- **Foreground priority pre-emption.** When a priority-1 job arrives, the
  worker pool finishes its current unit and switches immediately. No unit
  of work takes more than ~200 ms.
- **I/O pacing.** Long-tail walks use `fs.promises` with a 10 ms yield
  every 50 files, so chokidar and foreground HTTP aren't starved.
- **Night mode.** Heavy work (face embedding, SHA-256 across the tail)
  is optionally gated to a configurable window (e.g. 01:00–07:00 local).
  Opt-in; off by default.

### 4.5.5 Thumbnails are lazy, not eager

Two strategies for thumbnail generation, both present:

- **Lazy (on request).** Current behavior in `thumbnail-generator.ts` —
  first `GET /api/thumbnails/<path>` that misses the cache generates it.
  Stays as the default.
- **Warm (background).** A `thumb-warm` worker pre-generates thumbs for
  the folder the UI is currently viewing + the next-most-likely folder
  (prefetch heuristic — siblings, then parent, then pinned folders).
  Lower priority than `index`. Never walks the whole library eagerly.

The native app already generates thumbnails into the same
`.maple/thumbs/<filename>.jpg` layout. Any worker in either process
checks for file existence before generating, so work is shared for free.

### 4.5.6 What the UI shows during indexing

- Top of the window: a slim progress strip, dismissible. `"Indexing — 12,480
of 50,391 assets · 14% · ~9 min left"`. Clickable to open a jobs panel.
- Grid cells: assets that exist on disk but have no DB doc render with
  filename + mtime from the folder listing and a small "⋯" spinner in the
  corner of the inspector until their EXIF lands.
- Search bar: disabled until the text index is populated for ≥ 95% of
  assets. Dimmed with tooltip "Search available after initial index
  completes." Dedup / map / people views similarly gated with progress
  chips.

### 4.5.7 Performance expectations (from § 12, reiterated here for the strategy)

- Library with 100k assets, cold start, 8-core NAS, sharp thumb gen off-path:
  - Priority-1 foreground indexing of a 500-photo folder: ≤ 4 s.
  - Long-tail full index (EXIF + XMP): ≤ 20 min.
  - Long-tail thumbnail generation: ≤ 90 min (dominant cost).
  - Priority-1 never blocked by priority-5 work.

## 5. Existing code → target code mapping

What lives today:

| Path                                                 | Today                                       | Target                                                           |
| ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `server/src/index.ts`                                | Elysia bootstrap, SSE, static SPA serve     | +auth middleware, +library registry, +job worker pool            |
| `server/src/routes/images.ts`                        | `GET /api/images` — folder scan per request | `GET /api/libraries/:id/assets` — DB-backed, paginated, filtered |
| `server/src/routes/thumbnails.ts` / `preview.ts`     | On-demand sharp generation into `.maple/`   | Same, but with job-queue back-pressure + format negotiation      |
| `server/src/routes/sidecars.ts`                      | Read/write `.xmp` siblings                  | +version header, +broadcast on SSE, +write-through to DB         |
| `server/src/services/folder-scanner.ts`              | Walks directory recursively                 | Called by indexer worker, not per-request                        |
| `server/src/services/thumbnail-generator.ts`         | Sharp, `.maple/thumbs/*.jpg` at 560px q80   | Add Rust path for RAW (reuse `raw-core`)                         |
| `web/projects/browse/src/app/pages/browse-page/`     | Flat grid page                              | Three-column shell (goal G3)                                     |
| `web/projects/browse/src/app/pages/edit-page/`       | Minimal editor viewport                     | Full-image mode with filmstrip + detail inspector                |
| `web/projects/maple-common/`                         | Shared pipeline + shader sources            | +shared UI tokens + shared API types                             |
| `Packages/MapleCore/Sources/MapleCore/Filesystem/`   | `FilesystemSource` + bookmarks              | No change                                                        |
| `Packages/MapleCore/Sources/MapleCore/SMB/`          | `SMBServerConfig` + keychain                | No change                                                        |
| `Packages/MapleCore/Sources/MapleCore/Server/` (NEW) | —                                           | `ServerSource` — URLSession client, SSE, auth token storage      |

Nothing in the existing server/web/native tree gets thrown out.

## 6. Data model

### 6.1 Filesystem layout

Two separate disk areas. Neither references the other via OS-level paths
hardcoded in code — the server-state dir is configurable via
`CORAL_STATE_DIR`, and source-folder paths are DB-resident and may change
over time (external drive remounts, SMB share renames).

**Server state dir (`$CORAL_STATE_DIR`, default `~/.maple-maple/`):**

```
$CORAL_STATE_DIR/
  config.json                        bearer token, default library,
                                     mongo URI, server host/port,
                                     face/caption/OCR model paths
  logs/server-YYYY-MM-DD.log
  models/                            downloaded ONNX / GGUF weights
    scrfd-10g.onnx                   face detection
    arcface-r100.onnx                face embedding
    siglip-base.onnx                 CLIP-style image embedding
    blip2-opt.onnx                   caption
    tessdata/                        OCR language packs
```

The metadata DB is **not** a file in this directory — it lives in a
separate MongoDB container with its own data volume (see § 8.1 Docker
layout). `$CORAL_STATE_DIR` holds only the server's own configuration
and downloaded model weights.

**Each source folder (user-added disk path):**

```
<source-folder>/                     e.g. /Volume/Photos/France
  <any folder layout the user wants>/
    IMG_001.DNG                      original (immutable)
    IMG_001.xmp                      sidecar (crs: + papp: — see feature spec)
    .maple/
      source.json                    { library_id, source_folder_id, added_at }
      thumbs/IMG_001.DNG.jpg         560px long-edge, q80
      previews/IMG_001.DNG.jpg       2048px long-edge, q85
      faces/<face_id>.jpg            optional face-crop cache
```

`source.json` is the _only_ new filesystem artifact. It lets a removable
drive that has been registered with one server self-identify when
remounted somewhere else — the server can detect "I've seen this source
folder before under a different path" and relink the DB rows by
`source_folder_id` instead of re-indexing from scratch.

No change to sidecar format. `photo-app-feature-spec.md § "Sidecar schema
(v1)"` is still the contract.

### 6.2 MongoDB collections

The DB runs in its own container (see § 8.1), reachable via
`config.json → mongo.uri` (default `mongodb://maple:maple@mongo:27017/maple`).
One database (`maple`) holds all libraries and all source folders. The
schema is rebuildable from the filesystem at any time — walk each
source folder listed in `source_folders` and re-upsert assets.

**Design conventions:**

- All documents use `_id: ObjectId`. User-facing identifiers that need
  to be stable across server moves (library, source folder, person) use
  a `uuid` field in addition.
- Foreign keys are `ObjectId` references (not `$lookup`-heavy joins);
  denormalize read-path fields onto the asset where it pays off
  (`tags: [string]`, `person_ids: [ObjectId]`).
- Timestamps are `Date` — Mongo-native, not unix nanoseconds.
- Binary data (face/CLIP embeddings, pHash bytes, SHA-256 digests) is
  `BinData` subtype 0. Embeddings are stored as `f16` to halve size vs
  `f32` without material recall loss.
- All dates/paths/text fields that flow into search land in a single
  consolidated text index on `assets` so `$text: { $search: "..." }`
  covers filename + caption + ocr_text + place_name + camera + tags in
  one query.

#### `libraries`

```js
{
  _id: ObjectId,
  uuid: UUID,                    // stable; exposed in API as :lib_id
  name: "Family photos",
  created_at: ISODate,
  settings: {
    geocoder: "nominatim",       // 'nominatim' | 'mapkit'
    face_detection_enabled: true,
    caption_enabled: true,
    ocr_enabled: false,
    night_mode: { start: "01:00", end: "07:00" },
  }
}
// Index: { uuid: 1 }   unique
```

#### `source_folders`

One per user-added disk path. When a drive remounts at a different path,
the server updates `current_path` on the existing document rather than
creating a new one (matched via `uuid` in `.maple/source.json`).

```js
{
  _id: ObjectId,
  library_id: ObjectId,          // → libraries._id
  uuid: UUID,                    // also written to .maple/source.json
  name: "France 2026",           // user-visible; defaults to path leaf
  current_path: "/Volume/Photos/France",
  last_seen_at: ISODate,
  available: true,               // false when path unreachable
  added_at: ISODate,
  volume_uuid: "…",              // OS volume UUID for remount detection
  stats: {
    asset_count: 12483,
    indexed_count: 9120,
    bytes_total: 583_000_000_000,
  }
}
// Indexes:
//   { library_id: 1 }
//   { uuid: 1 }                 unique
```

#### `assets`

The hot collection. One document per original file.

```js
{
  _id: ObjectId,
  library_id: ObjectId,          // denormalized (via source_folder) for fast filter
  source_folder_id: ObjectId,
  rel_path: "France/Paris/IMG_001.DNG",   // relative to source_folder.current_path
  filename: "IMG_001.DNG",
  size_bytes: 104_857_600,
  mtime: ISODate,
  sha256: BinData,               // nullable until `hash` worker fills it
  phash64: Long,                 // perceptual hash; nullable until hashed
  format: "dng",                 // 'dng' | 'jpeg' | 'cr3' | ...

  // Dimensions + EXIF (from `index` worker)
  width: 8280,
  height: 6208,
  orientation: 1,
  captured_at: ISODate,          // null if no EXIF timestamp
  camera: {
    make: "Hasselblad",
    model: "L3D-100c",
    lens: "35mm f/1.8",
    iso: 400,
    aperture: 2.8,
    shutter: 0.004,
    focal_mm: 35.0,
  },

  // Location (GeoJSON Point; supports $near and $geoWithin natively)
  location: {
    type: "Point",
    coordinates: [ 2.3522, 48.8566 ],    // [lon, lat] — GeoJSON order
    altitude: 48.0,
    place_name: "Paris, France",         // reverse-geocode cache
  },

  // Sidecar mirror (extracted fields only; full XMP stays on disk)
  sidecar: {
    version: 7,                  // bumped on every successful PUT
    mtime: ISODate,
    rating: 4,                   // -1..5
    color_label: "yellow",       // red|yellow|green|blue|purple|null
    flag: "pick",                // pick|reject|null
  },

  // User tags (denormalized for fast filter/grid render)
  tags: [ "family", "paris-trip", "film-scan" ],

  // AI outputs (from caption/ocr/embed workers)
  ai: {
    caption: "A woman in a red coat walking across Pont Neuf at dusk.",
    caption_model: "blip2-opt-2.7b@v1",
    caption_at: ISODate,
    auto_tags: [ "bridge", "dusk", "person", "coat" ],
    ocr_text: "",                // often empty for photos
    ocr_lang: null,
    ocr_model: "tesseract-5.3",
    clip_embedding: BinData,     // 768 × f16 = 1.5 KB (SigLIP-base)
    clip_model: "siglip-base-patch16@v1",
  },

  // Denormalized person list for fast filter ("photos of Alice + Bob")
  person_ids: [ ObjectId, ObjectId ],

  // Bookkeeping
  indexed_at: ISODate,
  extra: { /* any EXIF/XMP fields not promoted, dumped verbatim */ },
}
// Indexes:
//   { library_id: 1, captured_at: -1 }              grid sort default
//   { library_id: 1, mtime: -1 }                    grid sort by import date
//   { source_folder_id: 1, rel_path: 1 }            unique
//   { phash64: 1 }                                  dedup lookup
//   { location: "2dsphere" }                        map + $geoWithin
//   { "sidecar.rating": 1 }, { "sidecar.flag": 1 }  cull filters
//   { tags: 1 }, { person_ids: 1 }                  left-nav drill-downs
//   Text: { filename: "text", "ai.caption": "text",
//           "ai.ocr_text": "text", "ai.auto_tags": "text",
//           tags: "text", "location.place_name": "text",
//           "camera.model": "text" }
//           weights: caption 10, ocr 5, tags 8, filename 3, place 5
//           default_language: "english"
```

#### `faces`

```js
{
  _id: ObjectId,
  asset_id: ObjectId,
  library_id: ObjectId,
  bbox: { x: 0.23, y: 0.18, w: 0.12, h: 0.16 },   // normalized 0..1
  embedding: BinData,            // 512 × f16 = 1 KB (ArcFace)
  person_id: ObjectId,           // null until clustered
  confidence: 0.94,
  detected_at: ISODate,
}
// Indexes: { asset_id: 1 }, { person_id: 1 }, { library_id: 1, person_id: 1 }
```

#### `persons`

Clustered identities. `name` is null until the user labels the face.

```js
{
  _id: ObjectId,
  library_id: ObjectId,
  uuid: UUID,                    // stable across clustering reruns
  name: "Alice",                 // null = unnamed cluster
  centroid: BinData,             // mean embedding (512 × f16)
  face_count: 142,
  cover_face_id: ObjectId,       // face to show on the person card
}
// Indexes: { library_id: 1 }, { uuid: 1 } unique
```

#### `dup_clusters`

```js
{
  _id: ObjectId,
  library_id: ObjectId,
  canonical: ObjectId,           // → assets._id
  members: [ ObjectId ],
  confidence: 0.93,              // 1.0 = sha256 equal; lower = pHash-only
  detected_at: ISODate,
}
// Indexes: { library_id: 1 }, { members: 1 }
```

#### `jobs`

```js
{
  _id: ObjectId,
  library_id: ObjectId,
  kind: "index",                 // index|thumb-warm|preview-warm|hash|
                                 // geocode|face-detect|face-embed|
                                 // face-cluster|caption|ocr|embed|watch-sync
  payload: { … },                // kind-specific
  priority: 1,                   // 1 = foreground, 5 = long tail (§ 4.5.2)
  state: "queued",               // queued|running|done|failed
  progress: 0.0,                 // 0..1
  error: null,
  created_at: ISODate,
  started_at: null,
  finished_at: null,
  attempts: 0,
}
// Indexes: { state: 1, priority: 1, created_at: 1 }   dispatch order
//          { library_id: 1, kind: 1, state: 1 }       UI filters
// Capped collection NOT used — jobs are queried by state, deleted on completion
// after a retention window (default: 7 days for `done`, forever for `failed`).
```

**Why MongoDB for this workload:**

- 500k+ assets × ~8–10 KB/doc is ~5 GB of structured data — well inside
  the single-shard comfort zone.
- Document shape maps naturally to "one asset, many optional enrichments"
  (EXIF, XMP, location, caption, OCR, embeddings). No migration story
  every time we add a new enrichment field — just write it onto new docs
  and backfill if needed.
- Built-in `$text` index handles FTS across filename + caption + OCR +
  tags without a separate index engine.
- `2dsphere` is native and good enough for the map view at any zoom.
- Docker deployment is one container + one volume.

**What it doesn't give us:** vector similarity search on embeddings is
not available in self-hosted MongoDB (Atlas Vector Search is Atlas-only).
That's resolved in § 14.1 (the pragmatic answer: linear-scan kNN in the
worker while the library is < ~100k embeddings; upgrade to a sidecar
vector index — Qdrant or LanceDB — only when that becomes a bottleneck).

### 6.3 What's NOT in the DB

- The sidecar payload itself. The `assets.sidecar` sub-document mirrors the
  user-visible fields (rating, label, flag) and carries a monotonic
  `version` counter; the full XMP stays in the `.xmp` file. Regenerating
  the DB from sidecars is the recovery path.
- Thumbnails or previews. Paths are deterministic from `source_folder_id` +
  `rel_path`; files are in `<source>/.maple/{thumbs,previews}/`.
- Face thumbnails. Face crops are generated on demand from the original +
  bbox at query time (optionally cached in `<source>/.maple/faces/<face_id>.jpg`).
- Original image bytes. Ever. The filesystem is the only store for originals.

## 7. HTTP API

Base: `http://<host>:<port>/api`. All endpoints require a bearer token
once auth lands (§ 8.2).

### 7.1 Libraries

```
GET  /api/libraries                        → [{ id, name, stats }]
POST /api/libraries                        { name }                  → { id, ... }
GET  /api/libraries/:id                    → { id, name, stats, settings }
PATCH /api/libraries/:id                   { name?, settings? }      → { id, ... }
POST /api/libraries/:id/reindex            → { job_id }
```

v1 will almost always have a single library. The shape is multi-library
from the start so the UI doesn't refactor later.

`stats` on the library level: total asset count, unique formats, bytes
on disk, index progress, last-event timestamps.

### 7.1.1 Source folders

The user's set of folders inside a library. This is what the left-nav
"Libraries" section in the browse UI lets you add and remove (§ 10.1).

```
GET  /api/libraries/:id/folders
   → [ { id, name, current_path, available, stats, added_at } ]

POST /api/libraries/:id/folders/preview       # dry-run: validate path
     { path: "/Volume/Photos/France" }
   → {
       ok: true,
       absolute_path: "/Volume/Photos/France",
       volume_uuid: "...",
       already_has_maple: false,             # if true, we'll just relink
       existing_source_folder_id: null,      # non-null = drive seen before
       first_pass_estimate: { asset_count_seen: 412, scanned_seconds: 0.4 },
     }
   → 400 with {error, suggestion} if path doesn't exist, is unreadable,
     escapes the container mount, or collides with another source folder

POST /api/libraries/:id/folders               # commit
     { path, name? }
   → { id, ... }                              # enqueues priority-1 index job

DELETE /api/libraries/:id/folders/:folder_id
     ?remove_cache=<bool>                      # also rm .maple/ (default false)
   → { removed_asset_count, cache_removed }

PATCH /api/libraries/:id/folders/:folder_id
     { name?, available? }                    # rename / mark manually offline
   → { id, ... }

POST /api/libraries/:id/folders/:folder_id/reindex
   → { job_id }
```

Design notes worth calling out:

- **Preview before commit.** The "Add folder" UI (§ 10.1) calls `preview`
  first so the user sees whether the path is valid, roughly how many assets
  it has, and whether it's a drive we've indexed before — before they
  commit and kick off work.
- **Remove is cheap.** Delete only removes DB docs and (optionally) the
  `.maple/` cache. Originals and sidecars are never touched.
- **Container mount constraint.** In Docker mode, source-folder paths must
  be mounted into the container (typically under `/mnt/sources/`). The
  preview endpoint validates the path is actually reachable and returns a
  helpful error otherwise.

### 7.1.2 Folder tree navigation

Folder-tree navigation inside a source folder. Works off the filesystem
(with DB enrichment when available), so it returns useful results before
indexing completes (§ 4.5.1).

```
GET  /api/libraries/:id/folders/:folder_id/tree?path=<rel>
   → {
       path: "France/Paris",                   # library-rel, source-folder-rel
       subfolders: [
         { name, path, image_count, subfolder_count }
       ],
     }
```

### 7.2 Assets

```
GET  /api/libraries/:id/assets
    ?folder_id=<source-folder-id>      # scope to a specific source folder
    &path=<rel-path>                   # scope to subfolder within that source
    &q=<text-search>                   # full-text over filename + caption + ocr + tags + place
    &tag=<tag-name>   (repeatable)
    &rating_gte=<int> / &rating_lte
    &flag=pick|reject
    &captured_from=<iso> & captured_to=<iso>
    &geo_bbox=<minLon>,<minLat>,<maxLon>,<maxLat>
    &person_id=<id>
    &sort=captured_at|mtime|name         (default: captured_at desc)
    &limit=200&cursor=<opaque>
   → { items: [AssetSummary], next_cursor }

GET  /api/libraries/:id/assets/:asset_id
   → full Asset (EXIF + extracted XMP + ai.caption + ai.auto_tags +
                 ai.ocr_text + dup_cluster_id + faces + person_ids)

GET  /api/libraries/:id/assets/:asset_id/thumb        (302 → static file or inline)
GET  /api/libraries/:id/assets/:asset_id/preview
GET  /api/libraries/:id/assets/:asset_id/original     (range-supported)
```

`AssetSummary` is the minimum a grid cell needs: id, source_folder_id,
rel_path, filename, thumb_url, captured_at, rating, flag, color_label,
has_sidecar, ai.caption (optional — nice for accessibility tooltips),
location (if present).

### 7.2.1 Semantic search

Natural-language search over CLIP/SigLIP embeddings. Back-ended per
§ 14.1 — linear-scan today, sidecar vector index later.

```
GET  /api/libraries/:id/assets/semantic
     ?q=<natural-language-query>           # "sunset over water"
     &limit=100
   → {
       items: [ AssetSummary & { similarity: 0.72 } ],
       model: "siglip-base-patch16@v1",
       scanned: 48120,
     }
```

Text query is embedded with the matching text encoder (same model tag as
`assets.ai.clip_model`) and compared against `assets.ai.clip_embedding`
by cosine similarity. Assets without an embedding are skipped (they'll
show up once the `embed` worker catches up — the `scanned` count in the
response lets the UI render a "N% of library indexed for semantic
search" hint).

### 7.3 Sidecars (edits)

Sidecar write is the only mutation of the filesystem that clients drive.

```
GET  /api/libraries/:id/assets/:asset_id/sidecar
   → { xml, version }                       # version = asset.sidecar_version

PUT  /api/libraries/:id/assets/:asset_id/sidecar
     If-Match: <version>
     Body: XMP XML
   → { version: <new> }                     # 412 Precondition Failed on mismatch
```

Optimistic-concurrency write. Client sends the version it last saw; server
rejects if the sidecar has moved since. The native app and browser both use
the same endpoint — there's no "native writes direct, web writes via API"
split. (Native _can_ write direct to the filesystem when it has a
filesystem source, but against a server-hosted library it goes through
this PUT.)

### 7.4 Tags / people / collections

```
GET  /api/libraries/:id/tags
POST /api/libraries/:id/tags                 { name }
POST /api/libraries/:id/assets/:asset_id/tags    { add: [ids], remove: [ids] }

GET  /api/libraries/:id/people
PATCH /api/libraries/:id/people/:person_id       { name }
POST /api/libraries/:id/faces/:face_id/person    { person_id }   # move face to person
```

Tag writes also update the XMP sidecar (`dc:subject`), so they roam with
the photo. That's why tag endpoints touch sidecar_version too.

### 7.5 Events

```
GET  /api/events       text/event-stream
    events: connected | asset_upserted | asset_removed | sidecar_updated |
            job_progress | job_done
```

Replaces the current `/api/events` to carry structured payloads (today it
just forwards chokidar events). Clients use this to invalidate caches and
live-update grid + inspector without polling.

### 7.6 Map / dedup / jobs

```
GET  /api/libraries/:id/map?zoom=<z>&bbox=...
   → { clusters: [{ lat, lon, count, sample_asset_id }] }   # server-side clustering

GET  /api/libraries/:id/duplicates?min_confidence=0.9
   → { clusters: [{ canonical_id, members: [id], confidence, distance }] }

GET  /api/libraries/:id/jobs
   → [{ id, kind, state, progress }]
POST /api/libraries/:id/jobs/:id/cancel
```

## 8. Deployment, auth, sync

### 8.1 Deployment shapes

All three shapes ship the same docker-compose stack — they differ only in
where it runs and how source folders are mounted.

- **Co-located.** Stack runs on the same machine as storage (NAS with
  Docker, Synology, or a home server). Clients on LAN use SMB/filesystem
  for reads and the API for writes and events. This is the v1 target.
- **Gateway.** Stack runs on a VPS with source folders mounted via SMB
  or rclone; clients anywhere use the API exclusively. Same compose
  file, slower hot path because thumbnails get streamed instead of
  memory-mapped.
- **Embedded.** The Mac app runs `maple-server` + an embedded MongoDB
  (e.g. `mongod --dbpath` under the app's sandboxed container dir) on
  behalf of the household, bound to `localhost` + mDNS so other household
  devices read without setting up a separate box. Phase S6 feature.

**Reference `docker-compose.yml` (abbreviated):**

```yaml
services:
  maple-mongo:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - maple-mongo-data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: maple
      MONGO_INITDB_ROOT_PASSWORD_FILE: /run/secrets/mongo_password
    secrets: [mongo_password]

  maple-server:
    image: ghcr.io/justmaple/maple-server:latest
    restart: unless-stopped
    depends_on: [maple-mongo]
    environment:
      CORAL_STATE_DIR: /state
      CORAL_MONGO_URI: mongodb://maple:${MONGO_PASSWORD}@maple-mongo:27017/maple
    volumes:
      - ${CORAL_STATE_DIR:-./state}:/state
      # User source folders, bind-mounted read-write. Add one line per folder
      # the operator wants available to the server:
      - /Volume/Photos/France:/mnt/sources/france
      - /Volumes/ExternalSSD/Archive:/mnt/sources/archive
    # ports: exposed via maple-proxy, not directly

  maple-proxy:
    image: caddy:2
    restart: unless-stopped
    depends_on: [maple-server]
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - maple-caddy-data:/data

volumes:
  maple-mongo-data:
  maple-caddy-data:
secrets:
  mongo_password:
    file: ./secrets/mongo_password
```

Operator workflow to add a drive to the library:

1. Bind-mount the path into `maple-server` (edit compose, `docker compose up -d`).
2. Inside the `browse` UI, click `⊕ Add folder`, type the _container_ path
   (e.g. `/mnt/sources/france`). The preview endpoint verifies the mount
   is actually reachable and shows an asset-count estimate before the user
   commits.

The server's preview endpoint (§ 7.1.1) validates that the path lives
under an approved prefix (`/mnt/sources/` by default, configurable) to
prevent operators from pointing the server at `/etc` or similar by
accident.

### 8.2 Auth

- Single library credential: a bearer token stored in
  `$CORAL_STATE_DIR/config.json` on the server, provisioned once at
  library-create time (printed to the operator log or surfaced in the
  Mac app's server pairing flow).
- Native clients pair via QR code or paste-a-token; token saved in Keychain
  (same pattern as `SMBServerConfig` uses today).
- Browser clients sign in with the token; stored in `httpOnly` cookie, 30-day
  rotation.
- TLS is the operator's job (reverse proxy: Caddy / tailscale-serve / local
  `mkcert`). The server itself does not terminate TLS in v1.
- No user accounts, no per-photo ACLs. "Household" model — if you can open
  the library, you can see everything in it.

### 8.3 Sidecar sync & conflicts

- `sidecar_version` monotonically increments on every successful PUT.
- Server broadcasts `sidecar_updated { asset_id, version }` via SSE.
- Clients apply `If-Match` on PUT. A 412 response means "someone else wrote
  between your read and your write" → client re-fetches, replays its local
  diff if still applicable, re-PUTs. Same pattern the native app uses for
  its own sidecar store.
- Offline edits on native: buffered in-app, flushed with `If-Match` when
  the server comes back. First-flusher-wins. Losers get a toast with the
  option to re-apply over the winner.
- iCloud Drive sidecar sync (feature spec § Phase 5) is _orthogonal_. A
  library that sits on iCloud Drive without a server works via
  `FilesystemSource` unchanged; the moment a server is introduced the server
  becomes the mediator and iCloud is just a storage backend.

### 8.4 Watching

`chokidar` already watches each source folder. A few rules worth codifying:

- Nothing from the DB lives inside a source folder — MongoDB's data volume
  is isolated from user photo paths, so there's no DB write the watcher
  could observe. The `.maple/` cache _is_ inside source folders, so
  thumb/preview/face writes still need the self-write filter below.
- Original-file writes (e.g. copying a new DNG in) fire `asset_upserted` and
  enqueue an `index` job.
- Sidecar writes detected from outside fire
  `sidecar_updated` and trigger a re-read of the matching asset doc.
- Thumb/preview/face cache writes (self-originated, under `.maple/`) are
  filtered by path pattern so the server doesn't react to its own output.

## 9. Background workers

See § 4.5 for the _strategy_ (progressive, priority-queued, resumable).
This section is the _catalog_ — what kinds of work there are and what each
one does.

Workers run in the same Bun process as Elysia. A `WorkerPool` in
`server/src/workers/pool.ts` owns:

- A dispatcher loop that pulls jobs from the `jobs` MongoDB collection in
  priority order (§ 4.5.2) using `findOneAndUpdate({ state: 'queued' },
{ $set: { state: 'running', started_at: now } }, { sort: { priority: 1,
created_at: 1 } })` — an atomic claim that keeps multiple dispatcher
  loops (one per server process) from double-claiming a job.
- Per-kind concurrency caps (§ 4.5.4) — `index: 4`, `thumb: 2`, `hash: 2`,
  `geocode: 2`, `face: 1`.
- Pre-emption: if a higher-priority job arrives, in-flight jobs finish
  their current unit (≤ 200 ms worth) before the pool re-dispatches.
- Back-pressure: if a kind's queue exceeds `N × concurrency × 50`, newly
  enqueued jobs of that kind are coalesced (dedup by payload key).
- Progress emission: each running job can `post(progress: 0..1)`; the
  pool throttles SSE `job_progress` to ≤ 1 Hz per job.
- Crash containment: a throwing job marks its doc `state='failed'` with
  the error message; the pool keeps processing the rest.

### 9.1 Worker kinds

| Kind           | What it does                                                                                                                                                                                                       | Priority source                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `index`        | Scan new/modified files in a folder, parse EXIF + XMP, upsert `assets` docs in 100-batch `bulkWrite` ops, enqueue dependents (`hash`, `thumb-warm`, `caption`, `ocr`, `embed`, `face-detect`).                     | § 4.5.2 priority queue                 |
| `thumb-warm`   | Pre-generate 560px thumbnails into `<source>/.maple/thumbs/` for folders the user is viewing or likely to view next. Skips files that already have a cached thumb. Cohabits with the lazy on-request `thumb` path. | Same folder-priority source as `index` |
| `preview-warm` | Pre-generate 2048px previews. Runs only for folders the user has _opened_ (not just browsed) — previews are ~4× the bytes of thumbs.                                                                               | Explicit folder-open events            |
| `hash`         | SHA-256 (exact) + pHash-64 (fuzzy). Populate `dup_clusters` when pHash-distance ≤ 5 within ±7 days of capture date. Batch 32 per bulk op.                                                                          | Asset mtime desc; long-tail            |
| `geocode`      | Reverse-geocode `location.coordinates` → `location.place_name`. Pluggable: Apple MapKit (licensed), Nominatim self-host. Cache forever (geography doesn't change).                                                 | Asset mtime desc                       |
| `face-detect`  | Run SCRFD ONNX to find bounding boxes. Writes `faces` docs with `embedding=null`. ~30 ms/image CPU.                                                                                                                | Explicit only — opt-in per library     |
| `face-embed`   | Run ArcFace ONNX on each pending `faces` doc, fill `embedding`. ~80 ms/face CPU, ~8 ms MPS/CUDA.                                                                                                                   | Follows `face-detect`                  |
| `face-cluster` | Batched k-means-style clustering over `faces.embedding` to assign `person_id`. Runs periodically (every N new faces or hourly), not per-face.                                                                      | Timer / threshold                      |
| `caption`      | Vision-language captioning (BLIP-2 or local LLaVA-Mini via ONNX; optional Claude Vision API). Writes `assets.ai.caption` + `auto_tags`. ~800 ms/image CPU, ~120 ms GPU. GPU-bound → concurrency 1.                 | Long-tail; night-mode by default       |
| `ocr`          | Tesseract 5 (lang auto-detect from top-N languages configured per library). Writes `assets.ai.ocr_text` + `ocr_lang`. Opt-in per library — most photos produce empty strings. ~200 ms/image CPU.                   | Long-tail; optional per library        |
| `embed`        | SigLIP / CLIP image embedding for semantic search. Writes `assets.ai.clip_embedding` + model tag. ~80 ms/image CPU, ~6 ms GPU.                                                                                     | Long-tail                              |
| `watch-sync`   | Drain chokidar events into the job queue. Debounces burst events (folder copy). Always highest concurrency.                                                                                                        | Real-time                              |

**Dependency graph between workers** (drawn out because the fan-out matters for
backfill scheduling):

```
  (chokidar event)
       │
  watch-sync ──► index ─┬─► thumb-warm
                        ├─► hash        ──► (dup_clusters updates)
                        ├─► geocode
                        ├─► caption     ──► auto_tags into text index
                        ├─► ocr         ──► ocr_text into text index
                        ├─► embed       ──► clip_embedding (semantic search)
                        └─► face-detect ──► face-embed ──► face-cluster
```

Every worker obeys the concurrency caps and the "priority-1 pre-emption"
rule from § 4.5.4. Concurrency defaults, tuned for an 8-core NAS:

- `index` = 4, `thumb-warm` = 2, `preview-warm` = 2
- `hash` = 2, `geocode` = 2
- `face-detect` = 2, `face-embed` = 1, `face-cluster` = 1
- `caption` = 1 (GPU or large-model CPU; very expensive)
- `ocr` = 2, `embed` = 2

AI model binaries are downloaded once into `$CORAL_STATE_DIR/models/` on
first startup (SHA-256 pinned in `config.json`) so the container image
stays small and the operator controls which models land on disk.

### 9.2 Job state lifecycle

```
queued ──► running ──► done
              │
              └──────► failed (retryable=true → re-queued after backoff)
```

`job.payload` is opaque JSON; schemas live per-kind in
`server/src/workers/<kind>.ts` alongside the worker implementation. The
`jobs` API (§ 7.6) surfaces `{ id, kind, state, progress, created_at,
started_at }`.

### 9.3 SSE events from workers

Published on `/api/events` (§ 7.5):

- `job_started { id, kind, payload_summary }`
- `job_progress { id, progress }` — throttled to ≤ 1 Hz per job
- `job_done { id, kind, result_summary }`
- `asset_upserted { asset_id, fields_changed }` — whenever `index` or a
  dependent worker mutates an asset doc. Grid and inspector use this to
  live-update without polling.

### 9.4 What runs where

All workers run server-side. The native app does _not_ run worker kinds
against a server-hosted library — it would double-count work and contend
for the DB. It may still do its own local face detection / thumbnail gen
for _filesystem-only_ libraries (the existing Vision + ThumbnailDiskCache
paths), which is independent.

## 10. UI (browser — `web/projects/browse`)

Contract: the browser UI is a subset of the native UI using the same layout
grammar from `photo-app-ui-spec.md`. Same tokens, same three-column shell,
same two modes.

### 10.1 Browse mode

```
┌───────────────┬──────────────────────────────┬──────────────────┐
│  Sources      │        Image grid            │  Detail (Info /  │
│  ───────────  │                              │   Color* / Meta  │
│  Libraries ⊕  │                              │   / Scopes*)     │
│   France      │                              │                  │
│   2025        │                              │                  │
│   Archive     │                              │                  │
│  ───────────  │                              │                  │
│  Tags         │                              │                  │
│  People       │                              │                  │
│  Places       │                              │                  │
│  Duplicates   │                              │                  │
│  Search 🔍    │                              │                  │
└───────────────┴──────────────────────────────┴──────────────────┘
```

**Left nav structure.** Two sections:

1. **Libraries.** Top-level row labeled `Libraries` with an `⊕` "add
   folder" button to the right of the label. Each source folder in the
   current library is a row beneath — click to expand and walk its
   subfolder tree. Source folders that are currently unreachable
   (`available: false` in the DB) render dimmed with an "offline" badge.
2. **Virtual views.** Tags, People, Places (map), Duplicates. Each
   disables itself with a tooltip ("Indexing N%") while the corresponding
   worker hasn't populated enough data yet — § 4.5.6.

**Add-folder flow.** Clicking `⊕` opens a modal:

1. The user types or pastes an absolute path (or uses the browser's
   `window.showDirectoryPicker()` on Chromium — informational only, still
   needs the server-mounted path).
2. UI calls `POST /api/libraries/:id/folders/preview` — shows path
   validity, asset-count estimate, and a "this drive has been indexed
   before — relink?" message if `existing_source_folder_id` came back.
3. On confirm: `POST /api/libraries/:id/folders` commits; the server
   enqueues a priority-1 `index` job and the modal closes. The new
   source folder appears in the left nav immediately with a spinner; as
   the `index` job progresses, SSE `job_progress` updates the count.

**Right-click on a source folder** opens a context menu: Rename, Reindex,
Open in native app (via a `maple-maple://` URL handler on Mac/iPad),
Remove (with a confirmation that offers "also delete `.maple/` cache" as
an unchecked option).

**Detail panel.** `Color` and `Scopes` are disabled in browse mode (spec
invariant — `photo-app-ui-spec.md` "Color and Scopes gray in browse
mode"). The Meta tab shows EXIF + sidecar extractables. A new "Places"
tab lives under Info when the selected asset has GPS. An "AI" sub-row
inside Info shows the `ai.caption` and `ai.auto_tags` (when present),
with an "edit caption" affordance that writes back into the XMP sidecar
(`dc:description` / `lr:hierarchicalSubject`).

### 10.2 Full-image mode

```
┌────┬──────────────────────────────────────┬──────────────────┐
│ FS │            Full image                │   Detail         │
│ 80 │                                      │   (Color active, │
│ px │                                      │    Scopes live)  │
└────┴──────────────────────────────────────┴──────────────────┘
```

This is the existing `edit-page` route, upgraded to match the native
full-image layout. All editing code path is client-side — the server does
not render. Edits emit PUT `/sidecar`.

### 10.3 Additional views (linked from left nav)

- **Map.** MapLibre-gl tile view + server-side clustering from
  `/api/libraries/:id/map`. Clicking a cluster opens a filtered grid.
- **People.** Grid of `person` cards with face crops; clicking opens all
  assets featuring that person. Unnamed people sort first so the user can
  label them.
- **Duplicates.** Calls `/duplicates`; groups displayed side-by-side with
  "keep"/"discard" affordances. Discarding moves to a trash subfolder in
  the library root (non-destructive until emptied).
- **Tags.** Pure virtual folder list; drag-drop assign.

### 10.4 Shared code

`web/projects/maple-common/` already holds the WebGL pipeline + shaders.
Extend it to hold:

- Shared API type definitions (`maple-common/src/lib/api/*.ts`) generated
  from a central `server/api-schema.ts` (plain TS interfaces are fine;
  formal OpenAPI is defer-until-needed).
- Shared UI tokens — dark-theme hex values, spacing, typography — so
  `browse`, `editor`, and any future web app don't drift.

## 11. Native integration — `ServerSource`

New module `Packages/MapleCore/Sources/MapleCore/Server/`, sibling to
`Filesystem/`, `PhotoKit/`, `SMB/`.

### 11.1 Shape

```swift
public struct ServerLibraryConfig: Codable, Sendable {
    public let id: UUID
    public let name: String
    public let baseURL: URL
    public let bearerToken: String     // stored in Keychain
    public let librarySlug: String
    public let supportsDirectFS: Bool  // true if this library also mounts as SMB/FS
    public let directFSRoot: URL?      // the SMB/FS root when supportsDirectFS
}

public actor ServerSource: PhotoSource {
    public init(config: ServerLibraryConfig) { ... }

    // Source protocol surface (mirrors FilesystemSource):
    public func listAssets(in folder: String?) async throws -> [AssetSummary]
    public func readSidecar(for id: AssetID) async throws -> (xml: String, version: Int)
    public func writeSidecar(for id: AssetID, xml: String, ifMatch: Int) async throws -> Int
    public func loadThumbnail(for id: AssetID) async throws -> CGImage?
    public func loadPreview(for id: AssetID) async throws -> CGImage?
    public func loadOriginal(for id: AssetID) async throws -> URL
}
```

### 11.2 Hybrid fast-path

When `supportsDirectFS && directFSRoot` is reachable (ping + quick stat),
`ServerSource` bypasses the HTTP cache endpoints and reads thumbnails/
previews straight from `directFSRoot/.maple/...`. The metadata API is still
used for list/search/tags/people (no duplicated index logic).

This is what "share image cache with the native apps" cashes out to: LAN
clients never pay the HTTP-body cost for cache reads, because the cache is
just files at a deterministic path they can already see.

Fallback order for thumbs/previews, deterministic:

1. In-memory NSCache.
2. `directFSRoot/.maple/thumbs/{filename}.jpg` if `supportsDirectFS`.
3. `GET /api/libraries/:id/assets/:asset_id/thumb` with ETag + 304 short-
   circuit.
4. Generate locally from the original via `raw-core` FFI.

### 11.3 Pairing flow

Mac app gets a new "Add server library" row in the sources sidebar. Pairing
is either (a) paste a URL + token, or (b) scan a QR code the server prints
at provisioning time. On success, the config goes to Keychain (same storage
pattern `SMBServerConfig` already uses).

## 12. Performance targets

- **Grid scroll** on a 50k-asset library: ≥ 60 fps sustained on M-series Mac,
  ≥ 120 rows/sec fetched from the assets endpoint. Paginated by 200.
- **First paint** after cold server start: ≤ 300 ms to first grid page on
  a pre-indexed library.
- **Cold reindex** of a 100k-asset library: ≤ 20 min for EXIF + thumb on
  an 8-core NAS (dominant cost: sharp thumb gen).
- **Sidecar PUT** round-trip on LAN: ≤ 50 ms p95.
- **SSE lag** from filesystem change to client notification: ≤ 250 ms p95.

Gates below the app level — not part of `verify-all` by default — live in
`server/scripts/bench.ts` and are runnable ad hoc.

## 13. Phased rollout

Named phases, not sprint targets. Each one delivers something usable end to
end; don't pull features forward without an explicit call.

### Phase S1 — Add folders, index, browse

- docker-compose stack: `maple-server` + `maple-mongo` + `maple-proxy`.
- MongoDB collections from § 6.2: `libraries`, `source_folders`,
  `assets`, `jobs`. Text index on `assets` is created up front so
  `$text` queries work the moment data lands.
- Library + source-folder management API (§ 7.1, 7.1.1).
- `index` worker (EXIF + XMP parse, priority queue, 100-doc bulk ops).
- `thumb-warm` + lazy thumb generation.
- Folder-tree navigation (§ 7.1.2) backed by `listDirectory` + DB enrichment.
- `GET /api/libraries/:id/assets` with folder, `$text`, rating, and date
  filters (text search over filename + tags until caption/ocr land).
- `browse` SPA three-column shell: left-nav **Libraries** section with
  `⊕ Add folder` modal (preview → commit flow from § 10.1), folder tree,
  grid, Info/Meta detail panel.
- SSE structured events (`job_progress`, `asset_upserted`).
- No map/people/duplicates/AI-tabs in the UI yet.

### Phase S2 — Shared cache + sidecar edit

- `PUT /sidecar` with `If-Match`.
- `sidecar_updated` SSE event with in-DB mirror of rating/flag/label.
- `ServerSource` in MapleCore, hybrid fast-path for cache reads on LAN.
- Mac pairing UI ("Add server library"; reuses the `SMBServerConfig` pattern).
- Color tab wired to the sidecar PUT on slider release (debounced).

### Phase S3 — DB-powered discovery

- `hash` worker + `dup_clusters` + `/duplicates` endpoint & UI.
- `geocode` worker + `/map` + MapLibre view.
- Tag endpoints + left-nav Tags section.
- Browse-mode Places tab.

### Phase S4 — AI: captions + OCR + semantic search

- `caption` worker (BLIP-2 or local VLM) → `assets.ai.caption` + `auto_tags`.
- `ocr` worker (Tesseract) → `assets.ai.ocr_text`.
- `embed` worker (SigLIP/CLIP) → `assets.ai.clip_embedding`.
- `GET /api/libraries/:id/assets/semantic` — linear-scan kNN.
- Inspector "AI" sub-row (caption + auto_tags) wired through to the
  sidecar on user edit.
- Search box upgrades from filename-only to full text-index once ≥ 95%
  coverage is reached (see § 4.5.6).

### Phase S5 — People

- `face-detect` + `face-embed` + `face-cluster` workers.
- `persons` API + UI.
- Name propagation through sidecar `papp:` namespace.

### Phase S6 — Off-LAN + scale

- TLS + reverse-proxy docs (Caddy sample config in `server/docker/`).
- Range-supported `/original` (verified under slow WANs).
- mDNS advertisement.
- Embedded server in the Mac app (same binary hosts Elysia on localhost).
- Evaluate sidecar vector index (§ 14.1) once library size forces it.

## 14. Open questions

Resolve before Phase S2:

- **Sidecar write path when the client has direct FS access.** If the Mac
  app mounts the library via SMB, does it still route sidecar writes through
  the server (consistent, slower) or write direct (fast, skips the
  version-check round-trip)? Recommendation: always through the server when
  a server is configured, so `sidecar_version` and SSE broadcast stay
  authoritative. Direct-FS is read-only fast-path.

Resolve before Phase S4 (AI):

- **Caption model.** Local BLIP-2 (ONNX, ~3 GB) vs Claude Vision API vs
  open LLaVA-Mini. Trade-off: local is offline + unlimited but slow on
  CPU; API is fast but costs per image and leaves home network.
  Recommendation: ship BLIP-2 as default + Claude Vision as opt-in via
  `library.settings.caption_provider`.
- **Semantic-search text encoder pairing.** The `embed` worker's image
  encoder must match the text-side encoder used at query time (or
  results will be garbage). Pin both sides to the same model tag in
  `assets.ai.clip_model`. On model upgrade, re-embed rather than mixing.

Resolve before Phase S5 (People):

- **Face model licensing.** ArcFace is MIT, SCRFD is Apache-2; both fine.
  But do we want on-device (native app uses Vision) face detection to
  agree with server embeddings? Vision's `VNFaceObservation` doesn't expose
  an embedding compatible with ArcFace, so people named on device would not
  round-trip the embedding. Recommendation: server is authoritative for
  face clustering; Vision is a hint only.

Resolve before Phase S6:

- **Hosted-SaaS deferrable?** If any of the early adopters push for a
  hosted option ("I don't want to run a server"), the cheapest path is to
  colocate Elysia + Mongo + library on a cheap VPS and resell — but that
  introduces auth, quotas, billing, data residency. Not before S6.
- **Library discovery on LAN.** mDNS (`_maple-maple._tcp.local`) is the
  obvious answer but requires native zero-conf in the Bun runtime. Defer
  decision until S6; ship paste-token in S2.

### 14.1 If you want more than v1

**Per-month bucket view for the scrubber.** `assets.sha256` is nullable so
the indexer can get data into the grid before hashing completes — that's
fine, but rendering a timeline scrubber on 500k assets by counting
`captured_at` per visible pixel is expensive. Materialize an
`asset_buckets` collection keyed by `{ library_id, year_month }` with a
count and a sample `asset_id`; rebuild incrementally from the `index`
worker's change stream.

**Vector search for semantic queries.** Self-hosted MongoDB doesn't have
the Atlas Vector Search index. Path forward:

1. v1 — linear scan of `assets.ai.clip_embedding` inside the worker
   process for the `/assets/semantic` endpoint. f16 × 768 dims × 100k
   assets ≈ 150 MB; SIMD cosine over that is sub-second. Fine up to the
   low-100k range.
2. When scan latency crosses ~500 ms, bring up a sidecar vector store —
   [Qdrant](https://qdrant.tech) or [LanceDB](https://lancedb.github.io)
   — as a fourth container in the compose stack. Mirror
   `{ asset_id → embedding }` from Mongo. The semantic endpoint queries
   the vector store first, then joins back to Mongo for the metadata.
3. Don't wait until v1 to stub the indirection — put the vector query
   behind a `SemanticSearch` interface in the server so the swap is
   local. The interface surface is `search(vec, k) → [(asset_id, score)]`.

**Backups and DR.** MongoDB has two sensible backup paths:

- **Volume snapshot.** Stop `maple-mongo`, snapshot the `maple-mongo-data`
  volume, restart. Simple; requires brief downtime.
- **`mongodump` on a cron.** Runs hot against the live container;
  restores via `mongorestore`. Recommended default. Ship as an optional
  sidecar in docker-compose, off by default.

Neither is the authoritative recovery path — § 4 says the filesystem is,
and a full reindex of 100k assets is minutes to tens of minutes (§ 4.5.7).
Backups buy you _time_, not correctness: they avoid an hour-long reindex
after a corrupted volume, nothing more.

**On-disk size governance.** At 500k assets × ~8–10 KB/doc the metadata
is ~5 GB; at 500k assets × 1.5 KB CLIP embedding it's another ~750 MB.
Both well inside single-node comfort. If a household hits the single-node
ceiling, the answer is not to shard — it's to split libraries.

## 15. Relationship to existing docs

- `photo-app-feature-spec.md` — product contract. Phase 5 ("iCloud sidecar
  sync, plugin API") overlaps the server but stays focused on the native
  app's view. This document is the server-side expansion.
- `photo-app-ui-spec.md` — source of truth for layout and tokens. `browse`
  implements the subset that makes sense for a browser client.
- `docs/architecture.md` / `docs/caching.md` / `docs/raw-pipeline-architecture.md`
  — unchanged; the server does not touch the pipeline.
- `docs/xmp-canonical-format.md` — canonical for sidecar on-wire format.
  The `PUT /sidecar` body conforms; the server does _not_ re-serialize or
  re-normalize XMP it receives.
