# Maple

A professional, non-destructive RAW photo editor by Just Maple. Runs natively on macOS, iPadOS, and iOS via a Swift + SwiftUI shell, and in evergreen browsers via Angular — both backed by a shared Rust image-processing core.

The product bar is: color quality that a working photographer will trust, and a slider that responds inside a single 60Hz frame on a 100MP RAW.

## Product summary

Three-column shell (sources tree / image grid / detail inspector) on desktop and tablet, single-column on phone. Two modes — **Browse** (grid) and **Full image** (large preview with filmstrip). Every edit is non-destructive and persists to **XMP sidecars** — originals are never touched.

The full feature spec is in `docs/feature-spec.md`. The UI contract is in `docs/ui-spec.md`. The interactive layout reference is `docs/mockup.html`. These are the source of truth, not this file.

## Load-bearing principles

Treat these as invariants. If you're about to violate one, stop and ask.

1. **Non-destructive only.** Original files are never modified. All edits go to `.xmp` sidecars. The sidecar is the contract; the pixels are derived.
2. **Scene-referred pipeline.** The working space is linear Rec.2020 D65 at f32. Exposure is a linear multiply. A single view transform at the end of the chain compresses scene range into display range. Nothing before the view transform clips.
3. **One Rust core, three native pipelines.** Color math (decode, demosaic, calibration, LUT generation, dehaze, deconvolution) lives in `src/raw-pipeline/crates/raw-core`. That crate compiles once as a static library for Apple (via C-FFI) and once as WebAssembly for browsers. Platform GPU paths (Metal, WebGL2) are idiomatic on each platform but gated against the Rust reference.
4. **Parity before features.** Pixel parity between Apple and Web is a merge gate, not an aspiration. See `docs/testing.md` for the harness.
5. **Performance is a product feature.** Target: slider tick renders a new preview inside 16ms on supported hardware. No feature ships that breaks that budget on the reference scene set.

## Tech stack

| Layer         | Apple                                 | Web                                | Shared                           |
| ------------- | ------------------------------------- | ---------------------------------- | -------------------------------- |
| UI            | SwiftUI                               | Angular 21 + standalone components | —                                |
| State         | `@Observable` (Observation framework) | Signals + RxJS observables         | —                                |
| Image decode  | Rust core via C-FFI (xcframework)     | Rust core via WASM                 | `raw-core` crate                 |
| GPU pipeline  | Metal Shading Language                | WebGL2 GLSL ES 3.0                 | Coefficients generated from Rust |
| Sidecar I/O   | Custom XMP writer in Swift            | Custom XMP writer in TypeScript    | Schema validated on both sides   |
| Thumbnails    | `CGImageSource` + disk cache          | WASM thumb extraction + IndexedDB  | —                                |
| API (web)     | —                                     | Angular `HttpClient` → Bun/Elysia  | Shared DTO types via codegen     |
| Offline (web) | —                                     | Angular service worker + IndexedDB | —                                |

## Project layout

```
src/
  apple/                      # Swift app (Mac, iOS, iPad) — SPM-based
    Package.swift             # Declares MapleCore + MapleApp targets
    Sources/MapleCore/        # Pipeline, sidecar, source adapters, caches
    Sources/MapleApp/         # SwiftUI shell (AppShell, Browse, FullImage, DetailPanel)
    Frameworks/               # RawPipeline.xcframework (committed binary)
    Resources/                # Icon set, entitlements, TestFlight notes
    Tests/                    # MapleCoreTests
    scripts/                  # build-xcframework.sh
  raw-pipeline/               # Rust core (cargo workspace)
    raw-core/                 # Pure Rust image math (no platform deps)
    raw-ffi/                  # cbindgen C headers for Apple xcframework
    raw-wasm/                 # wasm-bindgen bindings for Web
    maple-cli/                # Deterministic headless CLI harness
  web/                        # Angular workspace (Maple Hosted UI; also consumed by Self Hosted)
    projects/
      maple/                  # The editor/browse application
      maple-common/           # Shared library (components, services, models, raw-wasm consumer)
    ngsw-config.json          # Service worker configuration
  api/                        # Bun + Elysia + MongoDB (Maple Self Hosted backend + Indexer)
    src/                      # Elysia routes, db, ffi, fs, indexer
    native/                   # libmaple_core dylib consumed via bun:ffi
  scripts/
    test_color_pipeline.sh    # Color parity harness
    compare_images.py         # ΔE₀₀ + per-channel bias metric
    codegen/                  # Rust → Swift/TS constant generator

docs/
  feature-spec.md             # What the product does
  ui-spec.md                  # How screens look/behave
  architecture.md             # System design
  best-practices.md           # Coding standards — read this
  mockup.html                 # Interactive layout reference
  pipeline.md, caching.md, testing.md, ...
```

## Read before editing

- **Changing a color pipeline stage?** Read `docs/architecture.md` § "Scene-linear chain" and `docs/testing.md` § "Parity gates." Every stage change runs the parity harness.
- **Adding an Angular component?** Read `docs/best-practices.md` § "Angular". TL;DR: standalone, signals, `input()`/`output()`, separate `.ts`/`.html`/`.scss` files, observables at the service layer, view models in components.
- **Navigating or changing routes?** Use Angular `routerLink` instead of standard `href` for all internal links. Do not use `replaceUrl: true` for page transitions (which skips browser history); only use it for guard redirects, close/dismiss actions, or reactive URL syncing (e.g. typing searches).
- **Adding a Swift view?** Read `docs/best-practices.md` § "Swift". TL;DR: `@Observable`, actor-isolated I/O, generation-counter guards for async state.
- **Touching the XMP schema?** Read `docs/sidecar-schema.md`. Schema changes are versioned; passthrough XML preserves unknown fields byte-for-byte.

## Build & test — Apple

The app is an Xcode project (`src/apple/Maple.xcodeproj`) that consumes a local Swift package at `src/apple/Packages/MapleCore/` plus the `Frameworks/RawPipeline.xcframework` binary built from the Rust core.

**First build after clone:** the `libraw_ffi.a` files inside the xcframework are gitignored (200–500 MB each, over GitHub's limit). Build them once before the first Xcode build:

```bash
./src/apple/scripts/build-xcframework.sh
```

The script defaults to a **release** build. Pass `--debug` only for fast-compile iteration when pano performance is irrelevant — a debug xcframework makes `maple_pano_stitch` run ~16× slower (measured: 5785s debug vs 353s release for the same 21-frame stitch on M4). CI (Xcode Cloud) always builds release.

This needs Rust + cbindgen + the iOS/macOS Rust targets (`rustup target add aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin x86_64-apple-darwin`). The script regenerates the Headers, the `module.modulemap`, and the per-platform static libs.

```bash
# macOS build
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build

# iOS simulator (pick any installed arm64 simulator; iPhone 17 Pro / iPhone 16 Pro work)
xcodebuild -project Maple.xcodeproj -scheme "Maple Exposure" \
           -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build

# Unit tests (runs inside the local package — Xcode test target is a stub)
cd Packages/MapleCore && swift test
```

The xcframework's iOS simulator slice is arm64 only today, so `-destination 'generic/platform=iOS Simulator'` fails on the x86_64 link step — pass a specific simulator destination instead.

When testing a UI change:

1. Build via `xcodebuild` or open `Maple.xcodeproj` in Xcode.
2. Launch the built `.app` (macOS) or install on the simulator (iOS).
3. Use accessibility tree inspection, not coordinate taps — every interactive element must have an accessibility label.
4. Screenshot before and after; `capture_logs` catches runtime errors.

If ΔE numbers don't move after a `raw-core` edit, the xcframework is stale. Rebuild it.

## Build & test — Web

```bash
# Dev server
cd src/web
bun x ng serve maple          # http://localhost:4200

# Rebuild WASM (after raw-core or raw-wasm changes)
cd src/raw-pipeline/raw-wasm
wasm-pack build --target web
# sync into maple-common (the consumer) — see src/web/scripts/sync-raw-wasm.sh

# Format + test (there is no web lint step — Prettier is the only style gate)
cd src/web
bun run format        # prettier --write over files this branch changes vs origin/main
bun run format:check  # mirrors CI's format gate (.github/workflows/cross.yml format-check)
bun run test
```

To load a RAW file in dev automation without the native picker, drop it into `projects/maple/public/test.dng` and feed it into the hidden `<input type="file">` via `DataTransfer`. Setting `input.files` programmatically does not fire `change` — the synthetic event is required.

**Canvas color-space (WebGL):** the drawing buffer is tagged as `colorSpace: 'srgb'` in `webgl-pipeline.ts`. Without this, wide-gamut browsers interpret the canvas output in display-P3 and warm tones shift pink on P3 Macs. Do not remove the tag.

## Build & test — API (Bun / Self Hosted)

```bash
cd src/api
bun install
bun test                      # unit + integration tests
bun run dev                   # Elysia on http://localhost:3000

# Native core as a bun:ffi dylib (rebuild after raw-core / raw-ffi changes)
./src/api/scripts/build-raw-ffi.sh
```

The API serves the pre-built `src/web` Angular bundle for a complete Self Hosted deploy. MongoDB is expected on `mongodb://localhost:27017` by default (override via `MONGO_URL`).

## Build & test — Rust core

```bash
cd src/raw-pipeline
cargo test -p raw-core --lib            # ~94 tests
cargo test -p raw-core --all-features   # includes fixture-gated tests

# Color pipeline harness (CI gate)
src/scripts/test_color_pipeline.sh                # default: mean ΔE ≤ 15
BUDGET=5 src/scripts/test_color_pipeline.sh       # tighten as pipeline improves

# CLI harness — deterministic, headless, matches WASM/Swift-FFI output
cd src/raw-pipeline
cargo run --release --bin maple-cli -- batch manifest.json --out-dir candidates/
```

Diagnostic examples:

```bash
# Per-stage RGB dump at one pixel through the full pipeline
cargo run --release -p raw-core --example stage-trace -- <DNG> <X> <Y>

# Raw-value statistics vs declared white_level
cargo run --release -p raw-core --example raw-stats -- <DNG>
```

Fixtures at `src/raw-pipeline/test-fixtures/raws/` are gitignored. Reference RAW is a 100MP Hasselblad L3D-100c (DJI Mavic 3 Pro) frame at `test-fixtures/raws/dji-mavic3pro-100mp.dng`.

## Objective color testing — no eyeballing

Every color-pipeline change must pass the perceptual harness. Screenshot comparisons are not acceptable evidence.

```bash
src/scripts/test_color_pipeline.sh              # CIEDE2000 gate
```

The harness extracts the DNG's embedded preview (via `exiftool -PreviewImageStart/Length` + `dd`), runs `maple-cli` to render the candidate, and diffs with `compare_images.py`. Reports mean ΔE₀₀, P95, max, and per-channel bias. A case passes only when all four are under budget.

Budgets ratchet **downward** over time. CI rejects any PR that raises a budget. Budgets move down only, by explicit commit.

## Cross-platform parity

Every constant that appears in Rust, Swift, and TypeScript is generated by a single Python script in `src/scripts/codegen/`. The script writes:

- Rust `pub const` arrays
- Swift `let` constants
- TypeScript `export const` constants

A golden-file CI test confirms all three outputs agree. When a matrix changes, regenerate all three — individual platform ports cannot drift.

## Performance invariants

- **Slider tick:** 16ms target, 50ms hard limit, on the reference scene set.
- **Cold image open (cached):** one frame (~35ms) from click to pixels.
- **Cold image open (uncached):** 250–1000ms. Show progress.
- **Two-phase rendering:** fast phase (viewport, screen-res, cancellable) → 150ms debounced refine phase (full image, full resolution).
- **Five caches:** thumbnail memory, thumbnail disk, rendered-preview (keyed on `(primary_url, primary_mtime, sidecar_mtime, screen_size, adjustment_version, view_transform_version)`), decoded-image (session-scoped, in-memory), remote-source-bytes (for network shares). On web: IndexedDB + in-memory equivalents. See `docs/caching.md`.

If a new feature adds allocation inside the render loop, it does not ship. If it adds a round-trip across the WASM boundary per slider tick, it does not ship. Budget first, optimize later only when profiling says so.

## Conventions

- **Don't keep template scaffold code around.** If an Xcode or Angular generator leaves a placeholder (`ContentView`, `AppComponent` hello-world), delete it when you replace it.
- **Prefer SPM modules** over a monolithic app target as soon as a feature has more than ~3 files. The pipeline, sidecar layer, and source adapters live in `src/apple/Sources/MapleCore`.
- **Prefer Angular library projects** in `projects/maple-common` for cross-cutting code (used by both Hosted and Self Hosted deployments of the same Angular shell).
- **No mocks for the sidecar layer in tests.** Round-trip against real `.xmp` files in a temp directory. XMP is the contract; mocks let bugs through.
- **Bundle ID:** `app.justmaple.aperture` (tests append `.Tests` / `.UITests`).

## Notes

- macOS builds use the `My Mac` destination, not a simulator UDID.
- System permission dialogs (camera, files, photos) can't be dismissed by automation. Handle them manually on first run.
- For menu-bar items and other system UI, fall back to `osascript`.
- The Xcode app target uses `GENERATE_INFOPLIST_FILE = YES`. To set Info.plist keys, add `INFOPLIST_KEY_*` build settings in `project.pbxproj` — do not create an `Info.plist` file.

## What lives where

| If you need to…                           | Read this                            |
| ----------------------------------------- | ------------------------------------ |
| Decide what a feature should do           | `docs/feature-spec.md`               |
| Decide how a screen should look or behave | `docs/ui-spec.md`                    |
| See the layout in motion                  | `docs/mockup.html` (open in browser) |
| Look up a color, font, or spacing token   | `docs/ui-spec.md` § "Visual design"  |
| Look up the sidecar XMP schema            | `docs/sidecar-schema.md`             |
| Pick a pattern for an Angular component   | `docs/best-practices.md` § "Angular" |
| Pick a pattern for a Swift view           | `docs/best-practices.md` § "Swift"   |
| Add a cache                               | `docs/caching.md`                    |
| Understand the render pipeline            | `docs/architecture.md` § "Pipeline"  |
| Add or change a parity gate               | `docs/testing.md`                    |
