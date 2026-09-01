# Architecture

Maple is a non-destructive RAW photo editor that ships as several apps sharing one image-processing engine. The engine is a Rust cargo workspace under `src/raw-pipeline/`; every app reaches it through a different binding — a static library inside an `.xcframework` for the Apple apps, a WebAssembly module for the browser, a `bun:ffi` dynamic library for the server, and a Windows DLL for the WinUI shell. Photos always stay where the user put them: edits are written to `.xmp` sidecar files next to the originals, and everything else (thumbnails, previews, the MongoDB index) is derived data that can be deleted and rebuilt. On screen, every app runs the same two-phase render — an immediate viewport-resolution pass on each slider tick, then a debounced full-resolution refine — over a scene-referred, unbounded linear Rec.2020 working space that is compressed to display range exactly once, at the end of the chain.

## Deploy units

Each row is something you build and ship separately.

| Unit                                             | Where                            | Built from                                          | Talks to                                                                           |
| ------------------------------------------------ | -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Maple Exposure** (macOS / iOS / iPadOS)        | `src/apple/Maple/` + `Packages/` | Xcode target, bundle id `app.justmaple.aperture`    | Local files, SMB, PhotoKit, a Maple server                                         |
| **Maple TV** (tvOS)                              | `src/apple/Maple TV/`            | Xcode target, `…aperture.tv`                        | A Maple server only (links `MapleCloudKit`, never the RAW pipeline)                |
| **MapleFileProvider** / **MapleFileProviderIOS** | `src/apple/MapleFileProvider*/`  | Xcode app extensions, `…aperture.FileProvider(IOS)` | Surfaces a server library in Finder / Files                                        |
| **MapleQuickLook** (macOS)                       | `src/apple/MapleQuickLook/`      | Xcode extension, `…aperture.QuickLook`              | Renders previews for Finder                                                        |
| **MapleWidget**                                  | `src/apple/MapleWidget/`         | Xcode extension, `…aperture.Widget`                 | Generated-search shelf on the home screen                                          |
| **MapleBackupAgent** (macOS)                     | `src/apple/MapleBackupAgent/`    | LaunchAgent target                                  | Runs the PhotoKit backup engine outside the app                                    |
| **`maple`** — Self Hosted web UI                 | `src/web/projects/maple/`        | `ng build maple`                                    | The Bun API; served _by_ it                                                        |
| **`maple-syrup`** — Hosted web UI                | `src/web/projects/maple-syrup/`  | `ng build maple-syrup`                              | Nothing. Browser-only, no account, no database                                     |
| **Maple API** (Self Hosted server)               | `src/api/`                       | `bun src/index.ts`, Docker or systemd               | MongoDB; optionally Meilisearch, Cloudflare R2, Nominatim, a describe model server |
| **Maple.WinUI** (Windows)                        | `src/windows/Maple.WinUI/`       | `dotnet build`, .NET 8 + WinUI 3                    | Local files via `raw_ffi.dll`                                                      |
| **maple-thumb-cache** (Cloudflare Worker)        | `src/cloudflare/`                | `wrangler deploy`                                   | Fronts the API's `GET /api/thumb/*` with an R2 edge cache                          |

The two web apps are one codebase. Every component, shell, service, and the whole XMP pipeline live in the `maple-common` Angular library; the apps differ only in which workspace provider they install — `provideSelfHostedWorkspace()` in `projects/maple/src/app/app.config.ts` versus `provideHostedWorkspace()` in `projects/maple-syrup/src/app/app.config.ts` — and in a handful of capability tokens (folder CRUD, batch rename) that only the server-backed app turns on. Self Hosted redirects `/` to `/browse`; Hosted's `/` is a landing page with "open a photo" / "open a folder" buttons backed by the File System Access API.

`src/windows/` also contains `maple-windows`, a small Rust host crate (`src/windows/src/`) providing sidecar I/O and a folder watcher over `raw-core`, plus a `tauri.conf.json`. The shipping Windows UI is the WinUI 3 C# app, which P/Invokes `raw_ffi.dll` directly (`src/windows/Maple.WinUI/Native/RawFfi.cs`).

See [features](features.md) for what each surface actually does, and [apple](apple.md), [web](web.md), [api](api.md), [windows](windows.md) for the per-unit detail.

## One Rust core, four bindings

All colour and geometry math lives in `src/raw-pipeline/`, a cargo workspace of seven crates:

| Crate        | Role                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw-core`   | Decode, demosaic, camera calibration, every develop stage, the AgX view transform, XMP parse/serialize, stable image ids                                       |
| `raw-gpu`    | wgpu/WGSL implementations of the same stages, plus the live-session runner and the present path. Optional (`gpu` feature); wgpu is absent from a default build |
| `raw-ffi`    | C ABI over `raw-core` + `raw-gpu`. `crate-type = ["staticlib", "cdylib", "rlib"]`                                                                              |
| `raw-wasm`   | `wasm-bindgen` surface for the browser                                                                                                                         |
| `maple-pano` | Panorama stitching (geometry solve, ALIKED + LightGlue via ONNX Runtime, compositing)                                                                          |
| `maple-cli`  | Deterministic headless harness — `render`, `batch`, `diff`, `tile`, `pano`, `synthetic`, and more                                                              |
| `codegen`    | Emits the cross-language constant files (see below)                                                                                                            |

How each app gets it:

- **Apple** — `src/apple/scripts/build-xcframework.sh` compiles `raw-ffi` for `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `aarch64-apple-darwin`, and `x86_64-apple-darwin` with `--features gpu` plus a pano feature (`pano` for macOS, `pano-ios` for the iOS slices, which link ONNX Runtime statically because the iOS sandbox blocks `dlopen`). It runs cbindgen, lipos the two macOS arches, and produces `src/apple/Frameworks/RawPipeline.xcframework`. `MapleCore`'s `Package.swift` consumes that as a `.binaryTarget`; `RawCoreBridge.swift` is the Swift side of the contract. The `.a` files are gitignored (too large for GitHub), so a fresh clone must run the script once before Xcode will link.
- **Web** — `src/raw-pipeline/raw-wasm/build.sh` runs `wasm-pack build --target web --release --features gpu,parallel -Z build-std=panic_abort,std`. The `-Z build-std` is not optional: the crate needs the atomics / bulk-memory target features from `raw-wasm/.cargo/config.toml` for `wasm-bindgen-rayon` to link. `src/web/scripts/sync-raw-wasm.sh` copies the generated `pkg/` into `maple-common`, where the render worker imports it. `pkg/` is gitignored.
- **API** — `src/api/scripts/build-raw-ffi.sh` builds the same crate as a dylib into `src/api/native/`, loaded through `bun:ffi` by `src/api/src/ffi/raw_ffi.ts`. It is never `dlopen`'d in the HTTP process: decode runs in a pool of child processes (`src/api/src/ffi/ffi-pool.ts`, `ffi-child-worker.ts`) so a libraw segfault on a malformed RAW kills one child, which the pool respawns, instead of the server.
- **Windows** — `src/windows/scripts/build-windows.sh` builds `raw-ffi --features gpu` for `x86_64-pc-windows-msvc`; the C# app declares `[DllImport("raw_ffi.dll")]` against it and mirrors the FFI structs field-for-field, with a startup `RawFfi.VerifyAbi()` size assertion.

Third-party crates are vendored under `src/raw-pipeline/vendor/` so the Apple and Windows builds work offline.

Details of the stages themselves are in [pipeline](pipeline.md); stitching is in [pano](pano.md).

## Data model

Four layers, in decreasing order of authority.

1. **Originals.** The RAW / JPEG / HEIF / video file on disk (or in PhotoKit, or on an SMB share). Never modified, never moved except by an explicit user action.
2. **`.xmp` sidecars.** Every adjustment the user makes. Images use stem-swap (`IMG_1.ARW` → `IMG_1.xmp`); videos keep their extension (`clip.mov` → `clip.mov.xmp`). Unknown XML from other tools is preserved byte-for-byte on rewrite. The sidecar is the contract, and it has four independent implementations that must agree: Rust (`src/raw-pipeline/raw-core/src/xmp/`), Swift (`src/apple/Packages/MapleCore/Sources/MapleCore/XMPSerialization*.swift`), TypeScript in the browser (`src/web/projects/maple-common/src/lib/xmp/`), and C# on Windows (`src/windows/Maple.WinUI/Services/Xmp/`). The server has a narrower fifth writer (`src/api/src/xmp/`) that merges only metadata fields — keywords, ratings, colour labels — into an existing sidecar, reusing the web layer's pure encode helpers. See [xmp-canonical-format](xmp-canonical-format.md).
3. **`.maple/` folder cache.** A hidden directory created lazily inside each library folder, holding derived bytes: `<folder>/.maple/thumbs/<sha256-prefix16-of-filename>.avif`, `<folder>/.maple/previews/<filename>.<suffix>`, and `<folder>/.maple/trash/<relpath>` for soft-deleted files. Resolved by `src/api/src/fs/xmp.ts`. Deleting it costs only regeneration time.
4. **MongoDB asset documents.** The server's searchable index — one doc per file, carrying EXIF, geocoded place, faces, description text, and per-stage progress. Explicitly non-authoritative: `src/api/src/db/schema.ts` says so in its header. Collections include `folders`, `assets`, `people`, `jobs`, `imports`, `indexer_queue`, `discover_frontier`, `asset_changes`, `mirror_queue`, and the auth set (`users`, `credentials`, `invites`, `refresh_tokens`, `challenges`).

Identity is content-derived, not path-derived. `raw_core::id` computes a 16-byte **MapleId**: normally `BLAKE3(sha1(first 64 KB) || capture time || camera serial || shutter count)`, falling back to `BLAKE3(sha1(whole file) || file size)` for phone snapshots with no usable EXIF. The first byte tags which form was used so the two can never collide. That id is what lets the same photo be recognised across a laptop, a server, and a phone.

Addressing across the UI layers uses a `slug:relPath` grammar — library slug, then a POSIX-relative path — parsed by `src/web/projects/maple-common/src/lib/addressing/maple-address.ts`. Splitting on the _first_ colon only keeps filenames containing colons intact.

A library can also declare **mirror locations** (`MirrorLocation` in `src/api/src/db/schema.ts`). Every durable write under the primary root replicates to each enabled mirror, and an enabled mirror doubles as a read replica when the primary volume is unreachable (`src/api/src/fs/mirrored.ts`, `mirror-read.ts`).

## The render model

Every editing surface implements the same two phases.

- **Fast phase** — runs immediately on every slider tick, at viewport resolution (element size × device pixel ratio) using the preview-quality demosaic. Only the most recent tick survives: older work is cancelled or its result dropped.
- **Refine phase** — a 150 ms trailing debounce that re-renders at full resolution. During a continuous drag the refine task is cancelled on every tick, so it fires once, when the user lets go.

On Apple this lives in `RenderActor` and `EditSession+RenderScheduling.swift` (`RenderActor.refineDebounceMilliseconds = 150`); the actor owns the task handles, the generation counter, and the cancel/coalesce decisions, while the render work itself stays on the main actor. On the web it is `TwoPhaseRenderScheduler` in `src/web/projects/maple-common/src/lib/components/image-canvas/image-canvas.two-phase.ts` (`REFINE_DEBOUNCE_MS = 150`). Because a WASM render cannot be interrupted mid-flight, the web's "cancel" is really "drop the stale result via the generation counter."

Underneath, two things happen per tick. The expensive part — decode, demosaic, camera profile, auto-exposure — runs once and its result is cached as an fp16 RGBA buffer in scene-linear Rec.2020. Each subsequent tick re-runs only the cheap, model-dependent stages on that buffer: `raw_core::pipeline::scene_linear_chain` on the CPU, or the equivalent WGSL chain in `raw-gpu` on the GPU.

When a GPU is available, the app opens a **live session** instead: the decoded image is uploaded to the GPU once, and each tick is a uniform update plus a dispatch, presenting straight to the platform surface with no readback. On Apple that is `maple_gpu_live_*` in `src/raw-pipeline/raw-ffi/src/gpu_live.rs` presenting to a `CAMetalLayer`, driven by `GpuLiveSession.swift` / `GpuLiveDriver.swift`. On the web it is a `WebLiveSession` in the render worker presenting to a transferred `OffscreenCanvas` (`image-canvas.gpu-present.ts`). Because the live session is already frame-rate-ready, the refine pass is skipped while it is active. If WebGPU is missing or the first present comes back black, the web canvas tears the session down and falls back to the 2D path for the rest of the page session.

The GPU is never the reference. `raw-core`'s CPU chain is the oracle, and CI diffs the WGSL chain against it (the `raw-gpu` job in `.github/workflows/raw-pipeline.yml`).

Deep zoom is a third path — a tile renderer (`raw_core::pipeline::tile`, `TileManager.swift`, the canvas zoom host on web) that renders only the visible region at native resolution. See [zoom](zoom.md).

## The scene-referred invariant

The working space is unbounded f32 linear Rec.2020 at D65 — `ColorSpace::SceneLinearRec2020` in `src/raw-pipeline/raw-core/src/image.rs`, described there as "scene-referred linear Rec.2020 D65, f32, **unbounded**." The `ColorSpace` enum is threaded through every stage and asserted at stage boundaries, so a stage cannot silently run on the wrong space.

The full order, from `src/raw-pipeline/raw-core/src/pipeline/develop/mod.rs`: linearize → demosaic → DNG `BaselineExposure` → DNG white-balance pre-gain → highlight recovery → camera profile (DCP colour matrix + forward matrix + hue/sat map, in linear ProPhoto D50, then converted to Rec.2020) → profile gain table → damped auto-exposure → white balance → scene tone controls → tone curves → vibrance → saturation → HSL → clarity → texture → dehaze → local adjustments → vignette → sharpen → luminance NR → colour NR.

Nothing in that list clips. Exposure is literally a multiply: `scene_tone_controls` computes `exp_gain = model.exposure.exp2()` and scales. Range compression happens once, afterwards, in the view transform: Sobotka AgX (`src/raw-pipeline/raw-core/src/view/agx.rs`) — inset matrix, a ratio-preserving sigmoid applied to `max(R,G,B)` so hue is invariant by construction, outset matrix, then Oklab hue-preserving gamut compression into the unit cube. Only then does `view/encode.rs` convert to the display primaries (sRGB or Display P3, chosen per surface — Apple tags its layer P3, and the web render worker tags the canvas display-P3 at session open) and apply the sRGB OETF.

The AgX matrices, sigmoid coefficients, and LUT are derived by `src/scripts/derive_agx_lut.py` and emitted to `agx_coeffs.rs`, `agx_lut.bin`, and a WGSL constant file, so the CPU, GPU, and Apple-bundled copies come from one source.

## Single-sourced constants

Anything that appears in more than one language is generated, never hand-copied. `tools/codegen.sh` builds the `codegen` crate and emits, from `raw-core` as the source of truth:

| Schema                                      | Source in `raw-core`            | Emitted to                                                                                                                                                           |
| ------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adjustment model                            | `types::ADJUSTMENT_SCHEMA`      | Swift (`MapleCore/Generated/AdjustmentModel+Generated.swift`), TS (`maple-common/src/lib/generated/adjustment-model.generated.ts`, `adjustment-tables.generated.ts`) |
| UI tokens (colour, motion, radius, spacing) | `ui_tokens`                     | Swift ×2 (`MapleCore`, `MapleUI`), TS, SCSS, WinUI XAML (`Maple.WinUI/Themes/Tokens.xaml`)                                                                           |
| Colour matrices                             | `color::{matrices, oklab}`      | WGSL (`raw-gpu/src/generated/color_matrices.wgsl`), TS                                                                                                               |
| AgX coefficients                            | `src/scripts/derive_agx_lut.py` | WGSL (`raw-gpu/src/generated/agx_coeffs.wgsl`)                                                                                                                       |
| Film catalog                                | `film_catalog::FILM_CATALOG`    | Swift, TS                                                                                                                                                            |

The C header for the Apple FFI is not generated here — cbindgen runs as part of `build-xcframework.sh`.

The `codegen-drift` job in `.github/workflows/cross.yml` regenerates everything and fails if the committed outputs differ, so a matrix retune cannot land on one platform and not the others. Change a constant, run `tools/codegen.sh`, commit the regenerated files.

## Project layout

```
src/
  raw-pipeline/                 cargo workspace (see "One Rust core" above)
    raw-core/  raw-gpu/  raw-ffi/  raw-wasm/  maple-pano/  maple-cli/  codegen/
    vendor/                     vendored crates (offline Apple/Windows builds)
  apple/
    Maple.xcodeproj             all Apple targets
    Maple/                      "Maple Exposure" app target (SwiftUI shell, Views/, Auth/, Backup/)
    Maple TV/                   tvOS app target
    MapleFileProvider/  MapleFileProviderIOS/  MapleQuickLook/  MapleWidget/
    MapleBackupAgent/           macOS LaunchAgent
    MapleTests/  MapleUITests/  unit + visual-regression targets
    Packages/
      MapleCore/                pipeline, sidecars, sources, caches, MapleCloudKit
      MapleUI/                  dependency-free design system
      MapleBackup/              PhotoKit backup engine (GRDB-backed)
    Frameworks/RawPipeline.xcframework
    scripts/                    build-xcframework.sh, ORT fetch, target-edit scripts
  web/
    angular.json                two applications + one library
    projects/maple/             Self Hosted app (settings/, sign-in/, self-hosted-*)
    projects/maple-syrup/       Hosted app (landing/, hosted-editor-route/)
    projects/maple-common/      everything shared: components, shells, state,
                                raw-pipeline worker, xmp, addressing, generated/
    e2e/                        Playwright specs (incl. e2e/production/)
    scripts/                    format, wasm sync, brand + docs sync, artifact checks
  api/
    src/index.ts                Elysia app assembly + startup
    src/{routes,auth,db,fs,ffi,indexer,workers,enrichment,job-runner,...}
    native/                     libraw_ffi.{dylib,so}
    Dockerfile  docker-compose.yml  maple.service
  windows/
    Maple.WinUI/                WinUI 3 C# shell (Native/ = raw_ffi P/Invoke)
    Maple.WinUI.Tests/          sidecar tests
    src/                        maple-windows Rust host crate
  cloudflare/                   thumbnail-cache Worker (npm/Node, not Bun)
  scripts/                      colour + pano harnesses, ΔE tooling, AgX derivation
docs/                           this documentation set
tools/                          codegen.sh, file-budget + ratchet checks, calibration
test-fixtures/                  references/, budgets.json (RAWs themselves gitignored)
resources/film-luts/            film look cube pack
```

## Building and testing each unit

```bash
# Rust core
cd src/raw-pipeline
cargo test -p raw-core --lib
cargo run --release --bin maple-cli -- batch manifest.json --out-dir candidates/

# Colour correctness (the canonical gate; skip-passes without fixtures)
src/scripts/test_color_pipeline.sh
FILTER=baseline src/scripts/test_color_pipeline.sh

# Apple — build the xcframework once per clone/worktree, then Xcode
./src/apple/scripts/build-xcframework.sh
cd src/apple && xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
  -destination 'platform=macOS' build
cd src/apple/Packages/MapleCore && swift test

# Web — the WASM pkg/ must exist before serve/build/test resolve it
cd src/raw-pipeline/raw-wasm && bash build.sh
cd src/web && bash scripts/sync-raw-wasm.sh
bun run start:maple      # Self Hosted, :4201    (prestart rebuilds WASM)
bun run start:syrup      # Hosted, :4200
bun run test
bun run format:check

# API
cd src/api && bun install && bun run dev
bun test
./src/api/scripts/build-raw-ffi.sh

# Windows (on Windows, with MSVC + .NET 8)
bash src/windows/scripts/build-windows.sh

# Cloudflare Worker (Node, not Bun — see src/cloudflare/README.md)
cd src/cloudflare && npm test
```

CI mirrors these in `.github/workflows/`: `raw-pipeline.yml` (`build-raw-ffi`, `raw-gpu`, `rust-tests`, `color-pipeline`, `pano-pipeline`), `web.yml`, `api.yml`, `apple.yml` (a `MapleCore` compile gate only), `windows.yml`, `cloudflare.yml`, `face-clustering.yml`, and `cross.yml` for the repo-wide gates — Prettier, oxlint, the 400-soft / 600-hard line budget, `codegen-drift`, and the one-way budget ratchets. `deploy-hosted.yml` publishes `maple-syrup` on every push to `main` that touches `src/web/` or `src/raw-pipeline/`. Full detail in [testing](testing.md).

## Where things run at runtime

The Self Hosted server is deliberately more than one process. The HTTP process (`src/api/src/index.ts`) builds the Elysia app — request-context and error envelope, security headers, per-route body limits, the public routes, the bearer-gated `authedApi` sub-tree, an OpenAPI spec at `/openapi.json` with a Scalar UI at `/docs`, and a catch-all that serves the built Angular bundle from `src/web/dist/maple/browser/`. Its startup then spawns two kinds of children:

- the **FFI decode pool** — one niced child process per concurrent RAW decode, so a native crash can't take the server down;
- the **worker tier** — a single niced child running `startWorkers()`, which owns the discover walk, the per-asset stage runners, enrichment, the job runner, and imports. It auto-respawns with exponential backoff on crash.

Per-asset background work is modelled as _stages_, not jobs: `exif`, `thumb`, `preview`, `face-detect`, `face-embed`, `describe`, `geocode`, `meili`, `sidecar-metadata-index`, `cf-thumb-sync`, `transcribe` (`src/api/src/workers/stages/manifest.ts`). Each gets claiming, retry/backoff, dead-lettering, pause/resume, and a live progress row on Settings → Workers from the generic machinery in `run-stage.ts`. The **job runner** (`src/api/src/job-runner/`) is reserved for one-off, user-triggered actions — `batch_jpeg_export` and `pano_stitch`, the latter shelling out to `maple-cli pano stitch`. See [indexer-enrichment](indexer-enrichment.md) and [server-api](server-api.md).

Optional external services, all off unless configured: MongoDB is the only hard dependency (the server boots without it and 503s the DB-bound routes). Meilisearch adds typo-tolerant and semantic search; a Nominatim instance drives reverse geocoding; Cloudflare R2 plus the thumbnail Worker put thumbnails on the edge; an OTLP/HTTP endpoint receives traces and logs from the server, the Angular apps, and `MapleCore`.

Read next: [caching](caching.md) for what is cached where and what invalidates it, [best-practices](best-practices.md) for the coding standards each layer follows.
