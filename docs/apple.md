# Apple platform

Everything Apple lives under `src/apple/`: one Xcode project (`Maple.xcodeproj`) that ships a single universal app — product name **Maple Exposure**, bundle id `app.justmaple.aperture`, running on macOS, iPhone and iPad from one target — plus a separate tvOS app, four extensions, a macOS LaunchAgent, and two test bundles. Almost none of the interesting code is in the Xcode targets: the domain lives in three local Swift packages under `src/apple/Packages/` (`MapleCore`, `MapleUI`, `MapleBackup`), and all the image math lives in Rust, linked as a static library through `Frameworks/RawPipeline.xcframework`. Those `.a` slices are gitignored (200–500 MB each), so a fresh clone must build them once with `scripts/build-xcframework.sh` before Xcode can link anything. The editor renders through the Rust FFI — either the wgpu GPU path presenting straight into a `CAMetalLayer`, or a CoreImage CPU fallback — never through hand-written Apple render kernels, which were all deleted once the Rust chain subsumed them.

## The Xcode project

Nine native targets, two committed schemes.

| Target               | Product           | Bundle id                   | Platforms          | Deployment            |
| -------------------- | ----------------- | --------------------------- | ------------------ | --------------------- |
| Maple Exposure       | app               | `app.justmaple.aperture`    | macOS, iOS, iPadOS | macOS 14.0 / iOS 26.0 |
| Maple TV             | app               | `app.justmaple.aperture.tv` | tvOS               | tvOS 17.0             |
| MapleFileProvider    | app extension     | `…aperture.FileProvider`    | macOS              | macOS 14.0            |
| MapleFileProviderIOS | app extension     | `…aperture.FileProviderIOS` | iOS                | iOS 26.0              |
| MapleQuickLook       | app extension     | `…aperture.QuickLook`       | macOS              | macOS 14.0            |
| MapleWidget          | app extension     | `…aperture.Widget`          | macOS, iOS         | macOS 14.0 / iOS 26.0 |
| MapleBackupAgent     | command-line tool | —                           | macOS              | macOS 14.0            |
| MapleTests           | unit-test bundle  | `…aperture.Tests`           | macOS, iOS         | —                     |
| MapleUITests         | UI-test bundle    | `…aperture.UITests`         | macOS, iOS         | —                     |

Which package products each target links (from `Maple.xcodeproj/project.pbxproj`):

| Target                                                    | Links                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| Maple Exposure                                            | MapleCore, MapleUI, MapleBackup                                |
| Maple TV                                                  | MapleCloudKit only — deliberately no RawPipeline, no MapleCore |
| MapleWidget                                               | MapleCloudKit                                                  |
| MapleFileProvider / MapleFileProviderIOS / MapleQuickLook | MapleCore                                                      |
| MapleBackupAgent                                          | MapleCore, MapleBackup                                         |

Only two schemes are committed under `Maple.xcodeproj/xcshareddata/xcschemes/`: **Maple Exposure** (which also owns the MapleTests + MapleUITests test action, neither skipped) and **MapleBackupAgent**. The Maple Exposure scheme's test action pre-sets `MAPLE_UITEST_FIXTURE_ROOT` to the repo's `test-fixtures/raws` and `MAPLE_UITEST_GOLDENS_ROOT` to `MapleUITests/Goldens`, so a test run from Xcode finds fixtures without extra arguments.

### Info.plist

The app target sets `GENERATE_INFOPLIST_FILE = YES` **and** `INFOPLIST_FILE = Maple-Info.plist` — Xcode merges the two. The synthesized half comes from `INFOPLIST_KEY_*` build settings: display name "Maple Exposure", photography app category, camera / photo-library / local-network usage strings, `NSBonjourServices = _smb._tcp`, the three bundled font files (`Lato-Regular`, `Lato-Bold`, `Merriweather-Bold`, registered at runtime from `MapleApp.init`), and the supported orientations. `Maple-Info.plist` carries only the keys Xcode's synthesizer refuses to allowlist: the `maple://` URL scheme (`CFBundleURLTypes`), `NSAppTransportSecurity` → `NSAllowsLocalNetworking` (self-hosted servers on the LAN speak plain HTTP), the `CFBundleDocumentTypes` claims that put Maple in Finder's "Open With" (`public.camera-raw-image` plus JPEG/PNG/HEIC/HEIF/TIFF, both role `Viewer` / rank `Alternate`), and `LSSupportsOpeningDocumentsInPlace`. The four extension targets each own a hand-written `Info.plist` with `GENERATE_INFOPLIST_FILE = NO`.

The app's entitlements (`Maple/Maple.entitlements`) request the sandbox, the App Group `group.app.justmaple.aperture`, app-scope bookmarks, user-selected read/write, network client, the `…aperture.shared` keychain group, extended virtual addressing and increased memory limit (100 MP RAWs), and `com.apple.security.cs.disable-library-validation` — needed because panorama stitching `dlopen`s a Microsoft-signed ONNX Runtime dylib.

## Local packages

### MapleCore

`src/apple/Packages/MapleCore` — swift-tools-version 6.1, language mode pinned to Swift 5. Two library products:

- **MapleCore** — the domain core. Depends on the `RawPipeline` binary target, AMSMB2 (SMB 2/3 client), MapleBackup, and swift-otel (OTLP/HTTP trait only, which keeps the deployment floor at macOS 14 / iOS 17).
- **MapleCloudKit** — deliberately dependency-free networking/auth/admin layer so the tvOS app can link it without pulling in RawPipeline.

MapleCore's top-level directories map to subsystems: `Editor` (adjustment state, presets, crop geometry, tone curves, canvas zoom), `Cache` (thumbnail memory/disk, rendered-preview, decoded-RAW, tile manager, per-folder index), `Cloud` (self-hosted/hosted source, timeline view models, cloud sidecar store), `Sources` (the filesystem / SMB / PhotoKit adapters and bookmark store), `Browse` (merged-timeline math), `FileOperations` (local + SMB rename/move/trash, collision resolution, filename templates), `FileProvider` (the whole replicated-extension implementation), `Panorama` (stitcher protocol, Rust FFI stitcher, ML-runtime provisioning), `Auth`, `Observability` (OTel wiring), `Layout`, `Grid`, and `Generated` (codegen output — see below). Loose files at the package root hold the render path, the XMP serializer, and the FFI wrapper.

MapleCloudKit splits into `Auth` (token store, keychain persistence, `AuthenticatedHTTPClient`), `Cloud` (asset/folder/search/thumb/map clients and caches), `Admin` (the server-settings clients backing the in-app admin screens: workers, enrichment, imports, network, Cloudflare), and `Pairing` (the Apple TV pairing handshake and crypto).

`Generated/` holds codegen output committed to the repo — `AdjustmentModel+Generated.swift`, `FilmCatalog+Generated.swift`, `UITokens.swift` — produced from `raw-core` by `tools/codegen.sh` and gated in CI against drift. See [pipeline](pipeline.md).

### MapleUI

`src/apple/Packages/MapleUI` — the design system, swift-tools-version 5.10, **zero dependencies** (no MapleCore, no third-party SPM) so sibling apps can consume it standalone. Components are prefixed `Mui` and organised by tier: `Atoms` (`MuiButton`, `MuiText`, `MuiIcon`, `MuiToggle`, `MuiCanvasSurface`…), `Molecules` (`MuiSlider`, `MuiLivingSlider`, `MuiHistogram`, `MuiCurvePlot`, `MuiColorWheel`, `MuiRatingFlags`…), `MoleculesL2` (`MuiCard`, `MuiDialog`, `MuiSettingsRow`, `MuiMediaCell`, `MuiFilmstripRow`…), `Organisms` (`MuiAdjustmentsPanel`, `MuiToneCurvePanel`, `MuiHslPanel`, `MuiSidebar`, `MuiFilmstrip`…), `OrganismsB` (modals and heavy surfaces — `MuiImageCanvas`, `MuiCropOverlay`, `MuiExportModal`, `MuiMapSurface`…), `Templates` (`MuiAppShell`, `MuiSplitLayout`, `MuiSettingsShell`…), and `Pages` (full-screen compositions such as `MuiPageEditor`, `MuiPageBrowse`, `MuiPageSettings`). `Internal/` holds the pure-math helpers each interactive component is tested against; `Gallery/` is a live specimen browser; `Generated/UITokens.swift` is the codegen'd token set shared with Web and Windows.

Adoption in the app is partial and observable: roughly 22 of the app's ~137 view files import MapleUI today, concentrated in the settings, server-admin and info-panel screens (`Maple/Views/ServerAdmin/*`, `Maple/Views/InfoPanel/*`, `BackupSettingsView`, `PhoneSettingsView`). The editor and browse surfaces are still hand-built SwiftUI in `Maple/Views/`. Component contracts live in `docs/design/maple-ui/components/*.md`; the cross-platform catalog is [unified-component-catalog](unified-component-catalog.md).

### MapleBackup

`src/apple/Packages/MapleBackup` — the device-side PhotoKit backup engine, its only dependency GRDB. `BackupEngine` runs `queue.dequeue → state.transition(.uploading) → reader.read → upload → sidecars.delete → state.transition(.uploaded)`. `BackupStateStore` persists the queue's state machine to SQLite (one `tasks` table keyed by device id + PHAsset local id) because that shape needs concurrent updates and restart recovery; user-visible sidecars stay `.xmp` files in `AppSupportSidecarStore`, a file-per-PHAsset store. Failures return the task to `.pending` and retry with exponential backoff (1s, 2s, 4s… capped at an hour), giving up as `.failedRetry` after 8 attempts. When Wi-Fi-only is set and the device is on cellular, background-priority tasks are re-enqueued after a 30-second sleep rather than uploaded. Only the primary bytes upload decides success: the sidecar, Apple-rendered twin and Live Photo `.mov` are best-effort companions uploaded after the photo commits, each with its own bounded retry, and a companion failure never burns the photo's retry budget.

`PhotoKitAssetReader` (in the app target) supplies the actual PhotoKit bytes; the engine takes it as an injected `AssetReader` so `swift test` can substitute synthetic data.

## Building the Rust core

`src/apple/scripts/build-xcframework.sh` cross-compiles `raw-ffi` for four Rust triples — `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-apple-darwin`, `x86_64-apple-darwin` — `lipo`s the two macOS slices into one universal archive, runs `cbindgen` to emit `RawPipeline.h`, writes a `module.modulemap` that declares `module RawPipeline`, and calls `xcodebuild -create-xcframework` to produce three slices: `ios-arm64`, `ios-arm64-simulator`, `macos-arm64_x86_64`. Header and modulemap are copied into `Packages/MapleCore/Sources/MapleCore/include/` as well, which is what makes `import RawPipeline` resolve for SwiftPM.

```bash
./src/apple/scripts/build-xcframework.sh            # release (default)
./src/apple/scripts/build-xcframework.sh --debug    # fast recompile only
./src/apple/scripts/build-xcframework.sh --force    # bypass the fast-path skip
```

Release is the default and the right choice: the script's own header records a 21-frame panorama stitch taking 353 s release versus 5785 s debug on an M4. Every slice is built `--features gpu` (wgpu/naga/metal linked everywhere, including iOS device) and iOS slices additionally get `--features pano-ios`, which links a static ONNX Runtime 1.22.0 provisioned by `scripts/fetch-ort-ios.sh` from the zip vendored at `src/apple/vendor/ort-ios/`. The crate build runs `--offline` against `src/raw-pipeline/vendor/`, so no network round-trip and no DNS flake.

Two guards make staleness loud rather than silent:

- **Content-hash fast path.** The script hashes every `.rs`, `.wgsl` and `.bin` under `raw-core/src`, `raw-ffi/src`, `raw-gpu/src` and `maple-pano/src`, plus `Cargo.lock`, the relevant `Cargo.toml`s and `cbindgen.toml`, and skips the build only when that hash matches the stamp at `Frameworks/.xcframework-stamp.<profile>` and every expected slice exists. Hashing content rather than mtimes is deliberate — a `git checkout` rewrites mtimes without changing content, which previously produced false skips that shipped slices missing new FFI symbols.
- **Symbol-consistency guard.** After creating the xcframework it diffs every `maple_*` symbol declared in the generated header against `nm -gU` output for each slice, and refuses to write the stamp if any slice is missing one. If ΔE numbers don't move after a `raw-core` edit, the xcframework is stale — rerun with `--force`.

Xcode Cloud runs `src/apple/ci_scripts/ci_post_clone.sh`, which installs rustup via Homebrew (the `sh.rustup.rs` bootstrap does not resolve on those workers), adds the four Apple targets, installs `cbindgen` pinned to **0.29.2**, and invokes the same script in release. `.github/workflows/apple.yml` pins the identical cbindgen version so the two CIs cannot generate different headers.

## The render path

An open image is an `EditSession` (`@MainActor`, `@Observable`) holding the `AdjustmentModel`, undo/redo ring, culling state and canvas math. Its behaviour is split across ~20 `EditSession+*.swift` extensions; the scheduler itself lives on `RenderActor`, which owns the decoded-image cache, the FFI decode coalescers, the fast/refine task handles, the debounce timers and a generation counter. A slider write on `session.model` schedules a render; the actor cancels the in-flight pass before spawning the new one. The **fast phase** runs immediately with no debounce (cancel-previous absorbs a drag); the **refine phase** debounces 150 ms, so a continuous drag only ever renders the tail.

`ImageEditPipeline` (an actor) has two entry points. `decodeSceneLinear…` runs the Rust scene-linear FFI once per asset open and returns a Rec.2020 buffer with the sidecar already applied; `processSceneLinear` then applies the per-tick chain on top of that cached decode — white balance delta → scene tone controls → tone curves → vibrance → saturation → HSL → clarity → texture → dehaze → local adjustments → vignette → sharpen → luminance NR → color NR → AgX → split tone → grain — in a single FFI call, with display encode fused into the same round trip when the chain cache misses. `PipelineRenderer` is the thin Swift wrapper over the C API (`maple_render_file`, `maple_render_bytes`, `maple_free_buffer`, `maple_last_error`); it copies pixels out of the C buffer into value types so no unsafe lifetimes leak.

**There are no hand-written Apple render kernels.** `MetalKernels.swift` survives only as an accessor for the bundled `Metal/agx_lut.bin`, used as a parity oracle asserting the Apple-bundled AgX LUT byte-matches the Rust one. Render math exists in exactly two places: Rust CPU (`raw_core::pipeline::apply_scene_linear_chain_f32`) and WGSL on the GPU (`raw-gpu`). See [pipeline](pipeline.md).

### GPU live vs CPU refine

The wgpu live path is always compiled and on by default; `GpuLiveFlag` turns it off only when the process is launched with `MAPLE_GPU_LIVE=0`. It is a _parallel presentation path_, not a rewrite: `GpuLiveDriver` opens a `GpuLiveSession` actor (one render in flight), uploads the decoded buffer once per dimension change, and presents straight from an f32 storage buffer into the canvas `CAMetalLayer` with no CPU readback. When it handles a frame it returns `true` and the caller skips the CoreImage publish entirely. It declines — falling back to CPU + CoreImage byte-for-byte — when the flag is off, no layer is registered yet, the session open or readback fails, or the sensor is too large: `gpuLiveMaxSensorLongEdge` is 13000 px, which covers the ~100 MP class (DJI/Hasselblad ≈12288, GFX ≈11648) while keeping bigger sensors on the memory-safe CPU path. A sensor size of zero (not yet seeded, as for PhotoKit assets whose size resolves asynchronously) also declines, because taking the GPU path on an unknown-size RAW is what previously OOM-killed a 100 MP library photo.

### Resolution ceilings

- A fast-phase decode with no usable viewport target caps at a **1500 px long edge** (`fastPhaseFallbackLongEdge`, ≈2 MP).
- A refine decode escalates demosaic quality when the display genuinely needs more than half-res: `refineDecodeQuality` returns `.preview` while the target is at or below `nativeLongEdge / 2`, and `.amaze` (or `.full`) above it. `.preview` caps its own output at roughly half the native long edge regardless of what the caller asks for, so without the escalation the canvas would upscale 2× then immediately downscale again.
- `cappedToDelivered` is the downstream safety net, clamping the display target to the extent the decode actually returned.
- Deep zoom is **off by default** — `EditSession.deepZoomEnabled` is `false`, so refine always uses the whole-image sized FFI even above 1:1, trading speed for freedom from tile-boundary seams. See [zoom](zoom.md).

### Auto profile

`Profile::Auto` is a per-image, post-AgX display-space tail: a per-channel tone curve composed with a residual 3D LUT, both fit in f32 sRGB-encoded display space by one FFI call (`maple_compute_auto_profile_lut`) and applied on the CPU path as a `CIColorCubeWithColorSpace` tagged sRGB — the last op before the canvas raster, so CoreImage's own color management performs the encode. `AutoProfileLUT` caches the baked cube keyed on URL + mtime + quality. The fit is a cold operation (JPEG extract plus a full develop), so the CPU path only computes it after the GPU present has declined the frame; the GPU path does its own fit inside the session.

### Runtime flags

| Variable                                            | Effect                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `MAPLE_GPU_LIVE=0`                                  | kill-switch — forces the CPU + CoreImage path                                             |
| `MAPLE_GPU_HUD=1`                                   | on-screen frame-time HUD (`GpuFrameTimeHud`)                                              |
| `MAPLE_GPU_DEBUG=1`                                 | GPU debug view (`GpuDebugView`)                                                           |
| `MAPLE_AMAZE=1` / `=0`                              | force AMaZE demosaic on/off; otherwise the `useAmazeDemosaic` user default, defaulting on |
| `MAPLE_AUTO1` (or `-MapleAuto1 1`)                  | restore the older Auto-profile fit                                                        |
| `MAPLE_UITEST_FIXTURE`, `MAPLE_UITEST_FIXTURE_ROOT` | UI-test harness fixture selection                                                         |

## Sources

Every photo origin implements the `ImageSource` protocol (`Sources/ImageSource.swift`); each concrete implementation is an `actor`, so calls are implicitly async.

| Adapter            | Backing                        | Notes                                                                                                                                                        |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FilesystemSource` | local folder                   | security-scoped bookmarks persisted via `BookmarkStore`; `NSOpenPanel` on macOS, `.fileImporter` on iOS                                                      |
| `SMBSource`        | SMB 2/3 share via AMSMB2       | recursive walk of the share root; sidecar writes retried with backoff                                                                                        |
| `PhotoKitSource`   | Apple Photos                   | holds a live `PHFetchResult` rather than an eager array, so a 100k library opens in constant time; RAW bytes requested `.unadjusted` with network access off |
| `CloudSource`      | Maple Self Hosted / Hosted API | lists via `/api/fs/dir`, `ImageRef.id` is `fs:<absPath>`, thumbs and bytes by absolute path                                                                  |
| `ComposedSource`   | pairs two of the above         | metadata and thumbs from the API, RAW bytes and XMP writes from SMB on the LAN                                                                               |

`MergedTimelineSource` is pure merge logic (no I/O) that unions any number of PhotoKit streams with any number of cloud streams and labels each cell `.synced`, `.cloudOnly` or `.localOnly`, ordered capture-date descending. It backs the all-sources timeline in `Cloud/AllSourcesTimelineViewModel.swift`.

## Sidecars

`SidecarStoreProtocol` is what `EditSession` needs: `load()`, `loadIfPresent()`, `update(model:culling:)`, `flush()`, `errors()`. `loadIfPresent()` returning `nil` is the signal to seed from as-shot white balance rather than honour stored edits, so it must distinguish "no sidecar" from "sidecar full of defaults".

- `XMPSidecarStore` — local files. Writes are debounced 750 ms and land atomically via temp file plus rename, at `<raw-basename>.xmp` beside the original.
- `SMBSidecarStore` / `CloudSidecarStore` — the same surface over SMB and over the API.
- `PhotoKitSidecarStore` — same 750 ms debounce, but persists into MapleBackup's `AppSupportSidecarStore` keyed by PHAsset local id, because a Photos asset has no stable on-disk path to put a `.xmp` next to. This is also the store `BackupEngine` reads when deciding whether a real local edit exists to upload as a companion.

Serialization lives in the `XMPSerialization+*.swift` family, with `XMPPassthrough` preserving unknown XML byte-for-byte. The schema and canonical byte form are in [xmp-canonical-format](xmp-canonical-format.md).

## File Provider and Quick Look

The macOS and iOS File Provider extensions are both three-line subclasses (`FileProviderExtension`, `FileProviderExtensionIOS`) whose entire behaviour is `MapleCore.FileProviderExtensionCore`, an `NSFileProviderReplicatedExtension`. Configuration crosses the process boundary as JSON files in the App Group container at `~/Library/Group Containers/group.app.justmaple.aperture/FileProviderConfig/<domain>.json` — `UserDefaults(suiteName:)` was abandoned because CFPreferences rejects `kCFPreferencesAnyUser` with a container. Missing the App Group entitlement is survivable: the config falls back to the caches directory, logs an error, and the extension boots dormant.

`FileProviderIdentifier` is the item vocabulary: assets, folders, non-indexed files, sidecars (including `(conflict from <device>).xmp` copies), a per-library trash container, and synthetic `.maple/` and `.maple/thumbs/` directories the extension fabricates client-side because the server hides dotdirs from `/api/fs/dir`. Thumbnail filenames inside them come from `MapleThumbCacheKey.sha256Prefix16(basename)` — the first 16 hex chars of SHA-256 over the _filename_, not the path, which is what lets `.maple/` travel with the photos. That helper is the single source of truth shared with `Cache/ThumbnailDiskCache.swift`, the Bun server, and the web cache.

`RemoteCatalog` fetches listings from the server with ETag caching; `ChangeFeedClient` holds an SSE subscription to `/api/changes/subscribe`, resuming from a stored cursor and reconnecting with exponential backoff capped at 16 s. On a 409 (stale cursor) it purges the ETag cache and signals `.workingSet` so the OS re-enumerates from scratch. `WorkingSet` is a bounded table of warm identifiers with kind-aware eviction: sidecars and favourites are eviction-immune, explicitly-requested items go next, and recency entries (last 30 days) are dropped first.

`MapleQuickLook` hooks Finder's spacebar preview. Given the local cache URL of a File Provider file, it resolves back to `(domain, assetID)` through the shared `FileProviderMetaStore` SQLite mirror and fetches the pre-baked AVIF from `GET /api/assets/<id>/thumb`, which is orders of magnitude cheaper than materializing and decoding a 40–150 MB RAW. Any failure throws, and the Quick Look runtime falls back to the system default — never worse than not having the extension.

## Other targets

**MapleBackupAgent** is a macOS LaunchAgent binary (`@main` in `MapleBackupAgentEntryPoint.swift`, named that way because `main.swift` and `@main` are mutually exclusive) that runs the same `MapleBackup` engine against the same settings the app writes, so backups continue with the app closed. Its `launchd` plist labels it `app.justmaple.aperture.backup` and points at `MapleAperture.app/Contents/Helpers/MapleBackupAgent`. On iOS the equivalent is a background task registered under `app.justmaple.aperture.backup.refresh` (`INFOPLIST_KEY_BGTaskSchedulerPermittedIdentifiers`, `Maple/Backup/BGTaskRegistration.swift`).

**MapleWidget** shows a photo from the day's generated collections with its caption, sized so small/medium/large earn their content rather than scaling one layout. It links only MapleCloudKit and talks to the server through `WidgetSession`.

**Maple TV** is a separate tvOS app: timeline, light table, map with heatmap overlay, search, generated-search shelves, and a photo/video viewer, paired to a phone or iPad over the local network (`MapleCloudKit/Pairing`). It imports MapleCloudKit, SwiftUI, MapKit, AVKit and UIKit — deliberately not MapleCore or RawPipeline, so nothing tvOS has to link the Rust static library.

## Build and test

```bash
# One-time per clone/worktree: build the Rust static libs.
./src/apple/scripts/build-xcframework.sh

# macOS app
xcodebuild -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" \
           -destination 'platform=macOS' build

# iOS simulator — name a specific arm64 simulator. The xcframework's
# simulator slice is arm64-only, so 'generic/platform=iOS Simulator'
# fails on the x86_64 link step.
xcodebuild -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" \
           -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build

# Package unit tests
cd src/apple/Packages/MapleCore && swift test
cd src/apple/Packages/MapleBackup && swift test
cd src/apple/Packages/MapleUI && swift test
```

Cloud CI is deliberately narrow. `.github/workflows/apple.yml` runs a single job on `macos-15` that does `swift build` of the MapleCore package on any change under `src/apple/**` or `src/raw-pipeline/**`. It never cross-compiles Rust: it runs `cbindgen` to generate `RawPipeline.h`, copies it into all three xcframework slices, and fakes `libraw_ffi.a` with a one-object stub archive, because SwiftPM validates that a binary target's archive exists but only links it into executables — which this job doesn't build. That is enough to catch the recurring failure mode where codegen adds an enum case beside an exhaustive `switch` that never gains an arm. **It is a compile gate only** — no Apple test target runs in cloud CI, and the app, extension and tvOS targets are never built there. Verify those locally or through Xcode Cloud.

### UI test harnesses

All three live in `MapleUITests` and share `Helpers/MapleAppDriver.swift` (launch, wait for the `canvas-render-ready` accessibility identifier, screenshot the canvas), `Helpers/GoldenStore.swift` and the Swift CIEDE2000 port in `Helpers/CIEDE2000.swift`. Every one skip-passes when its fixtures are absent, mirroring the Rust harness convention.

**Golden canvas** (`MapleUITests.testCanvasMatchesGolden`) launches with `test_0017.dng`, screenshots the canvas, and diffs against `MapleUITests/Goldens/test_0017-default.png` at mean ΔE ≤ 5, p95 ≤ 10, max ≤ 30, per-channel bias ≤ 0.05. Deleting the PNG re-records it; the run then fails with a "baseline written" message so a human eyeballs the new baseline before committing.

```bash
xcodebuild test -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' -only-testing:MapleUITests \
  MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
```

**Slider matrix** (`SliderMatrixUITests`) walks every committed slider XMP under `test-fixtures/references/test_NNNN/xmp/`, stages a temp directory with the RAW plus the XMP renamed to the canonical sidecar name, relaunches the app against it, screenshots, resizes both candidate and reference to a 1024 px long edge, and diffs. Budgets are loose on purpose — mean ≤ 25, p95 ≤ 50, max ≤ 100, bias ≤ 0.10 — because Maple's AgX view transform differs from the reference renderer's even when the color math is right. Failed cases attach both PNGs for triage.

```bash
xcodebuild test -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' -only-testing:MapleUITests/SliderMatrixUITests
```

**Synthetic grey** (`SyntheticGreyUITests`) renders a hand-rolled neutral DNG (`MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng`) through the full Apple path and asserts two things per case: every pixel is neutral (R == G == B within 2 LSB), and the canvas mean matches the Rust-rendered mean within 3 LSB. Expected means are integers in the test file, regenerated from the Rust `grey_adjustments` test.

`CIEDE2000Tests` cross-validates the Swift ΔE port against `src/scripts/compare_images.py` using the PNG pair under `MapleUITests/Goldens/.calibration/`. Other classes in the bundle cover launch screenshots, the film panel, tone-curve panel, iPad present seams, sidecar seams, phone empty states, File Provider settings, and the pano ONNX Runtime self-test (the one class that also compiles for the iOS Simulator). The broader gate map is in [testing](testing.md).

**First run on a Mac** asks for keychain/TouchID authorization; the `xcodebuild test` invocation hangs for minutes and then fails with a `LocalAuthentication … BiometryType=1` error. Authorize once by running the test through Xcode's UI, and subsequent CLI runs reuse the cached credential. The screen must also be unlocked — a UI test cannot drive a locked Mac.

## Platform-gated code

The app target compiles for macOS, iOS and iPadOS from the same sources, so both builds must stay green. The codebase carries roughly 100 `#if os(iOS)` and 100 `#if os(macOS)` blocks plus ~30 `canImport(UIKit)` guards. A macOS build never type-checks the contents of an `#if os(iOS)` block, so a change inside one can merge green and break the iOS build silently — build both destinations before claiming an Apple change works.

The pattern shows up in test code too: `MapleUITests.swift`, `SliderMatrixUITests.swift` and `SyntheticGreyUITests.swift` all wrap themselves in `#if os(macOS)` because they drive AppKit, which lets the bundle still compile for the iOS Simulator where `PanoOrtSelftestUITests` runs. Extensions are the other axis: `MapleFileProvider` is macOS-only and `MapleFileProviderIOS` iOS-only (`SUPPORTED_PLATFORMS` in `project.pbxproj`), which is why the same core class has two thin subclasses instead of one shared target.
