# PhotoKit backup, merged timeline, and lazy edit-sync — PRD + design

**Status:** brainstorming complete, awaiting plan
**Scope:** `src/apple`, `src/api`, `docs`
**No-touch:** `src/raw-pipeline` (no color-pipeline changes), `docs/sidecar-schema.md` (compatible additions only — see § 8)

---

## Part I — Product requirements

### 1. TL;DR

Maple users with photos in Apple's Photo Library currently have to choose: stay inside Apple Photos (closed catalog, no XMP, no Maple edits) or manually export RAWs to a folder Maple can see. Neither is acceptable for a working photographer. PhotoKit Backup turns the Apple Photo Library into a first-class Maple source — extracting originals, Apple-rendered edits, and metadata into a Maple Cloud library on a continuous schedule, and surfacing a merged Photos + Cloud timeline that lets the user open and edit a photo before it has finished syncing.

The feature has two goals fused into one mechanism:

1. **Liberation** — every PhotoKit asset eventually exists as a real file in a Maple-controlled library, organised in a human-browseable tree (`<root>/<year>/<location-or-MM>/<DD>/<file>`), with full sidecar metadata.
2. **Working-set sync** — the user can edit a PhotoKit photo *before* it has finished uploading; Maple records the edit locally and reconciles when the bytes land.

### 2. Problem

PhotoKit assets are second-class in Maple today. `PhotoKitSource.writeXMP` throws — the user can browse and open Photos library RAWs, but every edit they try to make in Maple gets rejected. Their only path is to export to a folder first, which is tedious, breaks the link to the rest of their library, and produces orphaned copies the next time Apple rotates iCloud caches. Photographers with mixed workflows (iPhone shooting → Mac editing) currently cannot use Maple as their primary editor without first migrating off Photos.

### 3. Target users

- **iPhone shooter, Mac editor.** Captures on iPhone, syncs to iCloud Photos, expects to edit on Mac. Currently has to import-from-iPhone manually or use Apple Photos for everything.
- **Photographer mid-migration.** Has years of history in Apple Photos, wants to move to Maple's filesystem-and-XMP model without losing favourites, captions, and album structure.
- **Mixed-source professional.** Shoots on a real camera (already in Maple's filesystem source), but also captures on iPhone, and needs both libraries visible in one timeline.

### 4. Goals

1. **Zero-touch liberation.** After one-time configuration, every photo the user has in Apple Photos — and every new one they capture — ends up in a Maple Cloud library, automatically. No manual export, no dialogs per asset.
2. **Editable before fully synced.** A photo visible in the merged timeline can be opened and edited in Maple even if its bytes haven't reached the server yet. Edits persist locally and reconcile on upload.
3. **Cross-device incremental from day one.** Both the Mac app and an iPhone/iPad app can run the engine. Two devices touching the same library do not duplicate work or files; the same PhotoKit asset uploaded from two devices collapses to one server-side row.
4. **Fast merged timeline.** A user opening Maple sees their entire photo history — local PhotoKit + already-synced cloud — within one frame of launch. PhotoKit aggregates are computed on-device from the SQLite-backed `PHFetchResult`, never blocking on the network.
5. **No silent loss.** A photo that was in Apple Photos at any point is preserved in the Maple library even if the user later deletes it from Apple Photos. The cloud copy is the system of record.

### 5. Non-goals

- Editing video or Live Photo motion (we *store* both halves; editing remains stills-only per the project PRD).
- **Writing edits back into the Apple Photos library.** All Maple edits live in sidecars and never modify the original asset, in Photos or anywhere else. This extends Maple's "originals are sacred" rule to the Apple Photos source.
- **Migrating a backup library to a different root or server.** A migration tool is code that deletes user photos under load; the risk of a bug is unacceptable. Users move libraries with `rsync` or Finder, outside Maple.
- Backing up to non-Maple destinations (filesystem-only, third-party clouds).
- Cross-server replication (one library = one server in v1).
- End-to-end encryption beyond TLS — TLS suffices for v1, and adding key management on top buys little for a self-hosted server the user already trusts with the bytes.

### 6. Success criteria

- A 50,000-asset Apple Photo Library, mixed RAW/HEIC/JPEG/Live Photo/video, completes initial backup unattended on a Mac plugged in overnight.
- After that backup, the user can edit any photo in the merged timeline without observing whether it's "local" or "cloud" — both paths render in ≤ 35 ms cold open.
- Two devices (Mac + iPhone) configured against the same library produce zero duplicate files server-side, verified by `maple_id` uniqueness.
- A photo edited on iPhone while on cellular shows the edit immediately, finishes uploading on next WiFi association, and the edit survives.
- A photo deleted in Apple Photos remains in the Maple library and remains editable.

---

## Part II — Functional requirements

### 7. Configuration flow

Settings → "Photo Library backup" panel:

1. **Server** — picker over the user's configured Maple Cloud servers (existing setting).
2. **Library** — picker over libraries on the chosen server.
3. **Root folder** — picker for the directory inside the library where the backup tree lands. Default: `Photos/`.
4. **Layout** — toggle: location-aware (default) vs month-only. Per-asset, location-aware falls back to month-only when GPS is absent.
5. **Inclusion toggles**:
   - Live Photos (default on; stores both halves)
   - Videos (default on; stored, not editable)
   - Bursts (default: picked frame only; toggle for "all frames")
   - iCloud Shared Library (default on)
   - Shared Albums (default off)
6. **WiFi-only byte uploads** (default on; metadata uploads always allowed)
7. **Status panel** — queue size, in-flight count, current rate, last error, ETA, pause control.

### 8. Per-asset backup payload

Per PHAsset, the backup writes:

- **Original bytes** — `PHImageRequestOptions.version = .unadjusted`, `isNetworkAccessAllowed = true`. RAW for cameras that capture RAW; HEIC/JPEG/PNG otherwise.
- **Apple-rendered version** — when the user edited the asset inside Apple Photos, the rendered output is also fetched (`.current` version) and stored alongside as `<base>.rendered.<ext>`. The original is the canonical asset; the rendered copy is auxiliary.
- **Sidecar XMP** — a `.xmp` file next to the asset, carrying:
  - Existing Maple sidecar payload (`AdjustmentModel`, `CullingState`) — empty for fresh imports
  - PhotoKit fields: `phassetLocalId`, `deviceId` (UUID stable per device), `captureDate`, GPS, `favorite` flag, `caption`, `keywords[]`, `tags[]`, `originalFilename`, `mtime`
  - Live Photo linkage: `maple:livePhotoCompanion = "<base>.mov"` on both halves
  - Burst linkage: `maple:burstStackId` on every frame in a burst (each frame is its own PHAsset with its own localIdentifier and filename — no synthetic naming required)

`tags[]` replaces what Apple calls album membership. Apple's nested folder structure ("My Albums > Trips > Tokyo") flattens to `tags: ["Trips", "Tokyo"]` — every ancestor folder name plus the leaf album name becomes a tag. The mapping isn't strictly one-to-one (two leaf albums named "Tokyo" under different parents collapse), but it's close enough and gives Maple a flat, queryable model that matches how photographers actually search. Tags are also the natural foundation for user-added organisation later.

This is an **additive** schema change — `docs/sidecar-schema.md` gets new optional fields; existing readers ignore unknown XMP and pass it through unchanged.

### 9. Folder layout

```
<root>/
  2024/
    Tokyo/
      03/                       ← day-of-month
        IMG_0420.HEIC
        IMG_0420.HEIC.xmp
        IMG_0420.mov            ← Live Photo companion (shares base name)
        IMG_0421.mov            ← standalone video (separate asset)
    Tokyo/
      04/
        ...
    07/                         ← no-GPS month fallback for July 2024
      19/
        IMG_0512.HEIC
```

- Top: capture year (from sidecar metadata; falls back to file mtime)
- Middle: reverse-geocoded place name when GPS is present, two-digit month otherwise
- Leaf: two-digit day-of-month

The path tree is for human browsing; the canonical date and location live in the sidecar and EXIF.

Reverse-geocoded place names come from the existing `src/api/src/enrichment/nominatim-client.ts` via a small new server endpoint (`GET /api/geocode/reverse?lat&lon`) that the device calls before deciding the upload path.

### 10. Continuous sync semantics

- **First run** — full enumerate of `PHAsset.fetchAssets(with: .image, …)` and `.video`, compare against server ingest log, enqueue everything missing.
- **Live updates** — `PhotoKitChangeObserver` (already exists) fires on Apple library mutations; the engine diffs the changed assets and enqueues new/modified ones.
- **Periodic safety walk** — weekly on Mac, `BGProcessingTask` on iOS, in case a change-observer notification was missed.
- **Apple-side delete** — keep the cloud copy. The asset row in Mongo gains a `deletedFromPhotos: true` flag for UI surfacing.
- **Apple-side rendered re-edit** — re-pull the rendered version only. Originals are content-addressed (BLAKE3) and never change; if a hash changes, the asset is treated as new.
- **iCloud Shared Library** — included; the asset is owned-by-user in the cloud copy regardless of who shared it (consistent with Apple's model where you can edit Shared Library photos).
- **Shared Albums** — skipped by default. They aren't really yours.

### 11. Edit-while-not-backed-up

Today, `PhotoKitSource.writeXMP` throws. After this work, it writes a regular `.xmp` file in App Support — same XMP format and same atomic write pattern as `XMPSidecarStore`, just keyed by `phassetLocalId` instead of by raw URL:

- Path: `~/Library/Application Support/Maple/PhotoKitSidecars/<phassetLocalId>.xmp`
- Same temp-then-`replaceItemAt` atomic write `XMPSidecarStore` already uses — no parallel storage layer, no schema, no SQLite
- Read path: `PhotoKitSource.readXMP` (new) returns the App-Support `.xmp` when present, falling back to PhotoKit-only metadata otherwise
- An `XMPSidecarStore`-shaped wrapper points `EditSession` at this path, so the rest of the edit pipeline doesn't know or care that the source is PhotoKit

When the engine uploads the asset bytes, the App-Support `.xmp` is copied to the cloud-side path and the local file is deleted. If the user is on WiFi when they make the edit, the engine performs a **priority-jump** backup of just that asset — the user's working photo gets queue-bypassed.

If the user is on cellular and "WiFi-only" is enabled, the bytes wait. The edit is durable on-device. On next WiFi association, the queue resumes.

### 12. Merged timeline

The Browse view's timeline scroller becomes the union of two streams:

- **PhotoKit local** — `PHFetchResult.enumerateObjects` is SQLite-backed and lazy. Year/month/day buckets are computed on-device by walking the result with a date sort descriptor — no per-asset I/O. Latency: < 50 ms for a 100 k-asset library.
- **Cloud** — the existing timeline view's feed (see `docs/superpowers/specs/2026-05-06-timeline-view-design.md`), already optimised for fast scroll.

Merge rule, per asset:

- If the cloud row carries a `phasset_link` matching a local PHAsset → render from local (instant), badge as "synced".
- If the cloud row has no matching `phasset_link` (e.g. asset deleted from Apple Photos but kept in cloud) → render from cloud, badge as "cloud-only".
- If the local PHAsset has no matching cloud row → render from local, badge as "local-only".

Open path: prefer the local PhotoKit thumbnail (~5–50 ms via `PHImageManager`) when both are available. Fall back to the cloud thumbnail when the asset is `cloud-only`.

### 13. Networking & power

- Bytes upload: WiFi-only by default. The priority-jump in § 11 also respects this — on cellular, an edited asset's bytes wait but the App-Support `.xmp` keeps the edit durable.
- Sidecar uploads (small) follow the same WiFi-only default; they're not a special-cased exception.
- iOS low-power mode pauses uploads.
- macOS Energy Saver: pauses when on battery if the user picks "Energy saver" power profile.
- Resume: chunked upload with HTTP `Content-Range`. Server tracks per-`maple_id` upload offset; resume on app or agent restart picks up where it left off.
- Concurrency: 4 streams default, tuned per-platform.

### 14. Failure modes

| Failure | Behaviour |
| --- | --- |
| Server unreachable | Exponential backoff (1s → 1h cap), surfaced in status panel |
| PhotoKit auth revoked | Engine halts, settings panel shows "grant access" CTA |
| Server disk full (HTTP 507) | Engine pauses, error surfaced; resumes when server reports space |
| Mid-upload byte corruption | Chunk-level checksum mismatch → resume from last good chunk |
| PHAsset disappears mid-upload | Cancel transfer, mark as `observed`, retry on next walk |
| Conflicting concurrent edit (Apple Photos + Maple) | Maple's edit wins on the cloud copy; the cloud `.xmp` overwrites the conflicting Apple render on next reconcile (Apple's render is auxiliary; the Maple edit is canonical) |

---

## Part III — Architecture

### 15. System shape

```
┌────────────────────────────┐    ┌──────────────────────────┐
│ MapleApp                   │    │ MapleBackupAgent (macOS) │
│ - SwiftUI shell            │    │ - LaunchAgent            │
│ - hosts BackupEngine       │    │ - hosts BackupEngine     │
│ - shows merged timeline    │    │ - keeps backing up       │
└────────────┬───────────────┘    └────────────┬─────────────┘
             │                                 │
             └──────── shared SPM ─────────────┘
                              │
                              ▼
                 ┌────────────────────────────┐
                 │ MapleBackup (SPM module)   │
                 │ - BackupEngine actor       │
                 │ - BackupQueue protocol     │
                 │ - AppSupportSidecarStore   │
                 │ - PayloadAssembler         │
                 │ - UploadClient             │
                 └────────────┬───────────────┘
                              │ HTTPS
                              ▼
                 ┌────────────────────────────┐
                 │ src/api (Maple Cloud)      │
                 │ - new ingest route         │
                 │ - new geocode/reverse rt   │
                 │ - assets.phasset_links[]   │
                 │ - existing indexer         │
                 └────────────────────────────┘
```

The engine code lives in a single SPM module; both the foreground app target and the macOS LaunchAgent depend on it. The agent is a tiny `main.swift` that constructs the engine and lets it run.

iOS does not get a helper agent (no LaunchAgent equivalent exists). It uses `BGProcessingTask` for background continuation and accepts that progress is bounded by foreground sessions.

### 16. Identity model

Each PhotoKit asset is identified by:

- **`phassetLocalId`** — opaque per-device `PHAsset.localIdentifier`
- **`deviceId`** — UUID stable per device-and-app-install, generated on first launch and persisted in `Application Support`
- **`maple_id`** — BLAKE3 hex of the canonical original bytes (existing primitive in `raw-pipeline`)

Server `assets` collection keys on `maple_id` (existing). Backed-up rows gain:

```ts
phasset_links: [
  { device_id: "uuid", phasset_local_id: "B5C9...", first_seen: Date }
]
```

The same photo backed up from iPhone and Mac collapses to one row because both devices compute the same `maple_id` from the same bytes; the array carries both links.

`maple_id` is computed **lazily** — at upload time on the device, not on enumerate. A 100 k-asset eager hash would block the engine for hours of pure I/O. Pre-upload identity uses `(deviceId, phassetLocalId)` for queueing; once the bytes are read for upload, the BLAKE3 hash falls out of the same read.

### 17. Engine state machine

Per asset, per device:

```
unseen → observed → pending → uploading → uploaded
                       │
                       ├──► failed-retry (exp. backoff)
                       └──► skipped-policy

(any state) → local-edit-pending  (App-Support sidecar exists,
                                   bytes not uploaded yet; transitions
                                   back to pending on next walk)
```

State is persisted in `~/Library/Application Support/Maple/backup-state.sqlite`. This is internal queue state — counts, retry depth, in-flight chunk offsets — not user data; SQLite is appropriate for the concurrent-update + restart-recovery shape. User-visible sidecars stay as `.xmp` files (§ 11).

### 18. Worker abstraction

A new `BackupQueue` protocol decouples the engine from the project's worker infrastructure (which is being revamped):

```swift
public protocol BackupQueue: Actor {
    func enqueue(_ task: BackupTask, priority: BackupPriority) async
    func cancel(_ id: BackupTaskID) async
    func observe() -> AsyncStream<BackupQueueEvent>
    func snapshot() async -> [BackupTask]   // for UI / persistence reload
}
```

V1 implementation is in-process — a small actor over an `AsyncChannel` with SQLite-backed durability. The current `src/api` job-runner is **not** used; it's a server-side concept and the engine runs on the device. When the worker revamp lands, if it produces a Swift-callable queue the implementation can swap in; if not, the in-process implementation continues to work unchanged.

Server-side ingest does have a job-shaped tail (geocode, thumbnail, indexer pickup), but that runs on top of whatever the server's worker system is — the device-side engine just hits the ingest endpoint and considers the upload complete on `200 OK`.

### 19. Data model — server side

Additions to existing collections:

`assets`:
- `phasset_links: { device_id, phasset_local_id, first_seen }[]` — new array
- `deleted_from_photos: boolean` — set when reconciliation observes the asset has been removed from Apple Photos on every linked device
- `apple_rendered_path: string?` — relative path to the Apple-rendered companion when present

New collection `backup_sessions`:
- `device_id`, `library_id`, `started_at`, `last_progress_at`, `total_count`, `uploaded_count`, `failed_count`
- Lets the device show "you backed up X% from this device" without polling the assets collection

Indexes: `assets.phasset_links.phasset_local_id` (sparse), `backup_sessions.device_id+library_id`.

### 20. New server endpoints

- `POST /api/libraries/:id/backup/ingest` — chunked upload; body is multipart with original + optional rendered + sidecar XML; metadata in headers (`X-Maple-Phasset-Id`, `X-Maple-Device-Id`, `X-Maple-Capture-Date`, `X-Maple-Lat`, `X-Maple-Lon`). Returns `{ maple_id, path }`.
- `GET /api/libraries/:id/backup/state?device_id=…&since=…` — reconciliation feed; returns the list of assets the server has seen from this device since `since`. Used on launch + periodic safety walks.
- `GET /api/geocode/reverse?lat&lon` — wraps `nominatim-client`, returns `{ place: string?, country: string?, locality: string? }`. Cached server-side using the existing coordinate cache.

All authenticated via the existing passkey-based session (see `2026-04-26-passkey-auth-design.md`).

### 21. Settings UI components

- New `BackupSettingsView` (SwiftUI) at `src/apple/Maple/Views/Settings/BackupSettingsView.swift`
- Reuses existing server picker from current settings infra
- Status panel uses `BackupQueue.observe()` to render live progress
- Pause/resume calls into the engine actor directly

### 22. Telemetry

Local-only counters for now:

- Per-state asset counts
- Throughput (assets/min, MB/min)
- Error breakdown by type
- Retry depth distribution

No content, no PII, no remote reporting. Surface in the status panel for the user to read.

---

## Part IV — Cross-cutting

### 23. Dependencies on in-flight work

- **Worker-system revamp** — the device-side engine is decoupled via the `BackupQueue` protocol. Server-side ingest jobs (geocode trigger, indexer pickup) ride on top of whatever the new system provides; device doesn't care.
- **Existing timeline view** (2026-05-06 spec) — gains a "merged source" mode that consumes both PhotoKit-local and cloud aggregates.
- **Indexer enrichment phases 1–3 / 7** — already produce the `place` field the merged timeline path-formatter consumes via the new geocode endpoint.
- **Passkey auth** (2026-04-26 spec) — already provides the device authentication the ingest endpoint requires.

### 24. Open questions

- **Apple Photos people / face data** — PhotoKit exposes face rectangles (`PHContentEditingInput`); not in scope for v1, but reserving the sidecar/schema slot now would let a later face-data import land additively.

### 25. Future work (explicitly deferred)

- Live Photo / video editing (v2).
- Hosted "Maple Cloud" offering as an alternative to Self-Hosted.
- Cross-server replication.

---

## Part V — Implementation outline

This section is intentionally light — full plan lands in `docs/superpowers/plans/`. The natural slicing:

1. **Server foundations** — `assets.phasset_links` schema, ingest endpoint, geocode/reverse endpoint, ingest-tests.
2. **Shared engine** — `MapleBackup` SPM module, `BackupQueue` in-process implementation, `PayloadAssembler`, `UploadClient`, App-Support sidecar store for not-yet-uploaded edits, state-machine persistence.
3. **macOS LaunchAgent** — `MapleBackupAgent` target + plist + install/uninstall flow + IPC with the main app for status display.
4. **iOS hosting** — engine in-app + `BGProcessingTask` registration + low-power gating.
5. **Settings UI** — `BackupSettingsView` + status panel + pause/resume controls.
6. **PhotoKitSource changes** — `writeXMP` writes to App-Support `<phassetLocalId>.xmp` instead of throwing; `readXMP` consults App-Support first.
7. **Merged timeline** — Browse-view timeline source becomes a union; per-cell badges; open-path preference.
8. **Continuous sync** — `PhotoKitChangeObserver` wiring; periodic safety walks; reconciliation against `/backup/state`.
9. **Failure-mode hardening** — retry policy, network gating, resume-from-chunk, telemetry.
